export function createPlaybackUpdateState(options = {}) {
  const now = options.now ?? Date.now;
  const records = new Map();
  const availability = new Map();

  return {
    get(blockId, targetId) {
      return records.get(updateKey(blockId, targetId));
    },
    values() {
      return [...records.values()];
    },
    availability(targetId) {
      return availability.get(targetId);
    },
    availabilityValues() {
      return [...availability.values()];
    },
    observeAvailability(update) {
      availability.set(update.targetId, {
        available: update.state !== "unavailable",
        voiceId: update.voiceId
      });
    },
    recordDelivery(delivery = {}) {
      const blockId = String(delivery.blockId ?? "").trim();
      const targetId = String(delivery.targetId ?? "").trim();
      if (!blockId || !targetId) return null;
      const key = updateKey(blockId, targetId);
      const previous = records.get(key) ?? {};
      if (delivery.prepared) invalidatePreparedSlot(targetId, key);
      const transactionId = delivery.adapterTransactionId ?? null;
      const next = {
        ...previous,
        blockId,
        targetId,
        voiceId: String(delivery.voiceId ?? ""),
        desiredScoreRevision: delivery.desiredScoreRevision ?? previous.desiredScoreRevision ?? null,
        desiredHash: delivery.desiredHash ?? previous.desiredHash ?? null,
        preparedTransaction: delivery.prepared ? transactionId : previous.preparedTransaction ?? null,
        preparedHash: delivery.prepared ? delivery.desiredHash ?? null : previous.preparedHash ?? null,
        activeTransaction: delivery.active ? transactionId : previous.activeTransaction ?? null,
        activeHash: delivery.active ? delivery.desiredHash ?? null : previous.activeHash ?? null,
        state: delivery.active
          ? "active"
          : delivery.prepared
            ? "prepared"
            : delivery.failed
              ? "failed"
              : previous.state ?? "saved-not-active",
        lastError: delivery.failed ? structuredClone(delivery.error ?? null) : null,
        updatedAt: observedAt()
      };
      records.set(key, next);
      return structuredClone(next);
    },
    promote(targetIdValue, adapterTransactionId, acknowledgement) {
      const targetId = String(targetIdValue ?? "").trim();
      for (const [key, state] of records) {
        if (state.targetId !== targetId) continue;
        const promoted = state.preparedTransaction === adapterTransactionId;
        records.set(key, promoted
          ? {
              ...state,
              activeTransaction: adapterTransactionId,
              activeHash: state.preparedHash,
              preparedTransaction: null,
              preparedHash: null,
              state: "active",
              lastError: null,
              activationAcknowledgement: structuredClone(acknowledgement),
              updatedAt: observedAt()
            }
          : {
              ...state,
              activeTransaction: null,
              activeHash: null,
              preparedTransaction: null,
              preparedHash: null,
              state: "saved-not-active",
              updatedAt: observedAt()
            });
      }
    },
    markDesired(impact, matches) {
      for (const [key, state] of records) {
        if (!matches(state)) continue;
        records.set(key, {
          ...state,
          desiredScoreRevision: impact.scoreRevision,
          desiredHash: null,
          state: "saved-not-active",
          lastImpact: structuredClone(impact)
        });
      }
    },
    hasVoice(blockId, voiceId) {
      return [...records.values()].some((state) => state.blockId === blockId && state.voiceId === voiceId);
    },
    cached(blockId) {
      return Object.fromEntries(
        [...records.values()]
          .filter((state) => state.blockId === blockId)
          .map((state) => [state.targetId, structuredClone(state)])
      );
    },
    clear() {
      records.clear();
      availability.clear();
    }
  };

  function invalidatePreparedSlot(targetId, retainedKey) {
    for (const [key, state] of records) {
      if (key === retainedKey || state.targetId !== targetId || !Number.isInteger(state.preparedTransaction)) continue;
      records.set(key, {
        ...state,
        preparedTransaction: null,
        preparedHash: null,
        state: Number.isInteger(state.activeTransaction) ? "active" : "saved-not-active",
        updatedAt: observedAt()
      });
    }
  }

  function observedAt() {
    return new Date(now()).toISOString();
  }
}

export function summarizePlaybackUpdates(updates = []) {
  const participating = updates.filter((update) => update.state !== "unavailable");
  const unavailable = updates.filter((update) => update.state === "unavailable");
  const affected = participating.filter((update) => update.state !== "active");
  return {
    state: aggregatePlaybackUpdateState(updates),
    affectedTargetCount: affected.length,
    preparedTargetCount: updates.filter((update) => update.state === "prepared").length,
    activeTargetCount: updates.filter((update) => update.state === "active").length,
    participatingTargetCount: participating.length,
    unavailableTargetCount: unavailable.length,
    unavailableTargetIds: unavailable.map((update) => update.targetId),
    degraded: unavailable.length > 0
  };
}

export function aggregatePlaybackUpdateState(updates = []) {
  const participating = updates.filter((update) => update.state !== "unavailable");
  if (!participating.length) return "no-targets";
  if (participating.every((update) => update.state === "active")) return "active";
  if (participating.some((update) => update.state === "failed")) return "failed";
  if (participating.every((update) => ["active", "prepared"].includes(update.state))) return "prepared";
  return "saved-not-active";
}

function updateKey(blockId, targetId) {
  return `${blockId}\u001f${targetId}`;
}
