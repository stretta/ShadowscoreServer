import crypto from "node:crypto";

export const REALTIME_PLAYBACK_SCORE_VERSION = 1;

export function createRealtimePlaybackParticipantAdapter(options = {}) {
  const getScore = options.getScore;
  const getParticipantRegistry = options.getParticipantRegistry;
  const timers = options.timers ?? globalThis;
  const unrefTimers = options.unrefTimers !== false;
  const prepareTimeoutMs = Math.max(250, Number(options.prepareTimeoutMs) || 5_000);
  const sessions = new Map();
  const sessionsByConnectionId = new Map();
  const pending = new Map();
  const prepared = new Map();
  let closed = false;

  return {
    enabled: true,
    connectSession,
    disconnectSession,
    prepareBlock,
    acceptReady,
    snapshot,
    close
  };

  function connectSession(session = {}) {
    if (closed) throw adapterError("PLAYBACK_ADAPTER_CLOSED", "realtime playback adapter is closed");
    const participantId = requiredIdentifier(session.participantId ?? session.participant_id, "participant_id");
    const connectionId = requiredIdentifier(session.connectionId ?? session.connection_id, "connection_id");
    const descriptor = {
      participantId,
      connectionId,
      clientId: requiredIdentifier(session.clientId ?? session.client_id, "client_id"),
      declaredCapabilities: [...new Set(session.declaredCapabilities ?? session.declared_capabilities ?? [])],
      send: session.send
    };
    if (typeof descriptor.send !== "function") throw adapterError("PLAYBACK_SEND_UNAVAILABLE", "participant send function is required");
    const previous = sessions.get(participantId);
    sessions.set(participantId, descriptor);
    sessionsByConnectionId.set(connectionId, participantId);
    if (previous && previous.connectionId !== connectionId) {
      sessionsByConnectionId.delete(previous.connectionId);
      prepared.delete(participantId);
      rejectPendingForConnection(
        previous.connectionId,
        adapterError("PLAYBACK_PARTICIPANT_REPLACED", `participant '${participantId}' reconnected before READY`)
      );
    }
    return sessionSnapshot(descriptor);
  }

  function disconnectSession(connectionIdValue) {
    const connectionId = String(connectionIdValue ?? "").trim();
    const participantId = sessionsByConnectionId.get(connectionId);
    if (!participantId) return false;
    sessionsByConnectionId.delete(connectionId);
    const session = sessions.get(participantId);
    if (session?.connectionId === connectionId) sessions.delete(participantId);
    if (session?.connectionId === connectionId) prepared.delete(participantId);
    rejectPendingForConnection(connectionId, adapterError("PLAYBACK_PARTICIPANT_DISCONNECTED", `participant '${participantId}' disconnected`));
    return session?.connectionId === connectionId;
  }

  async function prepareBlock(blockIdValue, reason = "prepare", operationOptions = {}) {
    if (closed) throw adapterError("PLAYBACK_ADAPTER_CLOSED", "realtime playback adapter is closed");
    if (typeof getScore !== "function") throw adapterError("PLAYBACK_SCORE_UNAVAILABLE", "score source is unavailable");
    const blockId = requiredIdentifier(blockIdValue, "block_id");
    const operationId = requiredIdentifier(operationOptions.operationId ?? operationOptions.operation_id, "operation_id");
    const score = getScore();
    const selections = selectedSoftwareParticipants(score, operationOptions);
    const available = selections.filter((selection) => selection.session);
    const unavailable = selections.filter((selection) => !selection.session);
    const acknowledgements = await Promise.all(available.map((selection) => prepareOne({
      blockId,
      operationId,
      reason,
      score,
      ...selection
    })));
    return {
      adapter: "websocket-json",
      operationId,
      blockId,
      participating: available.length > 0,
      participatingParticipantIds: available.map((selection) => selection.participantId),
      unavailableParticipantIds: unavailable.map((selection) => selection.participantId),
      degraded: unavailable.length > 0,
      acknowledgements
    };
  }

  function acceptReady(input = {}) {
    const participantId = requiredIdentifier(input.participantId ?? input.participant_id, "participant_id");
    const connectionId = requiredIdentifier(input.connectionId ?? input.connection_id, "connection_id");
    const payload = input.payload ?? {};
    const operationId = requiredIdentifier(payload.operation_id, "operation_id");
    const key = pendingKey(participantId, operationId);
    const request = pending.get(key);
    if (!request || request.connectionId !== connectionId) {
      throw adapterError("PLAYBACK_READY_NOT_EXPECTED", `no prepare operation '${operationId}' is pending for '${participantId}'`);
    }
    const mismatches = [
      ["block_id", payload.block_id, request.blockId],
      ["score_revision", payload.score_revision, request.scoreRevision],
      ["payload_hash", payload.payload_hash, request.payloadHash]
    ].filter(([, actual, expected]) => actual !== expected);
    if (mismatches.length) {
      throw adapterError(
        "PLAYBACK_READY_MISMATCH",
        `READY does not match ${mismatches.map(([field]) => field).join(", ")}`
      );
    }
    const acknowledgement = {
      participantId,
      operationId,
      blockId: request.blockId,
      voiceIds: [...request.voiceIds],
      scoreRevision: request.scoreRevision,
      payloadHash: request.payloadHash,
      status: "ready"
    };
    prepared.set(participantId, acknowledgement);
    settlePending(key, null, acknowledgement);
    return {
      accepted: true,
      participant_id: participantId,
      operation_id: operationId,
      block_id: request.blockId,
      voice_ids: [...request.voiceIds],
      score_revision: request.scoreRevision,
      payload_hash: request.payloadHash,
      status: "ready"
    };
  }

  function snapshot() {
    return {
      sessions: [...sessions.values()].map(sessionSnapshot),
      pending: [...pending.values()].map((request) => requestSnapshot(request)),
      prepared: [...prepared.values()].map((entry) => structuredClone(entry))
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [key] of pending) settlePending(key, adapterError("PLAYBACK_ADAPTER_CLOSED", "realtime playback adapter is closed"));
    sessions.clear();
    sessionsByConnectionId.clear();
    prepared.clear();
  }

  function selectedSoftwareParticipants(score, operationOptions) {
    const registry = getParticipantRegistry?.();
    if (!registry) return [];
    const resolutions = registry.resolveAssignments(score.assignments ?? {});
    const participantFilter = new Set(operationOptions.participantIds ?? operationOptions.participant_ids ?? []);
    const voiceFilter = new Set(operationOptions.voiceIds ?? operationOptions.voice_ids ?? []);
    const selected = new Map();
    for (const [voiceId, resolution] of Object.entries(resolutions)) {
      const participantId = String(resolution.participant_id ?? "").trim();
      if (!participantId.startsWith("realtime:")) continue;
      if (participantFilter.size && !participantFilter.has(participantId)) continue;
      if (voiceFilter.size && !voiceFilter.has(voiceId)) continue;
      const entry = selected.get(participantId) ?? {
        participantId,
        voiceIds: [],
        session: sessions.get(participantId) ?? null
      };
      entry.voiceIds.push(voiceId);
      selected.set(participantId, entry);
    }
    return [...selected.values()];
  }

  function prepareOne({ participantId, voiceIds, session, blockId, operationId, reason, score }) {
    if (!session.declaredCapabilities.includes("score:prepare")) {
      throw adapterError("PLAYBACK_CAPABILITY_REQUIRED", `participant '${participantId}' does not declare score:prepare`);
    }
    const key = pendingKey(participantId, operationId);
    if (pending.has(key)) throw adapterError("PLAYBACK_OPERATION_PENDING", `prepare operation '${operationId}' is already pending for '${participantId}'`);
    const desired = compilePlaybackScore(score, blockId, voiceIds);
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify(desired)).digest("hex");
    const request = {
      participantId,
      connectionId: session.connectionId,
      operationId,
      blockId,
      voiceIds,
      scoreRevision: desired.score_revision,
      payloadHash,
      reason,
      resolve: null,
      reject: null,
      timer: null
    };
    const result = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
    pending.set(key, request);
    request.timer = timers.setTimeout(() => {
      settlePending(key, adapterError("PLAYBACK_READY_TIMEOUT", `participant '${participantId}' did not acknowledge prepare operation '${operationId}'`));
    }, prepareTimeoutMs);
    if (unrefTimers) request.timer?.unref?.();
    try {
      const accepted = session.send({
        type: "playback.prepare",
        payload: {
          score_contract_version: REALTIME_PLAYBACK_SCORE_VERSION,
          operation_id: operationId,
          participant_id: participantId,
          block_id: blockId,
          voice_ids: [...voiceIds],
          score_revision: desired.score_revision,
          payload_hash: payloadHash,
          reason,
          desired
        }
      });
      if (accepted === false) {
        settlePending(key, adapterError("PLAYBACK_SEND_UNAVAILABLE", `participant '${participantId}' cannot receive prepare commands`));
      }
    } catch (error) {
      settlePending(key, error);
    }
    return result;
  }

  function settlePending(key, error, value) {
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key);
    timers.clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(value);
  }

  function rejectPendingForConnection(connectionId, error) {
    for (const [key, request] of pending) {
      if (request.connectionId === connectionId) settlePending(key, error);
    }
  }
}

