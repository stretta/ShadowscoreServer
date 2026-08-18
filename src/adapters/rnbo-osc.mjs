import dgram from "node:dgram";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeOscMessage } from "./osc.mjs";
import { discoverRnboTargets } from "./rnbo-oscquery.mjs";
import { rnboPlaybackCapabilities } from "../playback/target-capabilities.mjs";
import { impactAffectsRnbo, impactVoicesForBlock, scoreMutationImpact } from "../playback/score-mutation-impact.mjs";
import { activeWrittenTempo } from "../playback/tempo.mjs";
import { quantizePitchToTtid } from "../harmonic/scale.mjs";

const OPCODES = Object.freeze({
  BEGIN_REPLACE: 1,
  NOTE: 20,
  COMMIT: 90,
  READY: 92,
  ACTIVE: 93
});

const TRANSACTION_FLAGS = Object.freeze({
  PREPARE_ONLY: 1
});

const TRANSACTION_REJECT_REASONS = Object.freeze({
  1: "stale-transaction",
  2: "note-count",
  3: "row-range",
  4: "protocol",
  5: "row-order",
  6: "checksum"
});

const ACTIVATION_REJECT_REASONS = Object.freeze({
  7: "activation-transaction",
  8: "activation-mode",
  9: "activation-boundary",
  10: "activation-combination"
});

const MAX_EXACT_RNBO_TRANSACTION_ID = 16_777_215;

