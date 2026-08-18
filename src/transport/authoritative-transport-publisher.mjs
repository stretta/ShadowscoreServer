export function createAuthoritativeTransportPublisher(loadSnapshot, options = {}) {
  const timers = options.timers ?? globalThis;
  const intervalMs = Math.max(100, Number(options.intervalMs) || 500);
  const subscribers = new Set();
  let timer;
  let latest = null;
  let pending = null;

  return {
    current() {
      return latest ? Promise.resolve(latest) : refresh();
    },
    refresh,
    subscribe(observer) {
      subscribers.add(observer);
      if (timer === undefined) {
        timer = timers.setInterval(() => void refresh().catch(() => {}), intervalMs);
        timer?.unref?.();
      }
      return () => {
        subscribers.delete(observer);
        if (!subscribers.size && timer !== undefined) {
          timers.clearInterval(timer);
          timer = undefined;
        }
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
    close() {
      subscribers.clear();
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
    }
  };

  function refresh() {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(loadSnapshot)
      .then((snapshot) => {
        latest = snapshot;
        for (const observer of subscribers) observer.snapshot?.(snapshot);
        return snapshot;
      })
      .catch((error) => {
        for (const observer of subscribers) observer.error?.(error);
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
}
