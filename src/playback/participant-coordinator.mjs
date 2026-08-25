export function createPlaybackParticipantCoordinator(options = {}) {
  const adapter = options.adapter ?? null;
  const adapterId = String(options.adapterId ?? "playback").trim() || "playback";

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
          applyBlockUpdate: typeof adapter?.applyBlockUpdate === "function",
          activatePreparedBlock: typeof adapter?.activatePreparedBlock === "function",
          lifecycleEvents: typeof adapter?.lifecycleEvents === "function",
          deliveryStatus: typeof adapter?.transferStatus === "function",
          operationQueueStatus: typeof adapter?.sendQueueStatus === "function"
        }
      };
    },
    async playbackUpdates(blockId = "", readOptions = {}) {
      return requireMethod("playbackUpdates")(blockId, readOptions);
    },
    async prepareBlock(blockId, reason = "lookahead", operationOptions = {}) {
      return requireMethod("prepareBlock")(blockId, reason, operationOptions);
    },
    async applyBlockUpdate(blockId = "", operationOptions = {}) {
      return requireMethod("applyBlockUpdate")(blockId, operationOptions);
    },
    async activatePreparedBlock(blockId = "", operationOptions = {}) {
      const activate = optionalMethod("activatePreparedBlock");
      return activate
        ? activate(blockId, operationOptions)
        : requireMethod("applyBlockUpdate")(blockId, {
            activationMode: "continue",
            boundary: "next-cycle",
            reusePrepared: true,
            ...operationOptions
          });
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
