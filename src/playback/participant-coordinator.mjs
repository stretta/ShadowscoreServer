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
          lifecycleEvents: typeof adapter?.lifecycleEvents === "function",
          deliveryStatus: typeof adapter?.transferStatus === "function",
          operationQueueStatus: typeof adapter?.sendQueueStatus === "function"
        }
      };
    },
    async playbackUpdates(blockId = "", readOptions = {}) {
      return requireMethod("playbackUpdates")(blockId, readOptions);
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