export function createRnboOscAdapter(config, runtime = {}) {
  if (!config.rnbo.enabled) {
    return {
      enabled: false,
      attach() {},
      close() {}
    };
  }

  const socket = runtime.socket ?? dgram.createSocket("udp4");
  const transactionCounter = createScoreTransactionCounter(config, runtime);
  let store;
  let discoveryTimer;
  let lastTargetSignature = "";
  let lastTargetInventory = new Map();
  let candidateTargetSignature = "";
  let candidateTargetObservations = 0;
  let discoveryCheckPending = false;
  let discoveryStatus = {
    state: "unobserved",
    observedAt: null,
    acceptedAt: null,
    lastError: "",
    candidateObservations: 0,
    requiredObservations: targetDiscoveryStabilityCount(config),
    reconciledTargetIds: []
  };
  const lastSendStatus = new Map();
  let sendLoopActive = false;
  let sendLoopPromise = Promise.resolve();
  let queuedSend = undefined;
  let latestSendResult = undefined;
  let activeSend = undefined;
  let debounceTimer = undefined;
  const debounceWaiters = [];
  let activationOperationTail = Promise.resolve();
  const playbackLifecycleEvents = [];
  const transferEvents = new EventEmitter();
  const transferTargets = new Map();
  const transferHistory = [];
  const lastTransferProgressEmitMs = new Map();
  const mutationImpacts = [];
  const playbackUpdateState = new Map();
  const desiredHashCache = new Map();
  const dirtyVoicesByBlock = new Map();
  let invalidateAllPlayback = false;
  let lastObservedScore;
  const metrics = {
    mutationCount: 0,
    targetEnumerationCount: 0,
    compileCount: 0,
    transmissionCount: 0,
    reuseCount: 0
  };

  const adapter = {
    enabled: true,
    attach(nextStore) {
      store = nextStore;
      lastObservedScore = store.getScore();
      store.events.on("change", (event) => {
        const impact = scoreMutationImpact(event, lastObservedScore);
        lastObservedScore = event.score;
        recordMutationImpact(impact);
      });
      startTargetDiscoveryMonitor();
    },
    resendCurrentScore(reason = "manual", options = {}) {
      if (!store) {
        return Promise.reject(new Error("RNBO adapter is not attached to a score store"));
      }
      return resendScore(store.getScore(), reason, options);
    },
    async prepareBlock(blockId, reason = "lookahead", options = {}) {
      if (!store) {
        return Promise.reject(new Error("RNBO adapter is not attached to a score store"));
      }
      const score = scoreWithActiveBlock(store.getScore(), blockId);
      const updates = await adapter.playbackUpdates(blockId);
      const unreadyVoiceIds = options.requireReady === true
        ? Object.values(updates.targets)
            .filter((update) => !["prepared", "active"].includes(update.state))
            .map((update) => update.voiceId)
            .filter(Boolean)
        : [];
      const voiceIds = mergeOptionalSelection(
        options.voiceIds,
        [...dirtyVoiceSelection(score, blockId), ...unreadyVoiceIds]
      );
      return resendScore(score, `${reason}:${blockId}`, {
        ...options,
        immediate: true,
        stagedOnly: true,
        preparedBlockId: blockId,
        voiceIds
      });
    },
    mutationImpacts() {
      return structuredClone(mutationImpacts);
    },
    metrics() {
      return structuredClone(metrics);
    },
    async playbackUpdates(blockId = "", options = {}) {
      if (!store) throw new Error("RNBO adapter is not attached to a score store");
      const canonical = store.getScore();
      const selectedBlockId = String(blockId || canonical.structureState?.activeBlockId || "").trim();
      const score = selectedBlockId ? scoreWithActiveBlock(canonical, selectedBlockId) : canonical;
      const targets = await rnboTargetsForSend(config, score, runtime, {
        liveTargets: options.targets
      });
      metrics.targetEnumerationCount += targets.length;
      const updates = targets.map((target) => desiredUpdateForTarget(score, selectedBlockId, target));
      const affected = updates.filter((update) => update.state !== "active");
      return {
        blockId: selectedBlockId,
        scoreRevision: canonical.scoreRevision ?? canonical.version ?? 0,
        state: aggregateUpdateState(updates),
        affectedTargetCount: affected.length,
        preparedTargetCount: updates.filter((update) => update.state === "prepared").length,
        activeTargetCount: updates.filter((update) => update.state === "active").length,
        invalidateAll: invalidateAllPlayback,
        targets: Object.fromEntries(updates.map((update) => [update.targetId, update])),
        latestImpact: mutationImpacts.at(-1) ?? null,
        metrics: structuredClone(metrics)
      };
    },
    applyBlockUpdate(blockId = "", options = {}) {
      return enqueueActivationOperation(() => runBlockUpdate(blockId, options));
    },
    sendStatus() {
      return [...lastSendStatus.values()];
    },
    sendQueueStatus() {
      return {
        inProgress: Boolean(activeSend),
        queued: Boolean(queuedSend),
        active: activeSend ? structuredClone(activeSend) : null,
        queuedRequest: queuedSend ? summarizeSendRequest(queuedSend) : null,
        discovery: structuredClone(discoveryStatus)
      };
    },
    reconcileTargetDiscovery() {
      return checkTargetDiscovery();
    },
    async waitForIdle() {
      while (debounceTimer || sendLoopActive || queuedSend) {
        if (debounceTimer) {
          await delay(Math.max(5, resendDebounceMs(config) + 1));
        }
        await sendLoopPromise;
      }
      return adapter.sendQueueStatus();
    },
    lifecycleEvents() {
      return structuredClone(playbackLifecycleEvents);
    },
    transferEvents,
    transferStatus() {
      return transferStatusSnapshot();
    },
    schedulePreparedActivations(options = {}) {
      const targetId = String(options.targetId ?? "").trim();
      const initialStage = clampInt(options.initialStage ?? 0, 0, 2147483647);
      const requests = [...lastSendStatus.values()]
        .filter((status) => status.stagedScoreActivation === true)
        .filter((status) => Number.isInteger(status.preparedTransaction))
        .filter((status) => !targetId || status.targetId === targetId)
        .map((status) => ({
          targetId: status.targetId,
          transactionId: status.preparedTransaction,
          expectedClientId: status.ack?.expectedClientId,
          url: status.ack?.url ?? "",
          initialStage
        }));
      const observedAt = new Date().toISOString();
      for (const request of requests) {
        recordLifecycleEvent({
          type: "activation_scheduled",
          observedAt,
          ...request
        });
      }
      return structuredClone(requests);
    },
    async confirmPreparedActivations(requests = [], options = {}) {
      const activation = rnboActivationConfig(config, options.tempo);
      const fetchImpl = options.fetchImpl ?? runtime.fetchImpl ?? globalThis.fetch;
      return Promise.all(requests.map(async (request) => {
        const startedAt = Date.now();
        let acknowledgement = badAck("activation-missed", {
          url: request.url,
          expectedTransactionId: request.transactionId
        });
        while (Date.now() - startedAt <= activation.timeoutMs) {
          acknowledgement = await readScoreActivationAck(request, {
            fetchImpl,
            timeoutMs: activation.requestTimeoutMs
          });
          if (acknowledgement.ok) break;
          await delay(activation.pollIntervalMs);
        }
        const completedAt = new Date().toISOString();
        const previous = lastSendStatus.get(request.targetId);
        if (acknowledgement.ok && previous?.preparedTransaction === request.transactionId) {
          lastSendStatus.set(request.targetId, {
            ...previous,
            activeTransaction: request.transactionId,
            preparedTransaction: null,
            activationAcknowledgementAt: completedAt,
            activationAck: acknowledgement
          });
          promotePlaybackUpdate(request.targetId, request.transactionId, acknowledgement);
          recordLifecycleEvent({
            type: "activation_completed",
            observedAt: completedAt,
            targetId: request.targetId,
            transactionId: request.transactionId,
            activationDurationMs: Math.max(0, Date.now() - startedAt),
            acknowledgement
          });
        } else {
          if (previous) {
            lastSendStatus.set(request.targetId, {
              ...previous,
              activationAcknowledgementAt: completedAt,
              activationAck: acknowledgement
            });
          }
          recordLifecycleEvent({
            type: "activation_missed",
            observedAt: completedAt,
            targetId: request.targetId,
            transactionId: request.transactionId,
            activationDurationMs: Math.max(0, Date.now() - startedAt),
            acknowledgement
          });
        }
        return {
          targetId: request.targetId,
          transactionId: request.transactionId,
          acknowledgement
        };
      }));
    },
    close() {
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = undefined;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        rejectDebounceWaiters(new Error("RNBO adapter closed before debounced resend"));
      }
      try {
        socket.close();
      } catch {
        // Closing an idle dgram socket can throw on some Node versions.
      }
    }
  };
  return adapter;

  async function runBlockUpdate(blockId = "", options = {}) {
    let result;
    let updateError;
    try {
      if (!store) throw new Error("RNBO adapter is not attached to a score store");
      const canonical = store.getScore();
      const selectedBlockId = String(blockId || canonical.structureState?.activeBlockId || "").trim();
      const scoreRevision = canonical.scoreRevision ?? canonical.version ?? 0;
      if (options.expectedScoreRevision !== undefined && Number(options.expectedScoreRevision) !== Number(scoreRevision)) {
        const error = new Error(`stale score revision ${options.expectedScoreRevision}; current score revision is ${scoreRevision}`);
        error.code = "STALE_SCORE_REVISION";
        error.currentScoreRevision = scoreRevision;
        throw error;
      }
      const activationMode = options.activationMode === "now" ? "now" : "continue";
      let updates = options.reusePrepared === true
        ? await adapter.playbackUpdates(selectedBlockId)
        : null;
      const reusable = updates && Object.values(updates.targets).every((update) => ["prepared", "active"].includes(update.state));
      if (!reusable) {
        await adapter.prepareBlock(selectedBlockId, activationMode === "now" ? "update-now" : "apply-next-beat", {
          fetchImpl: options.fetchImpl ?? runtime.fetchImpl,
          requireReady: true
        });
        await adapter.waitForIdle();
        updates = await adapter.playbackUpdates(selectedBlockId);
      }
      const pending = Object.values(updates.targets).filter((update) => update.state !== "active");
      if (!pending.length) {
        result = { ...updates, activationMode, action: "already-active", activations: [] };
      } else {
        await options.authorizeActivation?.({
          blockId: selectedBlockId,
          scoreRevision,
          activationMode
        });

        const score = scoreWithActiveBlock(canonical, selectedBlockId);
        const targets = await rnboTargetsForSend(config, score, runtime, {
          targetIds: pending.map((update) => update.targetId),
          stagedOnly: true
        });
        const targetById = new Map(targets.map((target) => [target.id ?? target.address ?? "", target]));
        const requests = pending.map((update) => {
          const target = targetById.get(update.targetId);
          const status = lastSendStatus.get(update.targetId);
          if (!target || target.capabilities?.continuingScoreActivation !== true) {
            const error = new Error(`RNBO target '${update.targetId}' does not support continuing score activation`);
            error.code = "CONTINUING_ACTIVATION_UNSUPPORTED";
            throw error;
          }
          const matchingPreparation =
            Number.isInteger(status?.preparedTransaction) &&
            status.preparedTransaction === update.preparedTransaction &&
            status.blockId === selectedBlockId &&
            status.payloadHash === update.desiredHash &&
            status.ack?.ok === true;
          if (!matchingPreparation) {
            const error = new Error(`RNBO target '${update.targetId}' is not READY for score revision ${scoreRevision} (ack=${status?.ack?.status ?? "missing"}, preparedTransaction=${status?.preparedTransaction ?? "none"}${status?.ack?.error ? `, error=${status.ack.error}` : ""})`);
            error.code = "PLAYBACK_UPDATE_NOT_READY";
            throw error;
          }
          return {
            target,
            targetId: update.targetId,
            transactionId: status.preparedTransaction,
            expectedClientId: status.ack?.expectedClientId,
            url: status.ack?.url ?? "",
            initialStage: activationMode === "now" ? 0 : null,
            activationMode,
            boundary: activationMode === "now" ? "now" : "next-beat"
          };
        });

        const runtimeTempo = Number(runtime.getTempo?.());
        const activationOptions = {
          tempo: Number.isFinite(runtimeTempo) && runtimeTempo > 0 ? runtimeTempo : activeWrittenTempo(canonical),
          fetchImpl: options.fetchImpl
        };
        const previouslyArmed = requests.filter((request) => {
          const status = lastSendStatus.get(request.targetId);
          return status?.activationAcknowledgementAt != null || status?.activationAck != null;
        });
        const preflight = previouslyArmed.length
          ? await adapter.confirmPreparedActivations(previouslyArmed, activationOptions)
          : [];
        const reconciledTargetIds = new Set(
          preflight
            .filter((activation) => activation.acknowledgement?.ok === true)
            .map((activation) => activation.targetId)
        );
        const requestsToArm = requests.filter((request) => !reconciledTargetIds.has(request.targetId));
        const armedAt = new Date().toISOString();
        await Promise.all(requestsToArm.map(async (request) => {
          await sendPreparedActivationRequest(socket, request.target, request);
          recordLifecycleEvent({
            type: "playback.update.armed",
            observedAt: armedAt,
            targetId: request.targetId,
            transactionId: request.transactionId,
            activationMode: request.activationMode,
            boundary: request.boundary
          });
        }));
        if (requestsToArm.length) {
          await options.onArmed?.({
            blockId: selectedBlockId,
            scoreRevision,
            activationMode,
            requests: structuredClone(requestsToArm)
          });
        }
        const confirmed = requestsToArm.length
          ? await adapter.confirmPreparedActivations(requestsToArm, activationOptions)
          : [];
        const activations = [
          ...preflight.filter((activation) => activation.acknowledgement?.ok === true),
          ...confirmed
        ];
        const finalUpdates = await adapter.playbackUpdates(selectedBlockId);
        result = {
          ...finalUpdates,
          activationMode,
          action: finalUpdates.state === "active" ? "active" : "activation-failed",
          activations
        };
      }
    } catch (error) {
      updateError = error;
    }

    const restoreBlockId = String(options.restoreBlockId ?? "").trim();
    let restoredPreparation = null;
    if (restoreBlockId && restoreBlockId !== String(blockId ?? "").trim()) {
      try {
        await adapter.prepareBlock(restoreBlockId, "restore-after-apply", {
          fetchImpl: options.fetchImpl ?? runtime.fetchImpl,
          requireReady: true
        });
        await adapter.waitForIdle();
        restoredPreparation = { ok: true, blockId: restoreBlockId };
      } catch (error) {
        restoredPreparation = { ok: false, blockId: restoreBlockId, error: messageForError(error) };
        if (!updateError) updateError = error;
      }
    }
    if (updateError) {
      updateError.restoredPreparation = restoredPreparation;
      throw updateError;
    }
    return { ...result, restoredPreparation };
  }

  function enqueueActivationOperation(operation) {
    const previous = activationOperationTail.catch(() => undefined);
    let release;
    activationOperationTail = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }

  function nextTransactionId() {
    return transactionCounter.next();
  }

  function resendScore(score, reason = "", options = {}) {
    const request = { score, reason, options };
    if (shouldDebounceResend(config, reason, options)) {
      return scheduleDebouncedSend(request);
    }
    queuedSend = mergeSendRequest(queuedSend, request);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      startSendLoop();
      settleDebounceWaiters(sendLoopPromise);
      return sendLoopPromise;
    }
    return startSendLoop();
  }

  function startSendLoop() {
    if (!sendLoopActive) {
      sendLoopActive = true;
      sendLoopPromise = drainSendQueue();
    }
    return sendLoopPromise;
  }

  function scheduleDebouncedSend(request) {
    queuedSend = mergeSendRequest(queuedSend, request);
    if (sendLoopActive) {
      return sendLoopPromise;
    }

    const waitForSend = new Promise((resolve, reject) => {
      debounceWaiters.push({ resolve, reject });
    });
    const debounceMs = resendDebounceMs(config);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      startSendLoop();
      settleDebounceWaiters(sendLoopPromise);
    }, debounceMs);
    debounceTimer.unref?.();
    return waitForSend;
  }

  function settleDebounceWaiters(promise) {
    const waiters = debounceWaiters.splice(0);
    for (const waiter of waiters) {
      promise.then(waiter.resolve, waiter.reject);
    }
  }

  function rejectDebounceWaiters(error) {
    const waiters = debounceWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  async function drainSendQueue() {
    try {
      while (queuedSend) {
        const request = queuedSend;
        queuedSend = undefined;
        const transactionId = nextTransactionId();
        activeSend = {
          ...summarizeSendRequest(request),
          startedAt: new Date().toISOString(),
          transactionId
        };
        try {
          const result = await sendScoreTransaction(socket, config, request.score, transactionId, {
            runtime,
            scoreRevision: request.score?.scoreRevision ?? request.score?.version ?? 0,
            reuseCompiledTarget: payloadReuseAllowed(request)
              ? reusableStagedTargetStatus
              : undefined,
            ...request.options,
            onLifecycleEvent(event) {
              recordLifecycleEvent(event);
              request.options?.onLifecycleEvent?.(event);
            },
            onTransferProgress(event) {
              recordTransferProgress(event);
              request.options?.onTransferProgress?.(event);
            }
          });
          latestSendResult = result;
          recordSendStatus(result);
          transferEvents.emit("snapshot", transferStatusSnapshot());
          if (request.reasons.length && config.rnbo.log !== false) {
            console.log(`[rnbo] resend reason=${request.reasons.join("+")}`);
          }
        } finally {
          activeSend = undefined;
        }
      }
      return latestSendResult;
    } finally {
      sendLoopActive = false;
      if (queuedSend) {
        sendLoopActive = true;
        sendLoopPromise = drainSendQueue();
      }
    }
  }

  function mergeSendRequest(previous, next) {
    const reasons = [
      ...(previous?.reasons ?? []),
      ...(next.reason ? [next.reason] : [])
    ];
    return {
      score: next.score,
      reasons: [...new Set(reasons)],
      options: {
        ...(previous?.options ?? {}),
        ...next.options,
        stagedOnly: previous
          ? previous.options?.stagedOnly === true && next.options?.stagedOnly === true
          : next.options?.stagedOnly === true,
        forceFullClearRows: previous?.options?.forceFullClearRows === true || next.options?.forceFullClearRows === true,
        voiceIds: mergeOptionalSelection(previous?.options?.voiceIds, next.options?.voiceIds),
        targetIds: mergeOptionalSelection(previous?.options?.targetIds, next.options?.targetIds)
      }
    };
  }

  function summarizeSendRequest(request) {
    return {
      scoreVersion: request.score?.version ?? 0,
      scoreRevision: request.score?.scoreRevision ?? request.score?.version ?? 0,
      structureRevision: request.score?.structureRevision ?? 0,
      reasons: [...(request.reasons ?? [])],
      forceFullClearRows: request.options?.forceFullClearRows === true,
      stagedOnly: request.options?.stagedOnly === true,
      preparedBlockId: request.options?.preparedBlockId ?? "",
      voiceIds: request.options?.voiceIds ?? null,
      targetIds: request.options?.targetIds ?? null
    };
  }

  function recordSendStatus(result) {
    const entries = Array.isArray(result?.targets)
      ? result.targets
      : [{ target: undefined, compiled: result }];
    metrics.targetEnumerationCount += entries.length;
    metrics.compileCount += entries.length;
    const currentTargetIds = new Set(entries.map(({ target, compiled }) => (
      target?.id ?? target?.address ?? compiled?.targetId ?? ""
    )).filter(Boolean));
    if (result?.partial !== true) {
      for (const targetId of lastSendStatus.keys()) {
        if (!currentTargetIds.has(targetId)) {
          lastSendStatus.delete(targetId);
        }
      }
    }
    for (const { target, compiled } of entries) {
      const targetId = target?.id ?? target?.address ?? compiled?.targetId ?? "";
      if (!targetId) {
        continue;
      }
      if (compiled?.reused === true && lastSendStatus.has(targetId)) {
        metrics.reuseCount += 1;
        lastSendStatus.set(targetId, {
          ...lastSendStatus.get(targetId),
          at: new Date().toISOString(),
          reusedAt: compiled.reusedAt ?? new Date().toISOString(),
          reuseReason: compiled.reuseReason ?? "identical-staged-payload"
        });
        recordPlaybackUpdate(target, compiled, lastSendStatus.get(targetId));
        continue;
      }
      metrics.transmissionCount += 1;
      lastSendStatus.set(targetId, {
        targetId,
        voiceId: target?.voiceId ?? "",
        at: new Date().toISOString(),
        transactionId: compiled?.transactionId ?? compiled?.ack?.transactionId ?? null,
        scoreRevision: compiled?.scoreRevision ?? null,
        payloadRevision: compiled?.payloadRevision ?? null,
        payloadHash: compiled?.payloadHash ?? null,
        blockId: compiled?.blockId ?? compiled?.timing?.blockId ?? "",
        noteCount: compiled?.noteCount ?? 0,
        transmittedRowCount: compiled?.transmittedRowCount ?? 0,
        replacementMode: compiled?.replacementMode ?? "legacy-full-clear",
        compactScoreReplace: compiled?.compactScoreReplace === true,
        stagedScoreActivation: compiled?.stagedScoreActivation === true,
        resumableScoreReplace: compiled?.resumableScoreReplace === true,
        continuingScoreActivation: compiled?.continuingScoreActivation === true,
        forceFullClearRows: compiled?.forceFullClearRows === true,
        patternLength: compiled?.patternLength ?? 0,
        stagesPerBeat: compiled?.stagesPerBeat ?? compiled?.timing?.stagesPerBeat ?? 0,
        sendStartedAt: compiled?.sendStartedAt ?? null,
        sendCompletedAt: compiled?.sendCompletedAt ?? null,
        acknowledgementAt: compiled?.acknowledgementAt ?? null,
        preparationDurationMs: compiled?.preparationDurationMs ?? null,
        resumedRowCount: compiled?.resumedRowCount ?? 0,
        activeTransaction: compiled?.stagedScoreActivation === true
          ? lastSendStatus.get(targetId)?.activeTransaction ?? null
          : compiled?.transactionId ?? compiled?.ack?.transactionId ?? null,
        preparedTransaction: compiled?.stagedScoreActivation === true && compiled?.ack?.status === "prepared"
          ? compiled?.transactionId ?? compiled?.ack?.transactionId ?? null
          : null,
        activationAcknowledgementAt: null,
        activationAck: null,
        ack: compiled?.ack
      });
      recordPlaybackUpdate(target, compiled, lastSendStatus.get(targetId));
    }
    clearPreparedDirtySelection(entries);
  }

  function reusableStagedTargetStatus(target, compiled) {
    if (compiled?.stagedScoreActivation !== true) return null;
    const targetId = target?.id ?? target?.address ?? compiled?.targetId ?? "";
    const previous = lastSendStatus.get(targetId);
    if (!previous || previous.payloadHash !== compiled.payloadHash || previous.blockId !== compiled.timing?.blockId) {
      return null;
    }
    if (!Number.isInteger(previous.activeTransaction) && !Number.isInteger(previous.preparedTransaction)) {
      return null;
    }
    return previous;
  }

  function recordLifecycleEvent(event) {
    playbackLifecycleEvents.push(event);
    if (playbackLifecycleEvents.length > 200) playbackLifecycleEvents.splice(0, playbackLifecycleEvents.length - 200);
    updateTransferFromLifecycle(event);
    if (config.rnbo.log !== false) console.log(`[rnbo-playback] ${JSON.stringify(event)}`);
  }

  function recordTransferProgress(event) {
    const previous = transferTargets.get(event.targetId) ?? {};
    const now = Date.now();
    const lastEmit = lastTransferProgressEmitMs.get(event.targetId) ?? 0;
    const emit = event.state === "awaiting-ack" || now - lastEmit >= 100;
    if (emit) lastTransferProgressEmitMs.set(event.targetId, now);
    updateTransferTarget(event.targetId, {
      ...previous,
      ...transferIdentity(event),
      state: event.state ?? "sending",
      attempt: Number(event.deliveryProfile?.attempt ?? 0) + 1,
      strategy: event.delivery?.strategy ?? previous.strategy ?? "full-transaction",
      expectedRows: event.transmittedRowCount ?? previous.expectedRows ?? 0,
      sentRows: event.sentRowCount ?? previous.sentRows ?? 0,
      confirmedRows: Math.max(previous.confirmedRows ?? 0, event.delivery?.resumeFromRow ?? 0),
      updatedAt: event.observedAt ?? new Date().toISOString()
    }, emit);
  }

  function updateTransferFromLifecycle(event) {
    const targetId = String(event?.targetId ?? "").trim();
    if (!targetId) return;
    const previous = transferTargets.get(targetId) ?? {};
    const base = {
      ...previous,
      ...transferIdentity(event),
      expectedRows: event.transmittedRowCount ?? previous.expectedRows ?? 0,
      updatedAt: event.observedAt ?? new Date().toISOString()
    };
    if (event.type === "prepare_started") {
      updateTransferTarget(targetId, {
        ...base,
        state: "sending",
        startedAt: event.observedAt,
        completedAt: null,
        attempt: Number(event.deliveryProfile?.attempt ?? 0) + 1,
        strategy: event.delivery?.strategy ?? "full-transaction",
        sentRows: event.delivery?.resumeFromRow ?? 0,
        confirmedRows: event.delivery?.resumeFromRow ?? 0,
        acknowledgement: null,
        error: ""
      });
      return;
    }
    if (event.type === "prepare_retry") {
      const confirmedRows = Number(event.acknowledgement?.receivedNoteCount);
      updateTransferTarget(targetId, {
        ...base,
        state: "retrying",
        attempt: Number(event.deliveryProfile?.attempt ?? 0) + 2,
        strategy: event.nextDelivery?.strategy ?? event.delivery?.strategy ?? base.strategy,
        confirmedRows: Number.isInteger(confirmedRows) ? confirmedRows : base.confirmedRows ?? 0,
        acknowledgement: event.acknowledgement ?? null,
        error: event.acknowledgement?.rejectReasonLabel ?? event.acknowledgement?.status ?? ""
      });
      return;
    }
    if (event.type === "prepare_completed") {
      const ready = event.acknowledgement?.status === "prepared";
      const record = {
        ...base,
        state: ready ? "ready" : "live",
        sentRows: base.expectedRows,
        confirmedRows: base.expectedRows,
        completedAt: event.observedAt,
        acknowledgement: event.acknowledgement ?? null,
        durationMs: event.preparationDurationMs ?? null,
        error: ""
      };
      rememberTransfer(record);
      updateTransferTarget(targetId, record);
      return;
    }
    if (event.type === "prepare_failed") {
      const confirmedRows = Number(event.acknowledgement?.receivedNoteCount);
      const record = {
        ...base,
        state: "failed",
        confirmedRows: Number.isInteger(confirmedRows) ? confirmedRows : base.confirmedRows ?? 0,
        completedAt: event.observedAt,
        acknowledgement: event.acknowledgement ?? null,
        durationMs: event.preparationDurationMs ?? null,
        error: event.acknowledgement?.rejectReasonLabel ?? event.acknowledgement?.status ?? "rejected"
      };
      rememberTransfer(record);
      updateTransferTarget(targetId, record);
      return;
    }
    if (event.type === "prepare_reused") {
      updateTransferTarget(targetId, {
        ...base,
        state: Number.isInteger(event.preparedTransaction) ? "ready" : "live",
        sentRows: base.expectedRows,
        confirmedRows: base.expectedRows,
        completedAt: event.observedAt,
        reused: true,
        error: ""
      });
      return;
    }
    if (["activation_scheduled", "playback.update.armed"].includes(event.type)) {
      updateTransferTarget(targetId, { ...base, state: "applying" });
      return;
    }
    if (event.type === "activation_completed") {
      updateTransferTarget(targetId, {
        ...base,
        state: "live",
        liveTransaction: event.transactionId,
        preparedTransaction: null,
        activationAcknowledgement: event.acknowledgement ?? null,
        error: ""
      });
      return;
    }
    if (event.type === "activation_missed") {
      updateTransferTarget(targetId, {
        ...base,
        state: "activation-failed",
        activationAcknowledgement: event.acknowledgement ?? null,
        error: event.acknowledgement?.status ?? "activation missed"
      });
    }
  }

  function transferIdentity(event = {}) {
    return {
      targetId: String(event.targetId ?? ""),
      voiceId: String(event.voiceId ?? ""),
      transactionId: event.transactionId ?? null,
      blockId: String(event.blockId ?? ""),
      payloadRevision: event.payloadRevision ?? null
    };
  }

  function updateTransferTarget(targetId, record, emit = true) {
    transferTargets.set(targetId, record);
    if (emit) transferEvents.emit("snapshot", transferStatusSnapshot());
  }

  function rememberTransfer(record) {
    const key = `${record.targetId}:${record.transactionId}`;
    const existing = transferHistory.findIndex((entry) => `${entry.targetId}:${entry.transactionId}` === key);
    if (existing >= 0) transferHistory.splice(existing, 1);
    transferHistory.push(structuredClone(record));
    if (transferHistory.length > 20) transferHistory.splice(0, transferHistory.length - 20);
  }

  function transferStatusSnapshot() {
    const targets = Object.fromEntries([...transferTargets].map(([targetId, record]) => {
      const sendStatus = lastSendStatus.get(targetId);
      return [targetId, {
        ...record,
        liveTransaction: sendStatus?.activeTransaction ?? record.liveTransaction ?? null,
        preparedTransaction: sendStatus?.preparedTransaction ?? record.preparedTransaction ?? null
      }];
    }));
    const records = Object.values(targets);
    const activeStates = new Set(["sending", "awaiting-ack", "retrying", "applying"]);
    return {
      observedAt: new Date().toISOString(),
      summary: {
        targetCount: records.length,
        inProgressCount: records.filter((record) => activeStates.has(record.state)).length,
        readyCount: records.filter((record) => record.state === "ready").length,
        liveCount: records.filter((record) => record.state === "live").length,
        failedCount: records.filter((record) => ["failed", "activation-failed"].includes(record.state)).length
      },
      targets,
      history: structuredClone(transferHistory)
    };
  }

  function recordMutationImpact(impact) {
    metrics.mutationCount += 1;
    mutationImpacts.push(impact);
    if (mutationImpacts.length > 100) mutationImpacts.splice(0, mutationImpacts.length - 100);
    if (impact.invalidateAll) invalidateAllPlayback = true;
    if (impactAffectsRnbo(impact)) {
      for (const blockId of impact.blockIds) {
        const dirty = dirtyVoicesByBlock.get(blockId) ?? new Set();
        for (const voiceId of impactVoicesForBlock(impact, blockId)) dirty.add(voiceId);
        dirtyVoicesByBlock.set(blockId, dirty);
      }
      for (const state of playbackUpdateState.values()) {
        if (!impact.invalidateAll && !(impact.blockIds ?? []).includes(state.blockId)) continue;
        const affectedVoices = impactVoicesForBlock(impact, state.blockId);
        if (!impact.invalidateAll && !affectedVoices.includes(state.voiceId)) continue;
        state.desiredScoreRevision = impact.scoreRevision;
        state.desiredHash = null;
        state.state = "saved-not-active";
        state.lastImpact = structuredClone(impact);
      }
      for (const [key, cached] of desiredHashCache.entries()) {
        if (!impact.invalidateAll && !(impact.blockIds ?? []).includes(cached.blockId)) continue;
        const affectedVoices = impactVoicesForBlock(impact, cached.blockId);
        if (!impact.invalidateAll && !affectedVoices.includes(cached.voiceId)) continue;
        desiredHashCache.delete(key);
      }
      recordLifecycleEvent({
        type: "playback.update.desired",
        observedAt: new Date().toISOString(),
        scoreRevision: impact.scoreRevision,
        blockIds: impact.blockIds,
        voiceIdsByBlock: impact.voiceIdsByBlock,
        invalidateAll: impact.invalidateAll
      });
    }
  }

  function dirtyVoiceSelection(score, blockId) {
    const assigned = Object.keys(score.mesostructure?.[blockId]?.players ?? {});
    if (invalidateAllPlayback) return assigned;
    const dirty = dirtyVoicesByBlock.get(blockId);
    const missing = assigned.filter((voiceId) => ![...playbackUpdateState.values()].some((state) => state.blockId === blockId && state.voiceId === voiceId));
    if (!dirty) return missing;
    return [...new Set([...dirty, ...missing])];
  }

  function desiredUpdateForTarget(score, blockId, target) {
    const targetId = target.id ?? target.address ?? "";
    const key = playbackUpdateKey(blockId, targetId);
    const previous = playbackUpdateState.get(key) ?? {};
    let desiredHash = previous.desiredHash ?? desiredHashCache.get(key)?.hash ?? null;
    if (!desiredHash) {
      metrics.compileCount += 1;
      desiredHash = compileScoreTransaction(score, config, 0, target).payloadHash;
      desiredHashCache.set(key, {
        blockId,
        voiceId: target.voiceId ?? "",
        hash: desiredHash
      });
    }
    const active = previous.activeHash === desiredHash && Number.isInteger(previous.activeTransaction);
    const prepared = !active && previous.preparedHash === desiredHash && Number.isInteger(previous.preparedTransaction);
    return {
      targetId,
      voiceId: target.voiceId ?? "",
      blockId,
      desiredScoreRevision: score.scoreRevision ?? score.version ?? 0,
      desiredHash,
      preparedTransaction: previous.preparedTransaction ?? null,
      preparedHash: previous.preparedHash ?? null,
      activeTransaction: previous.activeTransaction ?? null,
      activeHash: previous.activeHash ?? null,
      state: active ? "active" : prepared ? "prepared" : "saved-not-active",
      lastError: previous.lastError ?? null
    };
  }

  function recordPlaybackUpdate(target, compiled, status) {
    const blockId = compiled?.blockId ?? compiled?.timing?.blockId ?? "";
    const targetId = target?.id ?? target?.address ?? compiled?.targetId ?? "";
    if (!blockId || !targetId) return;
    const key = playbackUpdateKey(blockId, targetId);
    const previous = playbackUpdateState.get(key) ?? {};
    const prepared = compiled?.stagedScoreActivation === true && compiled?.ack?.status === "prepared";
    const active = compiled?.stagedScoreActivation !== true && compiled?.ack?.ok === true;
    if (prepared) {
      for (const [otherKey, otherState] of playbackUpdateState.entries()) {
        if (otherKey === key || otherState.targetId !== targetId || !Number.isInteger(otherState.preparedTransaction)) continue;
        playbackUpdateState.set(otherKey, {
          ...otherState,
          preparedTransaction: null,
          preparedHash: null,
          state: Number.isInteger(otherState.activeTransaction) ? "active" : "saved-not-active",
          updatedAt: new Date().toISOString()
        });
      }
    }
    playbackUpdateState.set(key, {
      ...previous,
      blockId,
      targetId,
      voiceId: target?.voiceId ?? compiled?.voiceId ?? "",
      desiredScoreRevision: compiled?.scoreRevision ?? previous.desiredScoreRevision ?? null,
      desiredHash: compiled?.payloadHash ?? previous.desiredHash ?? null,
      preparedTransaction: prepared ? status?.preparedTransaction ?? compiled?.transactionId ?? null : previous.preparedTransaction ?? null,
      preparedHash: prepared ? compiled?.payloadHash ?? null : previous.preparedHash ?? null,
      activeTransaction: active ? status?.activeTransaction ?? compiled?.transactionId ?? null : previous.activeTransaction ?? null,
      activeHash: active ? compiled?.payloadHash ?? null : previous.activeHash ?? null,
      state: active ? "active" : prepared ? "prepared" : compiled?.ack?.ok === false ? "failed" : previous.state ?? "saved-not-active",
      lastError: compiled?.ack?.ok === false ? compiled.ack : null,
      updatedAt: new Date().toISOString()
    });
  }

  function promotePlaybackUpdate(targetId, transactionId, acknowledgement) {
    for (const [key, state] of playbackUpdateState.entries()) {
      if (state.targetId !== targetId) continue;
      const promoted = state.preparedTransaction === transactionId;
      playbackUpdateState.set(key, promoted
        ? {
            ...state,
            activeTransaction: transactionId,
            activeHash: state.preparedHash,
            preparedTransaction: null,
            preparedHash: null,
            state: "active",
            lastError: null,
            activationAcknowledgement: acknowledgement,
            updatedAt: new Date().toISOString()
          }
        : {
            ...state,
            activeTransaction: null,
            activeHash: null,
            preparedTransaction: null,
            preparedHash: null,
            state: "saved-not-active",
            updatedAt: new Date().toISOString()
          });
    }
  }

  function clearPreparedDirtySelection(entries) {
    for (const { target, compiled } of entries) {
      if (compiled?.ack?.ok !== true) continue;
      const blockId = compiled?.blockId ?? compiled?.timing?.blockId ?? "";
      const voiceId = target?.voiceId ?? compiled?.voiceId ?? "";
      dirtyVoicesByBlock.get(blockId)?.delete(voiceId);
      if (dirtyVoicesByBlock.get(blockId)?.size === 0) dirtyVoicesByBlock.delete(blockId);
    }
    if (dirtyVoicesByBlock.size === 0) invalidateAllPlayback = false;
  }

  function startTargetDiscoveryMonitor() {
    const intervalMs = Number(config.rnbo.discoveryResendIntervalMs ?? 5000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || discoveryTimer) {
      return;
    }
    void checkTargetDiscovery();
    discoveryTimer = setInterval(() => {
      void checkTargetDiscovery();
    }, intervalMs);
    discoveryTimer.unref?.();
  }

  async function checkTargetDiscovery() {
    if (!store || discoveryCheckPending) {
      return structuredClone(discoveryStatus);
    }
    discoveryCheckPending = true;
    try {
      const liveTargets = await readLiveRnboTargets(config, runtime, { requireComplete: true });
      runtime.rnboStageCollector?.updateTargets?.(liveTargets);
      const signature = rnboTargetSignature(liveTargets);
      const observedAt = new Date().toISOString();
      if (signature !== candidateTargetSignature) {
        candidateTargetSignature = signature;
        candidateTargetObservations = 1;
      } else {
        candidateTargetObservations += 1;
      }
      discoveryStatus = {
        ...discoveryStatus,
        state: signature === lastTargetSignature ? "stable" : "observing",
        observedAt,
        lastError: "",
        candidateObservations: candidateTargetObservations,
        reconciledTargetIds: []
      };
      if (candidateTargetObservations < discoveryStatus.requiredObservations || signature === lastTargetSignature) {
        return structuredClone(discoveryStatus);
      }

      const nextInventory = targetInventory(liveTargets);
      const targetIds = targetsNeedingDiscoveryReconciliation(lastTargetInventory, nextInventory);
      lastTargetSignature = signature;
      lastTargetInventory = nextInventory;
      discoveryStatus = {
        ...discoveryStatus,
        state: "stable",
        acceptedAt: observedAt,
        reconciledTargetIds: targetIds
      };
      if (targetIds.length > 0) {
        await resendScore(store.getScore(), "target-discovery", {
          immediate: true,
          forceResend: true,
          targetIds
        });
      }
      return structuredClone(discoveryStatus);
    } catch (error) {
      candidateTargetSignature = "";
      candidateTargetObservations = 0;
      discoveryStatus = {
        ...discoveryStatus,
        state: "unknown",
        observedAt: new Date().toISOString(),
        lastError: messageForError(error),
        candidateObservations: 0,
        reconciledTargetIds: []
      };
      if (config.rnbo.log !== false) {
        console.error(`[rnbo] target discovery resend check failed: ${messageForError(error)}`);
      }
      return structuredClone(discoveryStatus);
    } finally {
      discoveryCheckPending = false;
    }
  }
}

