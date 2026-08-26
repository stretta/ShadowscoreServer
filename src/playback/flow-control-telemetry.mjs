export function createEventLoopBacklogSampler(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const wait = typeof options.wait === "function"
    ? options.wait
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  let sampleCount = 0;
  let totalBacklogMs = 0;
  let maxBacklogMs = 0;

  return {
    async pace(delayMs) {
      const requestedDelayMs = Math.max(0, Number(delayMs) || 0);
      const startedAt = now();
      await wait(requestedDelayMs);
      const elapsedMs = Math.max(0, now() - startedAt);
      const backlogMs = Math.max(0, elapsedMs - requestedDelayMs);
      sampleCount += 1;
      totalBacklogMs += backlogMs;
      maxBacklogMs = Math.max(maxBacklogMs, backlogMs);
      return backlogMs;
    },
    snapshot() {
      return {
        sampleCount,
        meanMs: sampleCount > 0 ? totalBacklogMs / sampleCount : 0,
        maxMs: maxBacklogMs
      };
    }
  };
}
