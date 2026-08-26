export async function mapWithConcurrency(items, requestedLimit, mapper, options = {}) {
  const values = Array.from(items ?? []);
  if (values.length === 0) return [];
  if (typeof mapper !== "function") throw new TypeError("mapper must be a function");
  const limit = Math.min(values.length, clampInt(requestedLimit, 1, 1, 64));
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const queuedAt = now();
  const results = new Array(values.length);
  const errors = new Array(values.length);
  let nextIndex = 0;

  async function runWorker(workerSlot) {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const scheduling = {
        limit,
        cohortSize: values.length,
        workerSlot,
        queuedDurationMs: Math.max(0, now() - queuedAt)
      };
      try {
        results[index] = await mapper(values[index], index, scheduling);
      } catch (error) {
        errors[index] = error;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, (_, workerSlot) => runWorker(workerSlot)));
  const firstError = errors.find(Boolean);
  if (firstError) throw firstError;
  return results;
}

function clampInt(value, fallback, min, max) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