export function createScoreTransactionCounter(config, runtime = {}) {
  const configured = clampInt(
    config.rnbo?.transactionStart ?? 1000,
    0,
    MAX_EXACT_RNBO_TRANSACTION_ID - 1
  );
  const persistent = config.rnbo?.transactionIdMode === "persistent";
  const statePath = resolve(
    runtime.transactionStatePath ?? config.rnbo?.transactionStatePath ?? "data/rnbo-transaction.json"
  );
  let transactionId = persistent
    ? Math.max(configured, readPersistedTransactionId(statePath))
    : configured;

  return {
    current() {
      return transactionId;
    },
    next() {
      if (transactionId >= MAX_EXACT_RNBO_TRANSACTION_ID) {
        throw new RangeError(`RNBO transaction id capacity ${MAX_EXACT_RNBO_TRANSACTION_ID} exhausted`);
      }
      transactionId += 1;
      if (persistent) persistTransactionId(statePath, transactionId);
      return transactionId;
    },
    persistent,
    statePath
  };
}

function readPersistedTransactionId(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return clampInt(state.lastTransactionId ?? 0, 0, MAX_EXACT_RNBO_TRANSACTION_ID - 1);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw new Error(`Could not read RNBO transaction state '${statePath}': ${messageForError(error)}`);
  }
}

