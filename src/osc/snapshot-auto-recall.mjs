export function createOscSnapshotAutoRecall(store, options = {}) {
  if (!store?.events?.on || typeof options.recall !== "function") {
    throw new Error("automatic OSC snapshot recall requires a score store and recall callback");
  }
  let lastEntryKey = entryKey(store.getScore()?.structureState);
  let pendingCount = 0;
  let last = null;
  let queue = Promise.resolve();

  const onChange = (event) => {
    const structureState = event.score?.structureState ?? event.detail?.structureState;
    const nextEntryKey = entryKey(structureState);
    if (!nextEntryKey || nextEntryKey === lastEntryKey) return;
    lastEntryKey = nextEntryKey;
    const request = {
      blockId: structureState.activeBlockId,
      macroIndex: structureState.macroIndex ?? 0,
      sourceClientId: event.sourceClientId ?? "",
      scoreVersion: event.score?.scoreRevision ?? event.score?.version ?? null,
      queuedAt: new Date().toISOString()
    };
    pendingCount += 1;
    queue = queue.then(() => runRecall(request), () => runRecall(request));
  };

  store.events.on("change", onChange);

  return {
    snapshot() {
      return { pending: pendingCount > 0, pendingCount, lastEntryKey, last };
    },
    async flush() {
      await queue;
      return this.snapshot();
    },
    close() {
      store.events.off("change", onChange);
    }
  };

  async function runRecall(request) {
    const startedAt = new Date().toISOString();
    try {
      const result = await options.recall(request);
      last = {
        ok: result?.ok !== false,
        ...request,
        startedAt,
        completedAt: new Date().toISOString(),
        recallId: result?.id ?? "",
        durationMs: result?.durationMs ?? 0,
        dispatchDurationMs: result?.dispatchDurationMs ?? 0,
        attemptedWriteCount: result?.attemptedWriteCount ?? 0,
        plannedPacketBytes: result?.plannedPacketBytes ?? 0,
        attemptedPacketBytes: result?.attemptedPacketBytes ?? 0,
        failedWriteCount: result?.failedWriteCount ?? 0,
        skippedRoleCount: result?.skippedRoleCount ?? 0
      };
    } catch (error) {
      last = {
        ok: false,
        ...request,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error?.message ?? String(error)
      };
      options.onError?.(error, request);
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
    }
  }
}

function entryKey(structureState = {}) {
  const blockId = String(structureState?.activeBlockId ?? "").trim();
  if (!blockId) return "";
  const macroIndex = Number.isFinite(structureState?.macroIndex) ? Math.max(0, Math.floor(structureState.macroIndex)) : 0;
  return `${macroIndex}:${blockId}`;
}
