export function createPlaybackLifecycleHistory(options = {}) {
  const limit = Math.max(1, Number(options.limit) || 200);
  const events = [];

  return {
    record(event) {
      const recorded = structuredClone(event);
      events.push(recorded);
      if (events.length > limit) events.splice(0, events.length - limit);
      return structuredClone(recorded);
    },
    snapshot() {
      return structuredClone(events);
    },
    clear() {
      events.length = 0;
    }
  };
}