function persistTransactionId(statePath, transactionId) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify({ lastTransactionId: transactionId })}\n`);
  renameSync(temporaryPath, statePath);
}

export async function sendScoreTransaction(socket, config, score, transactionId, options = {}) {
  const targets = await rnboTargetsForSend(config, score, options.runtime, options);
  const compiledTargets = await Promise.all(targets.map(async (target) => {
    const preview = compileScoreTransaction(score, config, transactionId, target, options);
    const reusedStatus = options.reuseCompiledTarget?.(target, preview);
    if (reusedStatus) {
      const reusedAt = new Date().toISOString();
      const compiled = {
        ...preview,
        transactionId: reusedStatus.transactionId,
        scoreRevision: reusedStatus.scoreRevision,
        payloadRevision: reusedStatus.payloadRevision,
        targetId: target.id ?? target.address ?? "",
        voiceId: target.voiceId ?? "",
        reused: true,
        reusedAt,
        reuseReason: "identical-staged-payload",
        ack: reusedStatus.ack
      };
      emitLifecycleEvent(options, "prepare_reused", compiled, target, {
        observedAt: reusedAt,
        activeTransaction: reusedStatus.activeTransaction ?? null,
        preparedTransaction: reusedStatus.preparedTransaction ?? null
      });
      return { target, compiled };
    }
    const compiled = await sendCompiledScoreTransaction(socket, config, score, transactionId, target, options);
    if (config.rnbo.log !== false) {
      const ack = compiled.ack?.ok === false ? ` ack=${compiled.ack.status}` : "";
      console.log(
        `[rnbo] sent score v${score.version} txn=${transactionId} voice=${target.voiceId ?? "*"} notes=${compiled.noteCount} maxSteps=${compiled.patternLength} -> ${target.host}:${target.port}${target.address}${ack}`
      );
    }
    return { target, compiled };
  }));

  if (options.stagedOnly === true || Array.isArray(options.targetIds)) {
    return {
      targets: compiledTargets,
      partial: true,
      scope: options.stagedOnly === true ? "staged-only" : "selected-targets"
    };
  }
  return compiledTargets.length === 1 ? compiledTargets[0].compiled : { targets: compiledTargets };
}

async function sendCompiledScoreTransaction(socket, config, score, transactionId, target, options = {}) {
  const ackConfig = rnboAckConfig(config);
  const baseAttempts = ackConfig.enabled ? ackConfig.retries + 1 : 1;
  const maxAttempts = target?.capabilities?.resumableScoreReplace === true
    ? baseAttempts + ackConfig.resumeRetries
    : baseAttempts;
  let compiled;
  let ack = skippedAck("disabled");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sendStartedMs = now();
  let sendCompletedMs = sendStartedMs;
  let acknowledgementMs = sendStartedMs;
  let resumeFromRow = 0;
  let resumedRowCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const deliveryProfile = scoreDeliveryProfile(config, attempt);
    compiled = {
      ...compileScoreTransaction(score, config, transactionId, target, options),
      deliveryProfile
    };
    const delivery = resumeFromRow > 0
      ? {
          strategy: "resume-dense-prefix",
          resumeFromRow,
          rowCount: Math.max(0, compiled.transmittedRowCount - resumeFromRow)
        }
      : {
          strategy: "full-transaction",
          resumeFromRow: 0,
          rowCount: compiled.transmittedRowCount
        };
    if (attempt === 0) emitLifecycleEvent(options, "prepare_started", compiled, target, {
      observedAt: new Date(sendStartedMs).toISOString(),
      deliveryProfile,
      delivery
    });
    await sendCompiledMessages(socket, config, target, compiled, deliveryProfile, delivery, options);
    sendCompletedMs = now();
    ack = await readScoreTransactionAck(config, target, compiled, transactionId, {
      ...options,
      attempt
    });
    acknowledgementMs = now();
    if (ack.ok || ack.status === "skipped") {
      emitLifecycleEvent(options, "prepare_completed", compiled, target, {
        observedAt: new Date(acknowledgementMs).toISOString(),
        acknowledgement: ack,
        deliveryProfile,
        delivery,
        preparationDurationMs: Math.max(0, acknowledgementMs - sendStartedMs)
      });
      break;
    }
    const retryRow = resumableRetryRow(target, compiled, ack);
    resumeFromRow = retryRow ?? 0;
    if (resumeFromRow > 0) resumedRowCount += compiled.transmittedRowCount - resumeFromRow;
    const canRetry = attempt < baseAttempts - 1 || (resumeFromRow > 0 && attempt < maxAttempts - 1);
    const nextDelivery = resumeFromRow > 0
      ? {
          strategy: "resume-dense-prefix",
          resumeFromRow,
          rowCount: compiled.transmittedRowCount - resumeFromRow
        }
      : {
          strategy: "full-transaction",
          resumeFromRow: 0,
          rowCount: compiled.transmittedRowCount
        };
    emitLifecycleEvent(options, canRetry ? "prepare_retry" : "prepare_failed", compiled, target, {
      observedAt: new Date(acknowledgementMs).toISOString(),
      acknowledgement: ack,
      deliveryProfile,
      delivery,
      nextDelivery: canRetry ? nextDelivery : undefined,
      preparationDurationMs: Math.max(0, acknowledgementMs - sendStartedMs)
    });
    if (!canRetry) break;
    if (ackConfig.retryDelayMs > 0) {
      await delay(ackConfig.retryDelayMs);
    }
  }

  return {
    ...compiled,
    transactionId,
    scoreRevision: options.scoreRevision ?? score.scoreRevision ?? score.version ?? 0,
    payloadRevision: `${options.scoreRevision ?? score.scoreRevision ?? score.version ?? 0}:${compiled?.timing?.blockId ?? ""}`,
    sendStartedAt: new Date(sendStartedMs).toISOString(),
    sendCompletedAt: new Date(sendCompletedMs).toISOString(),
    acknowledgementAt: new Date(acknowledgementMs).toISOString(),
    preparationDurationMs: Math.max(0, acknowledgementMs - sendStartedMs),
    resumedRowCount,
    targetId: target.id ?? target.address ?? "",
    voiceId: target.voiceId ?? "",
    ack
  };
}

async function sendCompiledMessages(socket, config, target, compiled, deliveryProfile = scoreDeliveryProfile(config, 0), delivery = {}, options = {}) {
  const { batchSize, delayMs } = deliveryProfile;
  const resumeFromRow = clampInt(delivery.resumeFromRow ?? 0, 0, compiled.transmittedRowCount);
  const messages = resumeFromRow > 0
    ? compiled.messages.slice(resumeFromRow + 1)
    : compiled.messages;
  for (let index = 0; index < messages.length; index += batchSize) {
    const batch = messages.slice(index, index + batchSize);
    await Promise.all(batch.map((message) => sendOscMessage(socket, config, target, message.values)));
    const sentInAttempt = Math.min(index + batch.length, Math.max(0, messages.length - 1));
    emitTransferProgress(options, compiled, target, {
      state: "sending",
      observedAt: new Date().toISOString(),
      deliveryProfile,
      delivery,
      sentRowCount: Math.min(compiled.transmittedRowCount, resumeFromRow + sentInAttempt)
    });
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
  for (const message of scoreTransportInportMessages(config, compiled, options)) {
    await sendOscInportMessage(socket, target, message.name, message.value);
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
  emitTransferProgress(options, compiled, target, {
    state: "awaiting-ack",
    observedAt: new Date().toISOString(),
    deliveryProfile,
    delivery,
    sentRowCount: compiled.transmittedRowCount
  });
}

function emitTransferProgress(options, compiled, target, details = {}) {
  if (typeof options.onTransferProgress !== "function") return;
  options.onTransferProgress({
    transactionId: compiled?.transactionId ?? null,
    targetId: target?.id ?? target?.address ?? "",
    voiceId: target?.voiceId ?? "",
    blockId: compiled?.timing?.blockId ?? "",
    payloadRevision: `${options.scoreRevision ?? ""}:${compiled?.timing?.blockId ?? ""}`,
    transmittedRowCount: compiled?.transmittedRowCount ?? 0,
    ...details
  });
}

function resumableRetryRow(target, compiled, ack) {
  if (target?.capabilities?.resumableScoreReplace !== true) return null;
  if (compiled?.compactScoreReplace !== true || compiled?.stagedScoreActivation !== true) return null;
  if (ack?.status !== "rejected" || ![2, 5].includes(ack?.rejectReason)) return null;
  const row = Number(ack.receivedNoteCount);
  if (!Number.isInteger(row) || row <= 0 || row >= compiled.transmittedRowCount) return null;
  return row;
}

function scoreDeliveryProfile(config, attempt = 0) {
  const baseBatchSize = clampInt(config.rnbo.sendBatchSize ?? 1, 1, 64);
  const baseDelayMs = clampInt(config.rnbo.sendDelayMs ?? 0, 0, 10000);
  const divisor = 2 ** Math.max(0, attempt);
  const multiplier = 2 ** Math.max(0, attempt);
  const maxDelayMs = clampInt(config.rnbo.maxRetryDelayMs ?? 20, 0, 10000);
  return {
    attempt,
    batchSize: Math.max(1, Math.ceil(baseBatchSize / divisor)),
    delayMs: Math.min(maxDelayMs, baseDelayMs * multiplier),
    mode: attempt === 0 ? "normal" : "conservative-retry"
  };
}

export async function readScoreTransactionAck(config, target, compiled, transactionId, options = {}) {
  const ackConfig = rnboAckConfig(config);
  if (!ackConfig.enabled) {
    return skippedAck("disabled");
  }

  const url = rnboAckUrl(config, target, ackConfig);
  if (!url) {
    return skippedAck("unavailable", "no RNBO ACK OSCQuery path");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return skippedAck("unavailable", "fetch is not available");
  }

  if (ackConfig.settleMs > 0) {
    await delay(ackConfig.settleMs);
  }

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(ackConfig.timeoutMs)
    });
    if (!response.ok) {
      return badAck("http-error", { url, httpStatus: response.status, attempt: options.attempt ?? 0 });
    }
    const body = await response.json();
    return validateScoreTransactionAck(body?.VALUE, {
      target,
      compiled,
      transactionId,
      url,
      attempt: options.attempt ?? 0
    });
  } catch (error) {
    return badAck("read-failed", {
      url,
      attempt: options.attempt ?? 0,
      error: messageForError(error)
    });
  }
}

export function validateScoreTransactionAck(value, { target = {}, compiled = {}, transactionId, url = "", attempt = 0 } = {}) {
  if (!Array.isArray(value)) {
    return badAck("missing", { value: [], url, attempt });
  }

  const values = value.map((entry) => Number(entry));
  const opcodeIndex = ackOpcodeIndex(values);
  const opcode = values[opcodeIndex];
  const txn = values[opcodeIndex + 1];
  const acknowledgementValue = values[opcodeIndex + 2];
  const rejected = opcode === 91;
  const committedNoteCount = rejected ? undefined : acknowledgementValue;
  const rejectReason = rejected ? acknowledgementValue : undefined;
  const receivedNoteCount = rejected ? values[opcodeIndex + 3] : undefined;
  const okFlag = values.at(-1);
  const clientId = opcodeIndex > 0 ? values[0] : undefined;
  const expectedClientId = target.clientId === undefined || target.clientId === null || target.clientId === ""
    ? undefined
    : clampInt(target.clientId, 0, 2147483647);
  const base = {
    ok: false,
    value: values,
    url,
    attempt,
    opcode,
    transactionId: txn,
    expectedTransactionId: transactionId,
    committedNoteCount,
    rejectReason,
    rejectReasonLabel: rejectReason === undefined ? undefined : TRANSACTION_REJECT_REASONS[rejectReason] ?? "unknown",
    receivedNoteCount,
    expectedClientId,
    noteCount: compiled.noteCount ?? 0,
    transmittedRowCount: compiled.transmittedRowCount ?? 0
  };

  if (expectedClientId !== undefined && clientId !== expectedClientId) {
    return { ...base, status: "client mismatch", clientId };
  }
  const expectedOpcode = compiled.stagedScoreActivation === true ? OPCODES.READY : OPCODES.COMMIT;
  if (opcode !== expectedOpcode) {
    return { ...base, status: opcode === 91 ? "rejected" : "opcode-mismatch", clientId };
  }
  if (txn !== transactionId) {
    return { ...base, status: "stale transaction", clientId };
  }
  if (okFlag !== 1) {
    return { ...base, status: "rejected", clientId };
  }
  if (
    compiled.validateAckNoteCount === true &&
    Number.isFinite(committedNoteCount) &&
    Number.isFinite(compiled.noteCount) &&
    committedNoteCount !== compiled.noteCount
  ) {
    return { ...base, status: "note count mismatch", clientId };
  }

  return {
    ...base,
    ok: true,
    status: expectedOpcode === OPCODES.READY ? "prepared" : "committed",
    clientId
  };
}

export async function readScoreActivationAck(request, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!request?.url || typeof fetchImpl !== "function") {
    return badAck("unavailable", {
      url: request?.url ?? "",
      expectedTransactionId: request?.transactionId
    });
  }
  try {
    const response = await fetchImpl(request.url, {
      signal: AbortSignal.timeout(clampInt(options.timeoutMs ?? 300, 1, 60000))
    });
    if (!response.ok) {
      return badAck("http-error", { url: request.url, httpStatus: response.status });
    }
    const body = await response.json();
    return validateScoreActivationAck(body?.VALUE, request);
  } catch (error) {
    return badAck("read-failed", {
      url: request.url,
      expectedTransactionId: request.transactionId,
      error: messageForError(error)
    });
  }
}

export function validateScoreActivationAck(value, {
  transactionId,
  expectedClientId,
  initialStage = 0,
  url = ""
} = {}) {
  if (!Array.isArray(value)) {
    return badAck("missing", { value: [], url, expectedTransactionId: transactionId });
  }
  const values = value.map((entry) => Number(entry));
  const opcodeIndex = ackOpcodeIndex(values);
  const opcode = values[opcodeIndex];
  const txn = values[opcodeIndex + 1];
  const activeRowCount = values[opcodeIndex + 2];
  const activatedStage = values[opcodeIndex + 3];
  const okFlag = values.at(-1);
  const clientId = opcodeIndex > 0 ? values[0] : undefined;
  const base = {
    ok: false,
    value: values,
    url,
    opcode,
    transactionId: txn,
    expectedTransactionId: transactionId,
    clientId,
    expectedClientId,
    activeRowCount,
    activatedStage,
    expectedStage: initialStage
  };
  if (expectedClientId !== undefined && clientId !== Number(expectedClientId)) {
    return { ...base, status: "client mismatch" };
  }
  if (opcode === 91) {
    const rejectReason = values[opcodeIndex + 2];
    return {
      ...base,
      rejectReason,
      rejectReasonLabel: ACTIVATION_REJECT_REASONS[rejectReason] ?? "unknown",
      preparedTransaction: values[opcodeIndex + 3],
      status: "activation rejected"
    };
  }
  if (opcode !== OPCODES.ACTIVE) {
    return { ...base, status: "awaiting activation" };
  }
  if (txn !== transactionId) {
    return { ...base, status: "stale transaction" };
  }
  if (okFlag !== 1) {
    return { ...base, status: "rejected" };
  }
  if (initialStage !== null && activatedStage !== initialStage) {
    return { ...base, status: "stage mismatch" };
  }
  return { ...base, ok: true, status: "active" };
}

function ackOpcodeIndex(values) {
  if (values.length > 1 && [1, 20, 30, 90, 91, 92, 93, 100].includes(values[1])) {
    return 1;
  }
  return 0;
}

function resendDebounceMs(config) {
  return clampInt(config.rnbo?.resendDebounceMs ?? 100, 0, 60000);
}

function shouldDebounceResend(config, reason, options = {}) {
  if (options.immediate === true || options.forceFullClearRows === true) {
    return false;
  }
  if (["manual", "admin", "admin-full-clear", "target-discovery"].includes(String(reason ?? ""))) {
    return false;
  }
  return resendDebounceMs(config) > 0;
}

function payloadReuseAllowed(request) {
  if (request.options?.forceFullClearRows === true || request.options?.forceResend === true) {
    return false;
  }
  return !(request.reasons ?? []).some((reason) => ["manual", "admin", "admin-full-clear", "target-discovery"].includes(reason));
}

function rnboAckConfig(config) {
  const rnbo = config.rnbo ?? {};
  const ack = rnbo.ack ?? {};
  const enabled = ack.enabled === undefined ? Boolean(rnbo.oscQuery?.enabled) : Boolean(ack.enabled);
  return {
    enabled,
    retries: clampInt(ack.retries ?? 2, 0, 5),
    resumeRetries: clampInt(ack.resumeRetries ?? 4, 0, 20),
    retryDelayMs: clampInt(ack.retryDelayMs ?? 50, 0, 10000),
    settleMs: clampInt(ack.settleMs ?? 50, 0, 10000),
    timeoutMs: clampInt(ack.timeoutMs ?? rnbo.oscQuery?.timeoutMs ?? 1000, 1, 60000),
    oscQueryPort: clampInt(ack.oscQueryPort ?? 5678, 1, 65535)
  };
}

function rnboActivationConfig(config, tempo) {
  const activation = config.rnbo?.activation ?? {};
  const bpm = Number(tempo);
  const beatWaitMs = Number.isFinite(bpm) && bpm > 0 ? 60000 / bpm : 0;
  const beatMarginMs = clampInt(activation.beatMarginMs ?? 750, 0, 60000);
  const configuredTimeoutMs = clampInt(activation.timeoutMs ?? 1800, 1, 60000);
  return {
    timeoutMs: Math.max(configuredTimeoutMs, Math.ceil(beatWaitMs + beatMarginMs)),
    pollIntervalMs: clampInt(activation.pollIntervalMs ?? 50, 1, 10000),
    requestTimeoutMs: clampInt(activation.requestTimeoutMs ?? 300, 1, 60000)
  };
}

function rnboAckUrl(config, target, ackConfig) {
  const path = normalizeAckPath(target.ackPath) || inferAckPath(target);
  if (!path) {
    return "";
  }
  const host = target.transportHost ?? target.host ?? config.rnbo?.oscQuery?.oscHost ?? config.rnbo?.host;
  if (!host) {
    return "";
  }
  const baseUrl = target.transportHost
    ? oscQueryBaseUrl(config, host, ackConfig.oscQueryPort)
    : target.oscQueryUrl ?? oscQueryBaseUrl(config, host, ackConfig.oscQueryPort);
  return `${baseUrl}${path}`;
}

function oscQueryBaseUrl(config, host, port) {
  const configuredUrl = config.rnbo?.oscQuery?.url;
  if (isLoopbackHost(host) && configuredUrl) {
    return stripTrailingSlash(configuredUrl);
  }
  return `http://${host}:${port}`;
}

