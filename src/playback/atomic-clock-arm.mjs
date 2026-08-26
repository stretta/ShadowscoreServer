export function atomicClockArmRequest({ clockInterval, maxSteps, setStage } = {}) {
  const steps = exactInt(maxSteps, "maxSteps", 1, 2147483647);
  return [
    exactInt(clockInterval, "clockInterval", 1, 2147483647),
    steps,
    exactInt(setStage, "setStage", 0, steps - 1)
  ];
}

export function supportsAtomicClockArm(target) {
  return Boolean(
    target
    && target.available !== false
    && target.capabilities?.atomicClockArm === true
    && String(target.clockArmPath ?? "").startsWith("/")
    && String(target.clockPhaseAckPath ?? "").startsWith("/")
  );
}

export function selectAtomicClockArmCohort(targets, expectedTargetIds) {
  const expected = [...new Set((expectedTargetIds ?? [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean))];
  if (!expected.length) return [];
  const byId = new Map((targets ?? []).map((target) => [String(target?.id ?? ""), target]));
  const selected = expected.map((id) => byId.get(id));
  return selected.some((target) => !target || !supportsAtomicClockArm(target)) ? [] : selected;
}

function exactInt(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return number;
}
