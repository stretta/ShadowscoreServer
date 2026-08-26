import crypto from "node:crypto";

export function createPlaybackParticipantCoordinator(options = {}) {
  const adapter = options.adapter ?? null;
  const participantAdapters = (options.participantAdapters ?? []).filter((entry) => entry?.enabled === true);
  const adapterId = String(options.adapterId ?? "playback").trim() || "playback";
  const operations = new Map();
  const latestPreparedByBlock = new Map();
  const enrolledParticipantAdapters = new Set(
    (options.enrolledParticipantAdapters ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)
  );

  return {
    get enabled() {
      return adapter?.enabled === true;
    },
    descriptor() {
      return {
        adapterId,
        enabled: adapter?.enabled === true,
        capabilities: {
          playbackUpdates: typeof adapter?.playbackUpdates === "function",
          prepareBlock: typeof adapter?.prepareBlock === "function",
          prepareParticipants: participantAdapters.some((entry) => typeof entry.prepareBlock === "function"),
          activateParticipants: participantAdapters.some((entry) => typeof entry.activatePreparedBlock === "function"),
          participantRuntime: participantAdapters.some((entry) => typeof entry.snapshot === "function"),
          applyBlockUpdate: typeof adapter?.applyBlockUpdate === "function",
          activatePreparedBlock: typeof adapter?.activatePreparedBlock === "function",
          lifecycleEvents: typeof adapter?.lifecycleEvents === "function",
          deliveryStatus: typeof adapter?.transferStatus === "function",
          operationQueueStatus: typeof adapter?.sendQueueStatus === "function",
          orchestratedOperations: true
        }
      };
    },
    async playbackUpdates(blockId = "", readOptions = {}) {
      return requireMethod("playbackUpdates")(blockId, readOptions);
    },
    async prepareBlock(blockId, reason = "lookahead", operationOptions = {}) {
      const operation = await prepareOperation(blockId, reason, operationOptions);
      return operation.primaryResult;
    },
    async prepareParticipants(blockId, reason = "prepare", operationOptions = {}) {
      const adapters = participantAdapters.filter((entry) => typeof entry.prepareBlock === "function");
      if (!adapters.length) throw new Error("playback participant coordinator cannot prepareParticipants");
      const operationId = String(operationOptions.operationId ?? operationOptions.operation_id ?? crypto.randomUUID());
      const results = await Promise.all(adapters.map((entry) => entry.prepareBlock(blockId, reason, {
        ...operationOptions,
        operationId
      })));
      return { operationId, blockId, results };
    },
    async activateParticipants(blockId, operationOptions = {}) {
      const adapters = participantAdapters.filter((entry) => typeof entry.activatePreparedBlock === "function");
      if (!adapters.length) throw new Error("playback participant coordinator cannot activateParticipants");
      const preparedOperationId = String(
        operationOptions.preparedOperationId ?? operationOptions.prepared_operation_id ?? ""
      ).trim();
      if (!preparedOperationId) throw new Error("preparedOperationId is required");
      const operationId = String(operationOptions.operationId ?? operationOptions.operation_id ?? crypto.randomUUID());
      const results = await Promise.all(adapters.map((entry) => entry.activatePreparedBlock(blockId, {
        ...operationOptions,
        operationId,
        preparedOperationId
      })));
      return { operationId, preparedOperationId, blockId, results };
    },
    async applyBlockUpdate(blockId = "", operationOptions = {}) {
      return requireMethod("applyBlockUpdate")(blockId, operationOptions);
    },
    async activatePreparedBlock(blockId = "", operationOptions = {}) {
      const preparedOperationId = String(
        operationOptions.preparedOperationId
        ?? operationOptions.prepared_operation_id
        ?? latestPreparedByBlock.get(blockId)
        ?? ""
      ).trim();
      if (!preparedOperationId) return activatePrimary(blockId, operationOptions);
      const operation = await activateOperation(blockId, { ...operationOptions, preparedOperationId });
      return operation.primaryResult;
    },
    prepareOperation,
    activateOperation,
    operationStatus(operationId = "") {
      const operation = operations.get(String(operationId ?? "").trim());
      return operation ? structuredClone(operation) : null;
    },
    schedulePreparedActivations(operationOptions = {}) {
      return optionalMethod("schedulePreparedActivations")?.(operationOptions) ?? [];
    },
    async confirmPreparedActivations(requests = [], operationOptions = {}) {
      const confirm = optionalMethod("confirmPreparedActivations");
      return confirm ? confirm(requests, operationOptions) : [];
    },
    lifecycleEvents() {
      return adapter?.lifecycleEvents?.() ?? [];
    },
    deliveryStatus() {
      return adapter?.transferStatus?.() ?? emptyDeliveryStatus();
    },
    participantDeliveryStatus() {
      return adapter?.sendStatus?.() ?? [];
    },
    participantRuntimeStatus() {
      return participantAdapters
        .filter((entry) => typeof entry.snapshot === "function")
        .map((entry) => entry.snapshot());
    },
    operationQueueStatus() {
      return adapter?.sendQueueStatus?.() ?? emptyOperationQueueStatus();
    },
    waitForIdle() {
      return adapter?.waitForIdle?.() ?? Promise.resolve(emptyOperationQueueStatus());
    },
    deliveryEvents: adapter?.transferEvents
  };

  function requireMethod(name) {
    if (adapter?.enabled !== true || typeof adapter?.[name] !== "function") {
      throw new Error(`playback participant coordinator cannot ${name}`);
    }
    return adapter[name].bind(adapter);
  }

  function optionalMethod(name) {
    return adapter?.enabled === true && typeof adapter?.[name] === "function"
      ? adapter[name].bind(adapter)
      : null;
  }

  async function prepareOperation(blockIdValue, reason = "prepare", operationOptions = {}) {
    const blockId = requiredValue(blockIdValue, "blockId");
    const operationId = String(operationOptions.operationId ?? operationOptions.operation_id ?? crypto.randomUUID());
    const partitions = operationPartitions();
    if (!partitions.some((partition) => partition.enrolled)) {
      throw new Error("playback participant coordinator cannot prepareBlock");
    }
    const record = {
      operationId,
      kind: "prepare",
      blockId,
      state: "preparing",
      createdAt: new Date().toISOString(),
      partitions: partitions.map(({ adapter: _adapter, ...partition }) => ({ ...partition, state: partition.enrolled ? "pending" : "excluded" }))
    };
    rememberOperation(record);
    const settled = await Promise.allSettled(partitions.filter((partition) => partition.enrolled).map(async (partition) => {
      const result = partition.primary
        ? await requireMethod("prepareBlock")(blockId, reason, { ...operationOptions, operationId })
        : await partition.adapter.prepareBlock(blockId, reason, { ...operationOptions, operationId });
      const evidence = normalizePreparationEvidence(partition.adapterId, result);
      updatePartition(record, partition.adapterId, { state: evidence.state, participantIds: evidence.participantIds, evidence });
      return { partition, result, evidence };
    }));
    const results = settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
    const rejected = settled.filter((entry) => entry.status === "rejected");
    const invalid = results.filter(({ evidence }) => !["ready", "active", "empty"].includes(evidence.state));
    if (rejected.length || invalid.length) {
      record.state = "failed";
      record.error = rejected[0]?.reason?.message ?? "incomplete READY evidence";
      record.rollback = await rollbackPreparedPartitions(results.map(({ partition }) => partition), blockId, { ...operationOptions, operationId });
      const error = rejected[0]?.reason ?? new Error(`playback prepare operation '${operationId}' did not reach READY: ${invalid.map(({ partition }) => partition.adapterId).join(", ")}`);
      error.code ??= "PLAYBACK_PREPARE_INCOMPLETE";
      error.operation = structuredClone(record);
      throw error;
    }
    record.state = "ready";
    record.completedAt = new Date().toISOString();
    record.preparedOperationId = operationId;
    latestPreparedByBlock.set(blockId, operationId);
    const primary = results.find(({ partition }) => partition.primary);
    return { ...structuredClone(record), primaryResult: primary?.result };
  }

  async function activateOperation(blockIdValue, operationOptions = {}) {
    const blockId = requiredValue(blockIdValue, "blockId");
    const preparedOperationId = requiredValue(
      operationOptions.preparedOperationId ?? operationOptions.prepared_operation_id,
      "preparedOperationId"
    );
    const preparedRecord = operations.get(preparedOperationId);
    if (!preparedRecord || preparedRecord.state !== "ready" || preparedRecord.blockId !== blockId) {
      const error = new Error(`prepare operation '${preparedOperationId}' is not READY for block '${blockId}'`);
      error.code = "PLAYBACK_ACTIVATION_NOT_READY";
      throw error;
    }
    const operationId = String(operationOptions.operationId ?? operationOptions.operation_id ?? crypto.randomUUID());
    const record = {
      operationId,
      preparedOperationId,
      kind: "activate",
      blockId,
      state: "activating",
      createdAt: new Date().toISOString(),
      partitions: structuredClone(preparedRecord.partitions)
    };
    rememberOperation(record);
    const activated = [];
    let primaryResult;
    try {
      for (const preparedPartition of preparedRecord.partitions.filter((partition) => partition.enrolled)) {
        const partition = operationPartitions().find((entry) => entry.adapterId === preparedPartition.adapterId);
        if (!partition) throw new Error(`playback adapter '${preparedPartition.adapterId}' is no longer available`);
        const scopedOptions = {
          ...operationOptions,
          operationId,
          preparedOperationId,
          ...(preparedPartition.participantIds.length && !operationOptions.targetIds && partition.primary
            ? { targetIds: preparedPartition.participantIds }
            : {})
        };
        const result = partition.primary
          ? await activatePrimary(blockId, scopedOptions)
          : await partition.adapter.activatePreparedBlock(blockId, scopedOptions);
        const evidence = normalizeActivationEvidence(partition.adapterId, result, preparedPartition.participantIds);
        if (!["active", "empty"].includes(evidence.state)) {
          throw Object.assign(new Error(`playback adapter '${partition.adapterId}' did not reach ACTIVE`), { code: "PLAYBACK_ACTIVATION_INCOMPLETE" });
        }
        updatePartition(record, partition.adapterId, { state: evidence.state, evidence });
        activated.push(partition);
        if (partition.primary) primaryResult = result;
      }
      record.state = "active";
      record.completedAt = new Date().toISOString();
      latestPreparedByBlock.delete(blockId);
      return { ...structuredClone(record), primaryResult };
    } catch (error) {
      record.state = "failed";
      record.error = error.message;
      record.rollback = await rollbackPartitions(activated, blockId, { ...operationOptions, operationId, preparedOperationId });
      error.operation = structuredClone(record);
      throw error;
    }
  }

  function operationPartitions() {
    return [
      { adapterId, adapter, primary: true, enrolled: adapter?.enabled === true },
      ...participantAdapters.map((entry, index) => {
        const id = String(entry.adapterId ?? entry.id ?? entry.snapshot?.().adapter ?? `participant-${index + 1}`);
        return { adapterId: id, adapter: entry, primary: false, enrolled: enrolledParticipantAdapters.has(id) };
      })
    ];
  }

  async function activatePrimary(blockId, operationOptions) {
    const activate = optionalMethod("activatePreparedBlock");
    return activate
      ? activate(blockId, operationOptions)
      : requireMethod("applyBlockUpdate")(blockId, {
          activationMode: "continue",
          boundary: "next-cycle",
          reusePrepared: true,
          ...operationOptions
        });
  }

  async function rollbackPartitions(partitions, blockId, operationOptions) {
    const outcomes = [];
    for (const partition of [...partitions].reverse()) {
      const rollback = partition.adapter?.rollbackBlock ?? partition.adapter?.rollbackPreparedBlock;
      if (typeof rollback !== "function") {
        outcomes.push({ adapterId: partition.adapterId, ok: false, status: "unsupported" });
        continue;
      }
      try {
        outcomes.push({ adapterId: partition.adapterId, ok: true, result: await rollback.call(partition.adapter, blockId, operationOptions) });
      } catch (error) {
        outcomes.push({ adapterId: partition.adapterId, ok: false, status: "failed", error: error.message });
      }
    }
    return outcomes;
  }

  async function rollbackPreparedPartitions(partitions, blockId, operationOptions) {
    const outcomes = [];
    for (const partition of [...partitions].reverse()) {
      const rollback = partition.adapter?.rollbackPreparedBlock;
      if (typeof rollback !== "function") {
        outcomes.push({ adapterId: partition.adapterId, ok: false, status: "unsupported" });
        continue;
      }
      try {
        outcomes.push({ adapterId: partition.adapterId, ok: true, result: await rollback.call(partition.adapter, blockId, operationOptions) });
      } catch (error) {
        outcomes.push({ adapterId: partition.adapterId, ok: false, status: "failed", error: error.message });
      }
    }
    return outcomes;
  }

  function rememberOperation(record) {
    operations.set(record.operationId, record);
    while (operations.size > 128) operations.delete(operations.keys().next().value);
  }

  function updatePartition(record, partitionId, update) {
    const partition = record.partitions.find((entry) => entry.adapterId === partitionId);
    if (partition) Object.assign(partition, update);
  }
}