function inferAckPath(target) {
  const instanceId = target.instanceId ?? readInstanceId(target.address ?? target.messagePath ?? "");
  return instanceId ? `/rnbo/inst/${instanceId}/messages/out/shadowscore_ack` : "";
}

function normalizeAckPath(path) {
  const normalized = stringField(path, "");
  return normalized.startsWith("/") ? normalized : "";
}

function skippedAck(status, reason = "") {
  return { ok: true, status: "skipped", skipped: status, reason };
}

function badAck(status, extras = {}) {
  return {
    ok: false,
    status: operationalAckStatus(status),
    ...extras
  };
}

function operationalAckStatus(status) {
  switch (status) {
    case "http-error":
    case "read-failed":
      return "unreachable";
    case "commit-failed":
      return "rejected";
    case "stale":
      return "stale transaction";
    default:
      return status;
  }
}

async function rnboTargetsForSend(config, score, runtime = {}, options = {}) {
  const liveTargets = Array.isArray(options.liveTargets)
    ? options.liveTargets
    : await readLiveRnboTargets(config, runtime);
  let targets = rnboTargets(config, score, liveTargets);
  if (Array.isArray(options.voiceIds)) {
    const voiceIds = new Set(options.voiceIds);
    targets = targets.filter((target) => !target.voiceId || voiceIds.has(target.voiceId));
  }
  if (Array.isArray(options.targetIds)) {
    const targetIds = new Set(options.targetIds);
    targets = targets.filter((target) => targetIds.has(target.id ?? target.address ?? ""));
  }
  return options.stagedOnly === true
    ? targets.filter((target) => target.capabilities?.stagedScoreActivation === true)
    : targets;
}

