const DEFAULT_TARGET_PHASE_BEATS = 0.05;
const DEFAULT_IMMEDIATE_WINDOW_BEATS = 0.15;
const DEFAULT_MAX_DELAY_MS = 2000;

export function planClockArmWindow(transport, options = {}) {
  const latest = transport?.latest;
  if (transport?.fresh !== true || latest?.state !== "rolling") {
    return unavailablePlan("fresh rolling JACK transport is unavailable");
  }
  const absoluteBeat = Number(latest.absoluteBeat);
  const tempo = Number(latest.beatsPerMinute);
  if (!Number.isFinite(absoluteBeat) || !(tempo > 0)) {
    return unavailablePlan("JACK beat position or tempo is unavailable");
  }

  const targetPhaseBeats = boundedFraction(
    options.targetPhaseBeats,
    DEFAULT_TARGET_PHASE_BEATS
  );
  const immediateWindowBeats = Math.max(
    targetPhaseBeats,
    boundedFraction(options.immediateWindowBeats, DEFAULT_IMMEDIATE_WINDOW_BEATS)
  );
  const ageMs = Math.max(0, Number(transport.ageMs) || 0);
  const projectedBeat = absoluteBeat + ageMs * tempo / 60000;
  const observedPhaseBeats = positiveModulo(projectedBeat, 1);
  const beatDurationMs = 60000 / tempo;
  const requiredDelayMs = observedPhaseBeats <= immediateWindowBeats
    ? 0
    : ((1 - observedPhaseBeats) + targetPhaseBeats) * beatDurationMs;
  const maxDelayMs = boundedPositive(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  if (requiredDelayMs > maxDelayMs) {
    return {
      ...unavailablePlan("next safe arm window exceeds the configured delay limit"),
      requiredDelayMs,
      maxDelayMs,
      tempo,
      projectedBeat,
      observedPhaseBeats,
      targetPhaseBeats,
      immediateWindowBeats
    };
  }
  const delayMs = requiredDelayMs;

  return {
    available: true,
    delayed: delayMs > 0,
    delayMs,
    tempo,
    projectedBeat,
    observedPhaseBeats,
    targetPhaseBeats,
    immediateWindowBeats,
    reason: delayMs > 0 ? "waiting for post-beat arm window" : "already in post-beat arm window"
  };
}

function unavailablePlan(reason) {
  return {
    available: false,
    delayed: false,
    delayMs: 0,
    reason
  };
}

function boundedFraction(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number < 1 ? number : fallback;
}

function boundedPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}