function normalizePreparationEvidence(adapterId, result = {}) {
  const participantIds = resultParticipantIds(result);
  const states = resultStates(result);
  const state = result.state === "active" || states.includes("active")
    ? "active"
    : result.participating === false || (Array.isArray(result.targets) && result.targets.length === 0)
      ? "empty"
      : result.prepared === true || result.state === "prepared" || (states.length > 0 && states.every((value) => ["prepared", "ready", "active"].includes(value)))
      ? participantIds.length ? "ready" : "empty"
      : "failed";
  return { adapterId, state, participantIds, result: structuredClone(result) };
}

function normalizeActivationEvidence(adapterId, result = {}, expectedParticipantIds = []) {
  const participantIds = resultParticipantIds(result);
  const states = resultStates(result);
  const state = result.participating === false
    ? "empty"
    : result.state === "active" || result.action === "active" || (states.length > 0 && states.every((value) => value === "active"))
    ? (expectedParticipantIds.length || participantIds.length ? "active" : "empty")
    : "failed";
  return { adapterId, state, participantIds: participantIds.length ? participantIds : [...expectedParticipantIds], result: structuredClone(result) };
}

function resultParticipantIds(result = {}) {
  if (Array.isArray(result.participatingParticipantIds)) return [...result.participatingParticipantIds];
  if (Array.isArray(result.targets)) return result.targets.map((entry) => entry?.target?.id ?? entry?.compiled?.targetId).filter(Boolean);
  if (result.targets && typeof result.targets === "object") {
    return Object.entries(result.targets).filter(([, entry]) => entry?.state !== "unavailable").map(([id]) => id);
  }
  if (result.targetId) return [result.targetId];
  return [];
}

function resultStates(result = {}) {
  if (Array.isArray(result.acknowledgements)) return result.acknowledgements.map((entry) => entry?.status ?? "failed");
  if (Array.isArray(result.targets)) return result.targets.map((entry) => entry?.compiled?.ack?.status ?? (entry?.compiled?.reused ? "prepared" : "failed"));
  if (result.targets && typeof result.targets === "object") return Object.values(result.targets).map((entry) => entry?.state ?? "failed");
  if (result.ack) return [result.ack.status ?? (result.ack.ok === true ? "prepared" : "failed")];
  return [];
}

function requiredValue(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function emptyOperationQueueStatus() {
  return {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  };
}

function emptyDeliveryStatus() {
  return {
    observedAt: new Date().toISOString(),
    summary: {
      targetCount: 0,
      inProgressCount: 0,
      readyCount: 0,
      liveCount: 0,
      failedCount: 0
    },
    targets: {},
    history: []
  };
}
