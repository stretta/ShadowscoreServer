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
      if (!["slipped", "offset"].includes(health.state)) {
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

export function classifyEnsembleSyncScenario(scenario = {}, options = {}) {
  const samples = Array.isArray(scenario.samples) ? scenario.samples : [];
  const targets = Array.isArray(options.targets) ? options.targets : [];
  if (samples.length < 2 || !targets.length || samples.some((sample) => sample.stages?.length !== targets.length)) {
    throw new Error("sync scenario requires ordered samples for every target");
  }
  const runtime = scenario.runtime ?? {};
  if (runtime.sendQueueInProgress === true) {
    return result("preparing", [], { phaseJudgement: "suppress" });
  }
  if (runtime.serverActiveTransaction == null && Number.isFinite(Number(runtime.clientActiveTransaction))) {
    return result("reconstruct-active", [], { action: "adopt-without-resend" });
  }

  const patternLength = positiveInteger(options.patternLength, 0);
  const toleranceStages = Math.max(0, Number(options.toleranceStages) || 1);
  const first = samples[0].stages.map(Number);
  const last = samples.at(-1).stages.map(Number);
  const movements = last.map((stage, index) => stageDifference(stage, first[index], patternLength));
  const ensembleMovement = median(movements);
  const stoppedIndexes = movements.flatMap((movement, index) =>
    Math.abs(movement) <= toleranceStages && Math.abs(ensembleMovement) > toleranceStages * 2 ? [index] : []);
  if (stoppedIndexes.length && stoppedIndexes.length < targets.length / 2) {
    return result("stale-or-stopped", stoppedIndexes.map((index) => targets[index]));
  }

  const spreads = samples.map((sample) => stageSpread(sample.stages.map(Number), patternLength));
  const finalOutliers = outlierIndexes(last, toleranceStages, patternLength).map((index) => targets[index]);
  if (spreads.at(-1) > spreads[0] + toleranceStages) {
    return result("rate-drift", finalOutliers);
  }
  if (spreads.some((spread) => spread > toleranceStages)) {
    return result("stable-offset", finalOutliers);
  }
  return result("aligned", []);

  function result(status, outlierTargets, extra = {}) {
    return {
      status,
      phaseJudgement: "evaluate",
      outlierTargets,
      ...extra
    };
  }
}

function stageSpread(stages, patternLength) {
  const center = median(stages);
  const offsets = stages.map((stage) => stageDifference(stage, center, patternLength));
  return Math.max(...offsets) - Math.min(...offsets);
}

function outlierIndexes(stages, tolerance, patternLength) {
  const center = median(stages);
  return stages.flatMap((stage, index) =>
    Math.abs(stageDifference(stage, center, patternLength)) > tolerance ? [index] : []);
}

function stageDifference(value, reference, patternLength) {
  const difference = Number(value) - Number(reference);
  if (!Number.isFinite(patternLength) || patternLength <= 0) return difference;
  return positiveModulo(difference + (patternLength / 2), patternLength) - (patternLength / 2);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