export function compilePlaybackScore(score, blockId, voiceIdsValue) {
  const block = score.mesostructure?.[blockId];
  if (!block) throw adapterError("PLAYBACK_BLOCK_NOT_FOUND", `unknown playback block '${blockId}'`);
  const voiceIds = [...new Set((Array.isArray(voiceIdsValue) ? voiceIdsValue : [voiceIdsValue])
    .map((value) => requiredIdentifier(value, "voice_id")))];
  const voices = voiceIds.map((voiceId) => {
    const player = block.players?.[voiceId];
    if (!player) throw adapterError("PLAYBACK_VOICE_NOT_IN_BLOCK", `voice '${voiceId}' is not present in block '${blockId}'`);
    const clipId = typeof player === "string" ? player : String(player.clipId ?? "").trim();
    const clip = clipId ? score.clips?.[clipId] : null;
    if (!clip) throw adapterError("PLAYBACK_CLIP_NOT_FOUND", `voice '${voiceId}' has no playable clip in block '${blockId}'`);
    return {
      voice_id: voiceId,
      player: structuredClone(player),
      clip: {
        clip_id: clipId,
        ...structuredClone(clip)
      }
    };
  });
  return {
    schema: "shadowscore.playback-score.v1",
    score_revision: score.scoreRevision ?? score.version ?? 0,
    structure_revision: score.structureRevision ?? 0,
    ensemble_id: String(score.ensembleId ?? ""),
    block_id: blockId,
    voice_ids: voiceIds,
    context: structuredClone(score.context ?? {}),
    block: {
      tempo: block.tempo ?? null,
      duration: structuredClone(block.duration ?? {}),
      scale: structuredClone(block.scale ?? {}),
      ttid: block.ttid ?? null,
      swing: block.swing ?? null,
      swingAmt: block.swingAmt ?? null
    },
    voices
  };
}

function pendingKey(participantId, operationId) {
  return `${participantId}\u001f${operationId}`;
}

function sessionSnapshot(session) {
  return {
    participantId: session.participantId,
    connectionId: session.connectionId,
    clientId: session.clientId,
    declaredCapabilities: [...session.declaredCapabilities]
  };
}

function requestSnapshot(request) {
  return {
    participantId: request.participantId,
    connectionId: request.connectionId,
    operationId: request.operationId,
    blockId: request.blockId,
    voiceIds: [...request.voiceIds],
    scoreRevision: request.scoreRevision,
    payloadHash: request.payloadHash,
    reason: request.reason
  };
}

function requiredIdentifier(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw adapterError("PLAYBACK_INVALID_MESSAGE", `${field} is required`);
  return normalized;
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