function scoreWithActiveBlock(score, blockId) {
  const normalizedBlockId = String(blockId ?? "").trim();
  if (!normalizedBlockId || !score?.mesostructure?.[normalizedBlockId]) {
    throw new Error(`Unknown look-ahead block '${normalizedBlockId}'`);
  }
  const macroIndex = (score.macrostructure?.blocks ?? []).indexOf(normalizedBlockId);
  return {
    ...score,
    structureState: {
      ...(score.structureState ?? {}),
      activeBlockId: normalizedBlockId,
      macroIndex: macroIndex >= 0 ? macroIndex : score.structureState?.macroIndex ?? 0
    }
  };
}

async function readLiveRnboTargets(config, runtime = {}, options = {}) {
  const discover = runtime.discoverRnboTargets ?? discoverRnboTargets;
  let localTargets;
  try {
    localTargets = await discover(config, {
      fetchImpl: runtime.fetchImpl,
      throwOnError: options.requireComplete === true
    });
  } catch (error) {
    if (options.requireComplete === true) throw error;
    localTargets = [];
  }
  const peerTargets = runtime.peerRegistry?.targets?.() ?? [];
  return [...localTargets, ...peerTargets];
}

function targetDiscoveryStabilityCount(config) {
  return clampInt(config.rnbo?.discoveryStabilityCount ?? 2, 1, 10);
}

function targetInventory(targets = []) {
  return new Map(targets.flatMap((target) => {
    const id = String(target?.id ?? target?.address ?? "").trim();
    return id ? [[id, { target, signature: rnboTargetSignature([target]) }]] : [];
  }));
}

function targetsNeedingDiscoveryReconciliation(previous, next) {
  const targetIds = [];
  for (const [targetId, entry] of next) {
    if (entry.target?.available === false) continue;
    const prior = previous.get(targetId);
    if (!prior || prior.target?.available === false || prior.signature !== entry.signature) {
      targetIds.push(targetId);
    }
  }
  return targetIds.sort();
}

export function rnboTargetSignature(targets = []) {
  return targets
    .map((target) => [
      target.id ?? "",
      target.localId ?? "",
      target.instanceId ?? "",
      target.host ?? "",
      target.port ?? "",
      target.address ?? "",
      target.messagePath ?? "",
      target.available === false ? "offline" : "online",
      target.capabilities?.maxStages ?? "",
      target.capabilities?.maxNoteRows ?? "",
      target.capabilities?.noteDataFloatCount ?? "",
      target.capabilities?.supportsBeginReplaceClear === true ? "begin-clear" : "",
      target.capabilities?.activeRowCountCommit === true ? "active-row-count" : "",
      target.capabilities?.compactScoreReplace === true ? "compact" : "",
      target.capabilities?.stagedScoreActivation === true ? "staged-activation" : "",
      target.capabilities?.resumableScoreReplace === true ? "resumable-replace" : "",
      target.capabilities?.continuingScoreActivation === true ? "continuing-activation" : ""
    ].join("\u001f"))
    .sort()
    .join("\u001e");
}

export function scoreTransportInportMessages(config, compiled, options = {}) {
  // A staged transaction carries its pattern length and resolution in
  // BEGIN_REPLACE. Writing the corresponding live inports while merely
  // preparing that transaction retimes the block that is still playing, and
  // peer transfers finish at different times. The RNBO client applies the
  // staged timing atomically when ActivatePrepared promotes the transaction.
  if (options.stagedOnly === true && compiled?.stagedScoreActivation === true) return [];

  const transport = config.rnbo?.transport ?? {};
  const messages = [
    { name: "ClockInterval", value: finiteNumber(compiled.timing?.ticksPerStage, finiteNumber(transport.ClockInterval, 120)) },
    { name: "MaxSteps", value: compiled.patternLength }
  ];
  if (tempoAuthority(config) === "server") {
    messages.unshift({ name: "Tempo", value: finiteNumber(transport.Tempo, 120) });
  }
  return messages;
}

export function tempoAuthority(config) {
  return config.transport?.tempoAuthority === "server" ? "server" : "link";
}

export function shouldSendScoreTransaction(event) {
  return Boolean(
    event.type === "context.updated" ||
    event.type === "clip.added" ||
    event.type === "clip.replaced" ||
    event.type === "clip.renamed" ||
    event.type === "clip.removed" ||
    event.type === "mesostructure.block.replaced" ||
    event.type === "mesostructure.block.duplicated" ||
    event.type === "mesostructure.block.removed" ||
    event.type === "mesostructure.ttid.updated" ||
    event.type === "macrostructure.updated" ||
    event.type === "structure.playhead.updated" ||
    event.type === "voice.notes.replaced" ||
    event.type === "voice.assignment.replaced" ||
    event.type === "admin.legacyVoiceNotes.imported" ||
    (event.type === "admin.reset" && (event.detail?.context || event.detail?.voices || event.detail?.assignments || event.detail?.structure || event.detail?.notes))
  );
}

