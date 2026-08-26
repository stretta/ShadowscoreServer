function notify(observer, message) {
  if (typeof observer === "function") {
    observer(message);
    return;
  }
  observer?.message?.(message);
  if (message.event === "snapshot") observer?.snapshot?.(message.payload);
  if (message.event === "error") observer?.error?.(message.payload);
}

export function createLoadedPublisher(loadSnapshot, options = {}) {
  const timers = options.timers ?? globalThis;
  const intervalMs = options.intervalMs === undefined
    ? null
    : Math.max(100, Number(options.intervalMs) || 500);
  const refreshOnCurrent = options.refreshOnCurrent === true;
  const freshnessMs = Math.max(0, Number(options.freshnessMs) || 0);
  const now = options.now ?? Date.now;
  const subscribers = new Set();
  let timer;
  let latest = null;
  let hasLatest = false;
  let pending = null;
  let loadedAtMs = 0;
  const stats = { loadCount: 0, cacheHitCount: 0, coalescedCount: 0 };

  return {
    current() {
      if (pending) {
        stats.coalescedCount += 1;
        return pending;
      }
      const fresh = hasLatest && freshnessMs > 0 && now() - loadedAtMs <= freshnessMs;
      if (hasLatest && (!refreshOnCurrent || fresh)) {
        stats.cacheHitCount += 1;
        return Promise.resolve(latest);
      }
      return refresh();
    },
    refresh,
    stats() {
      return {
        ...stats,
        hasLatest,
        freshnessMs,
        latestAgeMs: hasLatest ? Math.max(0, now() - loadedAtMs) : null
      };
    },
    subscribe(observer) {
      subscribers.add(observer);
      if (intervalMs !== null && timer === undefined) {
        timer = timers.setInterval(() => void refresh().catch(() => {}), intervalMs);
        timer?.unref?.();
      }
      return () => {
        subscribers.delete(observer);
        stopTimerWhenIdle();
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

  function stopTimerWhenIdle() {
    if (!subscribers.size && timer !== undefined) {
      timers.clearInterval(timer);
      timer = undefined;
    }
  }

  function refresh() {
    if (pending) {
      stats.coalescedCount += 1;
      return pending;
    }
    pending = Promise.resolve()
      .then(() => {
        stats.loadCount += 1;
        return loadSnapshot();
      })
      .then((snapshot) => {
        latest = snapshot;
        hasLatest = true;
        loadedAtMs = now();
        for (const observer of subscribers) notify(observer, { event: "snapshot", payload: snapshot });
        return snapshot;
      })
      .catch((error) => {
        for (const observer of subscribers) notify(observer, { event: "error", payload: error });
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
}

export function createEventPublisher(options) {
  const subscribers = new Set();
  const source = options.events;
  const sourceEvent = options.sourceEvent ?? "snapshot";
  const mapEvent = options.mapEvent ?? ((payload) => ({ event: sourceEvent, payload }));
  let attached = false;

  return {
    current() {
      return Promise.resolve().then(options.loadSnapshot);
    },
    subscribe(observer) {
      subscribers.add(observer);
      if (!attached && subscribers.size === 1) attach();
      return () => {
        subscribers.delete(observer);
        if (!subscribers.size) detach();
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
    close() {
      subscribers.clear();
      detach();
    }
  };

  function onSourceEvent(payload) {
    const message = mapEvent(payload);
    if (!message) return;
    for (const observer of subscribers) notify(observer, message);
  }

  function attach() {
    source?.on?.(sourceEvent, onSourceEvent);
    attached = true;
  }

  function detach() {
    if (!attached) return;
    source?.off?.(sourceEvent, onSourceEvent);
    attached = false;
  }
}
