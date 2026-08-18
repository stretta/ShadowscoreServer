export function createEnsembleSyncSupervisor(options = {}) {
  const requiredConsecutiveSlips = positiveInteger(options.requiredConsecutiveSlips, 3);
  const cooldownMs = nonNegativeNumber(options.cooldownMs, 60000);
  const now = options.now ?? Date.now;
  let consecutiveSlips = 0;
  let inProgress = false;
  let lastAttemptAt = null;
  let lastResult = null;

  return {
    observe(health = {}) {
      const observedAt = now();
      if (health.state !== "slipped") {
        consecutiveSlips = 0;
        return snapshot(observedAt, false, health);
      }
      consecutiveSlips += 1;
      const cooldownRemainingMs = lastAttemptAt === null
        ? 0
        : Math.max(0, cooldownMs - (observedAt - lastAttemptAt));
      const trigger = !inProgress
        && consecutiveSlips >= requiredConsecutiveSlips
        && cooldownRemainingMs === 0;
      return snapshot(observedAt, trigger, health);
    },
    begin() {
      if (inProgress) return false;
      inProgress = true;
      lastAttemptAt = now();
      consecutiveSlips = 0;
      return true;
    },
    finish(result = {}) {
      inProgress = false;
      lastResult = {
        ok: result.ok !== false,
        at: new Date(now()).toISOString(),
        error: String(result.error ?? "")
      };
      return this.snapshot();
    },
    reset() {
      consecutiveSlips = 0;
      return this.snapshot();
    },
    snapshot() {
      return snapshot(now(), false, null);
    }
  };

  function snapshot(observedAt, trigger, health) {
    const cooldownRemainingMs = lastAttemptAt === null
      ? 0
      : Math.max(0, cooldownMs - (observedAt - lastAttemptAt));
    return {
      enabled: true,
      inProgress,
      consecutiveSlips,
      requiredConsecutiveSlips,
      trigger,
      cooldownMs,
      cooldownRemainingMs,
      lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(),
      lastResult,
      observedState: health?.state ?? null,
      observedSkewBeats: finiteOrNull(health?.max_client_skew_beats)
    };
  }
}

export function phaseStageAtBeat({ beatIntoBlock, stagesPerBeat, patternLength } = {}) {
  const beat = Number(beatIntoBlock);
  const resolution = Number(stagesPerBeat);
  const length = Math.max(1, Math.trunc(Number(patternLength)));
  if (!Number.isFinite(beat) || !Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(length)) {
    return 0;
  }
  return positiveModulo(Math.floor(beat * resolution), length);
}

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