export function compileTimingContract(score, config, target = rnboTargets(config, score)[0], options = {}) {
  const resolution = config.rnbo?.resolution ?? {};
  const mode = resolutionMode(resolution.mode);
  const maxStages = clampInt(target?.capabilities?.maxStages ?? resolution.maxStages ?? 4096, 1, 2147483647);
  const maxNoteRows = clampInt(target?.capabilities?.maxNoteRows ?? resolution.maxNoteRows ?? 819, 1, 2147483647);
  const selectionStart = readNumber(options.selectionStart, 0);
  const selectionEnd = readNumber(options.selectionEnd, selectionStart + readNumber(options.blockBeats, 0));
  const blockBeats = Math.max(0, selectionEnd - selectionStart);
  const selected = chooseTimingResolution(mode, resolution, config, blockBeats, maxStages, options.notes ?? [], selectionStart);
  const stagesPerBeat = selected.stagesPerBeat;
  const patternLength = clampInt(Math.ceil((selectionEnd - selectionStart) * stagesPerBeat), 1, 2147483647);
  const ticksPerStage = 480 / stagesPerBeat;

  if (patternLength > maxStages) {
    const error = new RangeError(
      `RNBO timing contract requires ${patternLength} stages, exceeding target capacity ${maxStages}`
    );
    error.code = "RNBO_STAGE_CAPACITY_EXCEEDED";
    error.timing = {
      blockId: stringField(options.blockId, ""),
      blockBeats,
      stagesPerBeat,
      patternLength,
      maxStages,
      resolutionMode: mode
    };
    throw error;
  }

  return {
    blockId: stringField(options.blockId, ""),
    stagesPerBeat,
    ticksPerStage,
    patternLength,
    maxStages,
    maxNoteRows,
    resolutionMode: mode,
    quantizationError: selected.quantizationError
  };
}

export function compileScoreTransaction(score, config, transactionId, target = rnboTargets(config, score)[0], options = {}) {
  target = normalizeTransactionTarget(config, target);
  const activeBlock = activeMesoBlock(score);
  const activeBlockId = activeMesoBlockId(score);
  const selectionStart = readNumber(score.context.clip?.time_selection_start, 0);
  const blockBeats = blockDurationBeats(activeBlock, score.context);
  const notes = activeBlock ? flattenBlockNotes(score, activeBlock, target.voiceId, blockBeats) : flattenScoreNotes(score, target.voiceId);
  const selectionEnd = inferSelectionEnd(score, notes, selectionStart, activeBlock);
  const timing = compileTimingContract(score, config, target, {
    blockId: activeBlock ? activeBlockId : "",
    blockBeats,
    notes,
    selectionStart,
    selectionEnd
  });
  const { patternLength, stagesPerBeat } = timing;
  const prefix = target.clientId === undefined ? [] : [clampInt(target.clientId, 0, 2147483647)];

  const forceFullClearRows = options.forceFullClearRows === true || config.rnbo?.forceFullClearRows === true;
  const compactScoreReplace = compactScoreReplaceCapable(target) && !forceFullClearRows;
  const configuredClearRowCount = clampInt(config.rnbo.clearRowCount ?? 0, 0, 2147483647);
  const clearRowCount = compactScoreReplace
    ? 0
    : Math.max(configuredClearRowCount, timing.maxNoteRows);
  const transmittedRowCount = compactScoreReplace
    ? notes.length
    : Math.max(notes.length, clearRowCount);
  const replacementMode = compactScoreReplace ? "compact" : "legacy-full-clear";
  const stagedScoreActivation = target.capabilities?.stagedScoreActivation === true;
  const continuingScoreActivation = target.capabilities?.continuingScoreActivation === true;
  const resumableScoreReplace = target.capabilities?.resumableScoreReplace === true;
  const transactionFlags = stagedScoreActivation ? TRANSACTION_FLAGS.PREPARE_ONLY : 0;
  const messages = [
    {
      label: "BEGIN_REPLACE",
      values: [...prefix, OPCODES.BEGIN_REPLACE, transactionId, 1, transmittedRowCount, patternLength, stagesPerBeat, transactionFlags]
    }
  ];

  for (let index = 0; index < transmittedRowCount; index += 1) {
    const note = notes[index];
    messages.push({
      label: note ? `NOTE_${index}` : `CLEAR_${index}`,
      values: noteValues(prefix, transactionId, index, note, selectionStart, stagesPerBeat)
    });
  }

  messages.push({
    label: "COMMIT",
    values: [...prefix, OPCODES.COMMIT, transactionId, transmittedRowCount, 0]
  });

  const payloadHash = createHash("sha256")
    .update(JSON.stringify(messages.map((message) => {
      const values = [...message.values];
      values[prefix.length + 1] = 0;
      return values;
    })))
    .digest("hex");

  return {
    transactionId,
    messages,
    noteCount: notes.length,
    transmittedRowCount,
    replacementMode,
    compactScoreReplace,
    stagedScoreActivation,
    resumableScoreReplace,
    continuingScoreActivation,
    transactionFlags,
    forceFullClearRows,
    patternLength,
    stagesPerBeat,
    timing,
    payloadHash,
    blockId: timing.blockId
  };
}

function emitLifecycleEvent(options, type, compiled, target, details = {}) {
  if (typeof options.onLifecycleEvent !== "function") return;
  options.onLifecycleEvent({
    type,
    transactionId: compiled?.transactionId ?? null,
    targetId: target?.id ?? target?.address ?? "",
    voiceId: target?.voiceId ?? "",
    blockId: compiled?.timing?.blockId ?? "",
    payloadRevision: `${options.scoreRevision ?? ""}:${compiled?.timing?.blockId ?? ""}`,
    payloadHash: compiled?.payloadHash ?? null,
    compiledRowCount: compiled?.noteCount ?? 0,
    transmittedRowCount: compiled?.transmittedRowCount ?? 0,
    ...details
  });
}

function noteValues(prefix, transactionId, index, note, selectionStart, stagesPerBeat) {
  if (!note) {
    return [
      ...prefix,
      OPCODES.NOTE,
      transactionId,
      index,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      64
    ];
  }

  return [
    ...prefix,
    OPCODES.NOTE,
    transactionId,
    index,
    clampInt(note.note_id ?? index + 1, 0, 2147483647),
    clampInt(note.pitch, 0, 127),
    clampInt((readNumber(note.start_time, 0) - selectionStart) * stagesPerBeat, 0, 2147483647),
    clampInt(readNumber(note.duration, 0) * stagesPerBeat, 1, 2147483647),
    clampInt(note.velocity, 0, 127),
    clampInt(note.mute ?? 0, 0, 1),
    clampInt(readNumber(note.probability, 1) * 10000, 0, 10000),
    clampInt(note.velocity_deviation ?? 0, 0, 127),
    clampInt(note.release_velocity ?? 64, 0, 127)
  ];
}

function normalizeTransactionTarget(config, target = {}) {
  const capabilities = rnboPlaybackCapabilities(config, target.capabilities);
  return {
    ...target,
    // Current continuing-activation clients require the routing client id as
    // the first atom. Fresh RNBO instances may not expose an input/ACK value
    // until after their first transaction, so live discovery cannot always
    // supply it during bootstrap.
    clientId: target.clientId ?? (capabilities.continuingScoreActivation === true
      ? config.rnbo?.clientId ?? 90
      : undefined),
    capabilities
  };
}

function compactScoreReplaceCapable(target = {}) {
  const capabilities = target.capabilities ?? {};
  return capabilities.compactScoreReplace === true &&
    capabilities.supportsBeginReplaceClear === true &&
    capabilities.activeRowCountCommit === true;
}

function chooseTimingResolution(mode, resolution, config, blockBeats, maxStages, notes, selectionStart) {
  const fixedStagesPerBeat = clampInt(resolution.defaultStagesPerBeat ?? config.rnbo?.stagesPerBeat ?? 16, 1, 960);
  if (mode !== "fit" && mode !== "fidelity" && mode !== "hybrid") {
    return { stagesPerBeat: fixedStagesPerBeat, quantizationError: null };
  }

  const candidates = stageCandidates(resolution.candidateStagesPerBeat);
  const maxFitStagesPerBeat = blockBeats > 0 ? Math.floor(maxStages / blockBeats) : maxStages;
  const fitting = candidates.filter((candidate) => candidate <= maxFitStagesPerBeat);
  const fallback = fitting.at(-1) ?? candidates[0] ?? fixedStagesPerBeat;

  if (mode === "fit") {
    return { stagesPerBeat: fallback, quantizationError: null };
  }

  const targetBeats = finiteNumber(resolution.quantizationErrorTargetBeats, 1 / 480);
  const scored = (fitting.length ? fitting : [fallback]).map((candidate) => ({
    stagesPerBeat: candidate,
    quantizationError: quantizationErrorForCandidate(candidate, notes, selectionStart, targetBeats, blockBeats)
  }));
  const acceptable = scored.find((candidate) => candidate.quantizationError.worstBeats <= targetBeats);
  if (acceptable) {
    return acceptable;
  }
  if (mode === "hybrid") {
    return scored.at(-1);
  }
  return [...scored].sort(compareQuantizationScores)[0];
}

function stageCandidates(values) {
  const candidates = Array.isArray(values) ? values : [];
  return [...new Set(candidates.map((value) => clampInt(value, 1, 480)).filter((value) => 480 % value === 0))]
    .sort((a, b) => a - b);
}

function quantizationErrorForCandidate(stagesPerBeat, notes, selectionStart, targetBeats, blockBeats) {
  const quantizedBlockBeats = Math.ceil(blockBeats * stagesPerBeat) / stagesPerBeat;
  const blockBoundaryError = Math.abs(quantizedBlockBeats - blockBeats);
  const values = notes.flatMap((note) => [
    { type: "onset", value: readNumber(note.start_time, 0) - selectionStart },
    { type: "duration", value: readNumber(note.duration, 0) }
  ]);
  if (values.length === 0) {
    return {
      targetBeats,
      noteCount: 0,
      worstBeats: roundBeat(blockBoundaryError),
      worstBlockBoundaryBeats: roundBeat(blockBoundaryError),
      worstOnsetBeats: 0,
      worstDurationBeats: 0,
      meanAbsoluteBeats: 0,
      meanSignedOnsetBeats: 0,
      meanSignedDurationBeats: 0
    };
  }

  let absoluteTotal = 0;
  let onsetSignedTotal = 0;
  let onsetCount = 0;
  let durationSignedTotal = 0;
  let durationCount = 0;
  let worstOnsetBeats = 0;
  let worstDurationBeats = 0;

  for (const entry of values) {
    const quantized = Math.round(entry.value * stagesPerBeat) / stagesPerBeat;
    const signed = quantized - entry.value;
    const absolute = Math.abs(signed);
    absoluteTotal += absolute;
    if (entry.type === "onset") {
      onsetSignedTotal += signed;
      onsetCount += 1;
      worstOnsetBeats = Math.max(worstOnsetBeats, absolute);
    } else {
      durationSignedTotal += signed;
      durationCount += 1;
      worstDurationBeats = Math.max(worstDurationBeats, absolute);
    }
  }

  return {
    targetBeats,
    noteCount: notes.length,
    worstBeats: roundBeat(Math.max(blockBoundaryError, worstOnsetBeats, worstDurationBeats)),
    worstBlockBoundaryBeats: roundBeat(blockBoundaryError),
    worstOnsetBeats: roundBeat(worstOnsetBeats),
    worstDurationBeats: roundBeat(worstDurationBeats),
    meanAbsoluteBeats: roundBeat(absoluteTotal / values.length),
    meanSignedOnsetBeats: roundBeat(onsetCount ? onsetSignedTotal / onsetCount : 0),
    meanSignedDurationBeats: roundBeat(durationCount ? durationSignedTotal / durationCount : 0)
  };
}

function compareQuantizationScores(a, b) {
  return a.quantizationError.worstBeats - b.quantizationError.worstBeats ||
    a.quantizationError.meanAbsoluteBeats - b.quantizationError.meanAbsoluteBeats ||
    a.stagesPerBeat - b.stagesPerBeat;
}

function usesDerivedClock(mode) {
  return mode === "fit" || mode === "fidelity" || mode === "hybrid";
}

function resolutionMode(value) {
  return ["fixed", "fit", "fidelity", "hybrid"].includes(value) ? value : "fixed";
}

