const DEFAULT_POLL_INTERVAL_MS = 125;
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_STALE_AFTER_MS = 750;
const DEFAULT_MOTION_STALE_AFTER_MS = 1500;

export function createRnboStageCollector(config = {}, options = {}) {
  const settings = collectorSettings(config);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const scheduleInterval = options.setInterval ?? globalThis.setInterval;
  const cancelInterval = options.clearInterval ?? globalThis.clearInterval;
  const observations = new Map();
  let targets = [];
  let timer;
  let refreshPromise;

  return {
    settings,
    updateTargets(nextTargets = []) {
      targets = pollableTargets(nextTargets);
      if (!timer && options.autoStart !== false && targets.length && settings.pollIntervalMs > 0) {
        timer = scheduleInterval(() => void this.refresh(), settings.pollIntervalMs);
        timer?.unref?.();
      }
    },
    refresh(nextTargets) {
      if (nextTargets) this.updateTargets(nextTargets);
      if (refreshPromise) return refreshPromise;
      refreshPromise = pollTargets(targets, fetchImpl, now, settings, observations)
        .finally(() => { refreshPromise = undefined; });
      return refreshPromise;
    },
    ensureObservations(nextTargets = []) {
      this.updateTargets(nextTargets);
      const missingObservation = targets.some((target) => !observations.has(target.id));
      if (settings.pollIntervalMs <= 0 || missingObservation) return this.refresh();
      return refreshPromise ?? Promise.resolve();
    },
    targets(nextTargets = []) {
      this.updateTargets(nextTargets);
      const observedAt = now();
      return nextTargets.map((target) => withObservation(target, observations.get(target.id), observedAt, settings));
    },
    snapshot() {
      const observedAt = now();
      return Object.fromEntries([...observations].map(([targetId, observation]) => [
        targetId,
        observationSnapshot(observation, observedAt, settings)
      ]));
    },
    close() {
      if (timer) cancelInterval(timer);
      timer = undefined;
    }
  };
}

export function rnboCurrentStageUrl(target = {}) {
  const path = String(target.currentStagePath ?? "").trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(target.oscQueryUrl ?? "").trim();
  if (base) return new URL(path, ensureTrailingSlash(base)).toString();
  const host = String(target.host ?? "").trim();
  if (!host) return "";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:5678${path.startsWith("/") ? path : `/${path}`}`;
}

async function pollTargets(targets, fetchImpl, now, settings, observations) {
  if (typeof fetchImpl !== "function") return;
  await Promise.all(targets.map(async (target) => {
    const url = rnboCurrentStageUrl(target);
    if (!url) return;
    const requestedAt = now();
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(settings.timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const currentStage = firstFiniteNumber(body?.VALUE);
      if (currentStage === null) throw new Error("current_stage VALUE is unavailable");
      const previous = observations.get(target.id);
      const changed = Number.isFinite(previous?.currentStage) && previous.currentStage !== currentStage;
      const observedAt = now();
      observations.set(target.id, {
        targetId: target.id,
        url,
        currentStage,
        observedAt,
        requestedAt,
        sampleCount: (previous?.sampleCount ?? 0) + 1,
        changedAt: changed ? observedAt : previous?.changedAt ?? null,
        status: "fresh",
        error: ""
      });
    } catch (error) {
      const previous = observations.get(target.id);
      observations.set(target.id, {
        ...(previous ?? { targetId: target.id, url, currentStage: null, observedAt: null }),
        requestedAt,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }));
}

function withObservation(target, observation, now, settings) {
  if (!observation) return target;
  const state = observationSnapshot(observation, now, settings);
  return {
    ...target,
    ...(state.currentStage === null ? {} : { currentStage: state.currentStage }),
    stateObservedAt: state.observedAt,
    stateAgeMs: state.ageMs,
    stageChangedAt: state.changedAt,
    stageMovement: state.movement,
    stageReadbackStatus: state.status,
    stageReadbackError: state.error
  };
}

function observationSnapshot(observation, now, settings) {
  const ageMs = observation.observedAt === null ? null : Math.max(0, now - observation.observedAt);
  const stale = ageMs === null || ageMs > settings.staleAfterMs;
  const changedAgeMs = observation.changedAt === null ? null : Math.max(0, now - observation.changedAt);
  const movement = observation.sampleCount < 2 || observation.changedAt === null
    ? "unknown"
    : changedAgeMs <= settings.motionStaleAfterMs ? "moving" : "stopped";
  return {
    targetId: observation.targetId,
    url: observation.url,
    currentStage: observation.currentStage,
    observedAt: observation.observedAt === null ? null : new Date(observation.observedAt).toISOString(),
    ageMs,
    changedAt: observation.changedAt === null ? null : new Date(observation.changedAt).toISOString(),
    changedAgeMs,
    movement,
    fresh: observation.status === "fresh" && !stale,
    stale,
    status: stale ? "stale" : observation.status,
    error: observation.error
  };
}

function pollableTargets(targets) {
  const unique = new Map();
  for (const target of targets) {
    if (target?.id && rnboCurrentStageUrl(target) && target.available !== false) unique.set(target.id, target);
  }
  return [...unique.values()];
}

function firstFiniteNumber(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

function collectorSettings(config) {
  const source = config.transport?.rnboClient ?? {};
  return {
    pollIntervalMs: nonNegative(source.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: positive(source.timeoutMs, DEFAULT_TIMEOUT_MS),
    staleAfterMs: nonNegative(source.staleAfterMs, DEFAULT_STALE_AFTER_MS),
    motionStaleAfterMs: nonNegative(
      source.motionStaleAfterMs,
      Math.max(DEFAULT_MOTION_STALE_AFTER_MS, nonNegative(source.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS) * 4)
    )
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
