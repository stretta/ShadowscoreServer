const DEFAULT_STALE_AFTER_MS = 750;
const DEFAULT_CORRECTION_MS = 180;
const DEFAULT_SNAP_THRESHOLD_BEATS = 0.25;
const DEFAULT_DEADBAND_BEATS = 0;

export function createWiperEstimator(options = {}) {
  const now = options.now ?? Date.now;
  const staleAfterMs = nonNegative(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const correctionMs = nonNegative(options.correctionMs, DEFAULT_CORRECTION_MS);
  const snapThresholdBeats = positive(options.snapThresholdBeats, DEFAULT_SNAP_THRESHOLD_BEATS);
  const deadbandBeats = nonNegative(options.deadbandBeats, DEFAULT_DEADBAND_BEATS);
  let state;

  return {
    update(sample = {}, receivedAtMs = now()) {
      const beat = finite(sample.beat);
      const tempo = positive(sample.tempo, NaN);
      const blockId = String(sample.blockId ?? "");
      const running = Boolean(sample.running);
      const receivedAt = finite(receivedAtMs);
      if (!Number.isFinite(beat) || !Number.isFinite(receivedAt) || (running && !Number.isFinite(tempo))) {
        state = undefined;
        return undefined;
      }

      const observedAt = timestamp(sample.observedAt);
      const observationAge = observedAt === null
        ? 0
        : Math.min(staleAfterMs, Math.max(0, receivedAt - observedAt));
      const beatAtReceipt = beat + (running ? observationAge * tempo / 60000 : 0);
      const previous = state ? estimateState(state, receivedAt, staleAfterMs) : undefined;
      const sameStream = previous
        && previous.blockId === blockId
        && previous.running === running;
      const phaseError = sameStream ? beatAtReceipt - previous.beat : Number.NaN;
      if (sameStream && Math.abs(phaseError) <= deadbandBeats) {
        state.receivedAtMs = receivedAt;
        if (state.tempo !== (Number.isFinite(tempo) ? tempo : 0)) {
          state = {
            ...state,
            anchorBeat: previous.beat,
            anchorTimeMs: receivedAt,
            correctionBeat: 0,
            correctionEndMs: receivedAt,
            correctionStartMs: receivedAt,
            tempo: Number.isFinite(tempo) ? tempo : 0
          };
        }
        return estimateState(state, receivedAt, staleAfterMs);
      }
      const discontinuity = !sameStream || Math.abs(phaseError) >= snapThresholdBeats;
      const correctionBeat = discontinuity ? 0 : previous.beat - beatAtReceipt;

      state = {
        anchorBeat: beatAtReceipt,
        anchorTimeMs: receivedAt,
        blockId,
        correctionBeat,
        correctionEndMs: receivedAt + correctionMs,
        correctionStartMs: receivedAt,
        receivedAtMs: receivedAt,
        running,
        tempo: Number.isFinite(tempo) ? tempo : 0
      };
      return estimateState(state, receivedAt, staleAfterMs);
    },

    estimate(atMs = now()) {
      return state ? estimateState(state, finite(atMs), staleAfterMs) : undefined;
    },

    clear() {
      state = undefined;
    }
  };
}

function estimateState(state, requestedAtMs, staleAfterMs) {
  const atMs = Number.isFinite(requestedAtMs) ? requestedAtMs : state.receivedAtMs;
  const staleAtMs = state.receivedAtMs + staleAfterMs;
  const effectiveAtMs = state.running ? Math.min(atMs, staleAtMs) : atMs;
  const elapsedMs = Math.max(0, effectiveAtMs - state.anchorTimeMs);
  const rawBeat = state.anchorBeat + (state.running ? elapsedMs * state.tempo / 60000 : 0);
  const correctionProgress = state.correctionEndMs <= state.correctionStartMs
    ? 1
    : clamp((effectiveAtMs - state.correctionStartMs) / (state.correctionEndMs - state.correctionStartMs), 0, 1);
  const correction = state.correctionBeat * (1 - smoothstep(correctionProgress));
  return {
    beat: rawBeat + correction,
    blockId: state.blockId,
    running: state.running,
    stale: state.running && atMs >= staleAtMs
  };
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