function roundBeat(value) {
  return Math.round(value * 1e12) / 1e12;
}

function flattenScoreNotes(score, voiceFilter) {
  return Object.entries(score.voices)
    .filter(([voiceId]) => voiceFilter === undefined || voiceId === voiceFilter)
    .flatMap(([voiceId, voice]) =>
      voice.notes.map((note, voiceIndex) => ({
        ...note,
        voiceId,
        voiceIndex
      }))
    )
    .sort((a, b) => readNumber(a.start_time, 0) - readNumber(b.start_time, 0) || readNumber(a.pitch, 0) - readNumber(b.pitch, 0));
}

function flattenBlockNotes(score, block, voiceFilter, blockBeats = 0) {
  return Object.entries(block.players ?? {})
    .filter(([voiceId]) => voiceFilter === undefined || voiceId === voiceFilter)
    .flatMap(([voiceId, assignment]) => {
      const clipId = mesoPlayerClipId(assignment);
      const clip = score.clips?.[clipId];
      return expandClipNotes(clip, {
        voiceId,
        clipId,
        blockBeats,
        blockTtid: block.ttid,
        context: score.context
      });
    })
    .sort((a, b) => readNumber(a.start_time, 0) - readNumber(b.start_time, 0) || readNumber(a.pitch, 0) - readNumber(b.pitch, 0));
}

function expandClipNotes(clip, { voiceId, clipId, blockBeats, blockTtid, context }) {
  if (!clip) {
    return [];
  }
  const clipNotes = clip.notes ?? [];
  const clipBeats = clipDurationBeats(clip, context);
  const playbackType = clip.playbackType === "one-shot" ? "one-shot" : "looped";
  if (playbackType === "one-shot" || blockBeats <= 0 || clipBeats <= 0) {
    return clipNotes.map((note, voiceIndex) => ({
      ...noteWithBlockTtid(note, clip, blockTtid),
      voiceId,
      clipId,
      voiceIndex
    }));
  }

  const notes = [];
  for (let offset = 0, iteration = 0; offset < blockBeats; offset += clipBeats, iteration += 1) {
    for (let voiceIndex = 0; voiceIndex < clipNotes.length; voiceIndex += 1) {
      const note = clipNotes[voiceIndex];
      const start = readNumber(note.start_time, 0) + offset;
      if (start >= blockBeats) {
        continue;
      }
      const duration = Math.min(Math.max(0, readNumber(note.duration, 0)), Math.max(0, blockBeats - start));
      if (duration <= 0) {
        continue;
      }
      notes.push({
        ...noteWithBlockTtid(note, clip, blockTtid),
        note_id: note.note_id === undefined ? undefined : readNumber(note.note_id, voiceIndex + 1) + iteration * clipNotes.length,
        start_time: start,
        duration,
        voiceId,
        clipId,
        voiceIndex
      });
    }
  }
  return notes;
}

function noteWithBlockTtid(note, clip, blockTtid) {
  if (clip?.behavior?.followsScale === false || !Number.isInteger(blockTtid)) return note;
  const pitch = quantizePitchToTtid(note.pitch, blockTtid);
  return pitch === note.pitch ? note : { ...note, pitch };
}

function activeMesoBlock(score) {
  const blockId = activeMesoBlockId(score);
  const block = blockId ? score.mesostructure?.[blockId] : undefined;
  if (!block) {
    return undefined;
  }
  const hasAssignedClips = Object.values(block.players ?? {}).some((assignment) => score.clips?.[mesoPlayerClipId(assignment)]);
  return hasAssignedClips ? block : undefined;
}

function activeMesoBlockId(score) {
  return score.structureState?.activeBlockId ?? score.macrostructure?.blocks?.[0] ?? "";
}

function mesoPlayerClipId(assignment) {
  return typeof assignment === "string" ? assignment : assignment?.clipId;
}

function inferSelectionEnd(score, notes, selectionStart, activeBlock) {
  const configuredEnd = score.context.clip?.time_selection_end;
  if (typeof configuredEnd === "number" && configuredEnd > selectionStart) {
    return configuredEnd;
  }
  const blockBeats = blockDurationBeats(activeBlock, score.context);
  if (blockBeats > 0) {
    return selectionStart + blockBeats;
  }
  const lastNoteEnd = Math.max(
    selectionStart + 4,
    ...notes.map((note) => readNumber(note.start_time, 0) + Math.max(0, readNumber(note.duration, 0)))
  );
  return lastNoteEnd;
}

function blockDurationBeats(block, context) {
  return durationBeats(block?.duration, context);
}

function clipDurationBeats(clip, context) {
  const configured = durationBeats(clip?.duration, clip?.context ?? context);
  if (configured > 0) {
    return configured;
  }
  const contextClip = clip?.context?.clip;
  if (typeof contextClip?.time_selection_start === "number" && typeof contextClip.time_selection_end === "number" && contextClip.time_selection_end > contextClip.time_selection_start) {
    return contextClip.time_selection_end - contextClip.time_selection_start;
  }
  return Math.max(0, ...(clip?.notes ?? []).map((note) => readNumber(note.start_time, 0) + Math.max(0, readNumber(note.duration, 0))));
}

function durationBeats(duration, context) {
  if (!duration) {
    return 0;
  }
  if (Number.isFinite(duration.beats)) {
    return Number(duration.beats);
  }
  if (Number.isFinite(duration.bars)) {
    const numerator = readNumber(context?.clip?.TimeSignature?.numerator, 4);
    return Number(duration.bars) * Math.max(1, numerator);
  }
  return 0;
}

async function sendOscMessage(socket, config, target, values) {
  const packet = encodeOscMessage(target.address, values);
  await new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.host, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sendOscInportMessage(socket, target, name, value) {
  const instanceId = readInstanceId(target.address);
  if (!instanceId) {
    throw new Error(`RNBO target '${target.id ?? ""}' does not include an instance id`);
  }
  const packet = encodeOscMessage(`/rnbo/inst/${instanceId}/messages/in/${name}`, [value]);
  await new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.transportHost ?? target.host, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sendPreparedActivationRequest(socket, target, request) {
  const instanceId = readInstanceId(target.address);
  if (!instanceId) throw new Error(`RNBO target '${target.id ?? ""}' does not include an instance id`);
  const activationMode = request.activationMode === "continue" ? 1 : 0;
  const boundary = request.boundary === "next-beat" ? 1 : 0;
  const packet = encodeOscMessage(`/rnbo/inst/${instanceId}/messages/in/ActivatePrepared`, [
    request.transactionId,
    activationMode,
    boundary
  ]);
  await new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.transportHost ?? target.host, (error) => error ? reject(error) : resolve());
  });
}

function rnboTargets(config, score, liveTargets = []) {
  const assignedTargets = assignmentRnboTargets(config, score, liveTargets);
  if (assignedTargets.length > 0) {
    return assignedTargets;
  }
  if (Array.isArray(config.rnbo.targets) && config.rnbo.targets.length > 0) {
    return config.rnbo.targets.map((target) => ({
      id: target.id,
      host: target.host ?? config.rnbo.host,
      transportHost: target.transportHost,
      port: target.port ?? config.rnbo.port,
      address: target.address ?? config.rnbo.address,
      instanceId: target.instanceId,
      messagePath: target.messagePath,
      ackPath: target.ackPath,
      currentStagePath: target.currentStagePath,
      clockPath: target.clockPath,
      clockStartAckPath: target.clockStartAckPath,
      clockStartAck: target.clockStartAck,
      clockPhaseResetPath: target.clockPhaseResetPath,
      clockPhaseAckPath: target.clockPhaseAckPath,
      clockPhaseAck: target.clockPhaseAck,
      oscQueryUrl: target.oscQueryUrl,
      voiceId: target.voiceId,
      clientId: target.clientId,
      capabilities: rnboPlaybackCapabilities(config, target.capabilities)
    }));
  }
  return [
    {
      host: config.rnbo.host,
      port: config.rnbo.port,
      address: config.rnbo.address,
      clientId: config.rnbo.clientId,
      capabilities: rnboPlaybackCapabilities(config)
    }
  ];
}

function assignmentRnboTargets(config, score, liveTargets = []) {
  if (!score?.assignments) {
    return [];
  }
  return Object.entries(score.assignments)
    .filter(([, assignment]) => assignment?.rnboAddress)
    .map(([voiceId, assignment]) => {
      const configuredTarget = liveTargetForAssignment(liveTargets, assignment) ?? configuredTargetForAssignment(config, assignment);
      return {
        host: configuredTarget?.host ?? assignment.rnboHost ?? config.rnbo.host,
        transportHost: configuredTarget?.transportHost,
        port: configuredTarget?.port ?? assignment.rnboPort ?? config.rnbo.port,
        address: configuredTarget?.address ?? assignment.rnboAddress,
        instanceId: configuredTarget?.instanceId,
        messagePath: configuredTarget?.messagePath,
        ackPath: configuredTarget?.ackPath,
        clockPath: configuredTarget?.clockPath,
        clockStartAckPath: configuredTarget?.clockStartAckPath,
        clockStartAck: configuredTarget?.clockStartAck,
        clockPhaseResetPath: configuredTarget?.clockPhaseResetPath,
        clockPhaseAckPath: configuredTarget?.clockPhaseAckPath,
        clockPhaseAck: configuredTarget?.clockPhaseAck,
        oscQueryUrl: configuredTarget?.oscQueryUrl,
        voiceId,
        clientId: assignment.clientId ?? configuredTarget?.clientId,
        id: assignment.rnboTargetId || undefined,
        capabilities: rnboPlaybackCapabilities(config, configuredTarget?.capabilities)
      };
    });
}

function liveTargetForAssignment(targets, assignment) {
  return targets.find((target) => {
    if (assignment.rnboTargetId && (target.id === assignment.rnboTargetId || target.localId === assignment.rnboTargetId)) {
      return true;
    }
    return target.address === assignment.rnboAddress &&
      String(target.host ?? "") === String(assignment.rnboHost || "") &&
      Number(target.port) === Number(assignment.rnboPort);
  });
}

function configuredTargetForAssignment(config, assignment) {
  return (config.rnbo?.targets ?? []).find((target) => {
    if (assignment.rnboTargetId && target.id === assignment.rnboTargetId) {
      return true;
    }
    return target.address === assignment.rnboAddress &&
      String(target.host ?? config.rnbo?.host ?? "") === String(assignment.rnboHost || config.rnbo?.host || "") &&
      Number(target.port ?? config.rnbo?.port) === Number(assignment.rnboPort ?? config.rnbo?.port);
  });
}

function readNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampInt(value, min, max) {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) {
    return min;
  }
  return Math.min(max, Math.max(min, rounded));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringField(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function isLoopbackHost(value) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(value ?? "").toLowerCase());
}

function mergeOptionalSelection(previous, next) {
  if (!Array.isArray(previous)) return Array.isArray(next) ? [...new Set(next)] : undefined;
  if (!Array.isArray(next)) return [...new Set(previous)];
  return [...new Set([...previous, ...next])];
}

function playbackUpdateKey(blockId, targetId) {
  return `${blockId}\u001f${targetId}`;
}

function aggregateUpdateState(updates) {
  if (!updates.length) return "no-targets";
  if (updates.every((update) => update.state === "active")) return "active";
  if (updates.some((update) => update.state === "failed")) return "failed";
  if (updates.every((update) => ["active", "prepared"].includes(update.state))) return "prepared";
  return "saved-not-active";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInstanceId(address) {
  const match = String(address ?? "").match(/\/rnbo\/inst\/([^/]+)/);
  return match ? match[1] : "";
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
