import { supportsAtomicClockArm } from "./atomic-clock-arm.mjs";
import { supportsTransactionalTransportStart } from "./transactional-transport-start.mjs";

export const TRANSPORT_START_STRATEGY_IDS = Object.freeze({
  atomic: "atomic-clock-arm",
  transactional: "transactional-transport-start",
  legacy: "legacy-coordinated-start"
});

const STRATEGY_DRIVERS = Object.freeze([
  strategyDriver(TRANSPORT_START_STRATEGY_IDS.atomic, ({ complete, entries, hasPhaseAcknowledgement }) =>
    complete && entries.every(({ target }) => supportsAtomicClockArm(target) && hasPhaseAcknowledgement(target))),
  strategyDriver(TRANSPORT_START_STRATEGY_IDS.transactional, ({ complete, entries, hasPhaseAcknowledgement }) =>
    complete && entries.every(({ target }) =>
      supportsTransactionalTransportStart(target)
      && String(target.clockPhaseResetPath ?? "").startsWith("/")
      && String(target.clockPhaseAckPath ?? "").startsWith("/")
      && hasPhaseAcknowledgement(target))),
  strategyDriver(TRANSPORT_START_STRATEGY_IDS.legacy, () => true)
]);

export function planTransportStartStrategy({
  targets = [],
  targetIds = [],
  phaseStage,
  compileTiming,
  hasPhaseAcknowledgement = () => true
} = {}) {
  if (typeof compileTiming !== "function") throw new Error("compileTiming is required");
  const expectedTargetIds = Object.freeze([...new Set(targetIds
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))]);
  const byId = new Map(targets.map((target) => [String(target?.id ?? ""), target]));
  const entries = Object.freeze(expectedTargetIds.flatMap((targetId) => {
    const target = byId.get(targetId);
    if (!target) return [];
    const timing = compileTiming(target);
    return [Object.freeze({
      targetId,
      target: freezeTarget(target),
      timing: Object.freeze({
        patternLength: exactInteger(timing?.patternLength, "patternLength", 1),
        ticksPerStage: exactInteger(timing?.ticksPerStage, "ticksPerStage", 1)
      })
    })];
  }));
  const context = {
    expectedTargetIds,
    entries,
    complete: expectedTargetIds.length > 0 && entries.length === expectedTargetIds.length,
    hasPhaseAcknowledgement
  };
  const driver = STRATEGY_DRIVERS.find((candidate) => candidate.supports(context));
  return Object.freeze({
    strategyId: driver.id,
    phaseStage: phaseStage === null || phaseStage === undefined ? null : Number(phaseStage),
    targetIds: expectedTargetIds,
    entries,
    complete: context.complete
  });
}

export async function executeTransportStartStrategy(plan, handlers = {}) {
  const driver = STRATEGY_DRIVERS.find(({ id }) => id === plan?.strategyId);
  if (!driver) throw new Error(`unknown transport-start strategy '${String(plan?.strategyId ?? "")}'`);
  const execute = handlers[driver.id]?.execute;
  if (typeof execute !== "function") {
    if (driver.id === TRANSPORT_START_STRATEGY_IDS.legacy) return null;
    throw new Error(`transport-start strategy '${driver.id}' has no executor`);
  }
  try {
    const result = await driver.execute(plan, execute);
    const evidence = driver.normalizeEvidence(result);
    driver.verify(evidence);
    return { ...result, strategyId: driver.id, strategyEvidence: evidence };
  } catch (cause) {
    const rollback = await driver.rollback(plan, cause, handlers[driver.id]?.rollback);
    cause.strategyId = driver.id;
    cause.strategyRollback = rollback;
    throw cause;
  }
}

function strategyDriver(id, supports) {
  return Object.freeze({
    id,
    supports,
    plan: (context) => context,
    execute: (plan, execute) => execute(plan),
    normalizeEvidence(result = {}) {
      return Object.freeze({
        ok: result.ok === true,
        activeVerified: result.active?.verified === true,
        phaseVerified: result.phaseResetAcknowledgement?.verified === true,
        targetIds: Object.freeze([...(result.targetIds ?? [])])
      });
    },
    verify(evidence) {
      if (evidence.ok && evidence.activeVerified && evidence.phaseVerified) return evidence;
      const error = new Error(`transport-start strategy '${id}' returned incomplete evidence`);
      error.code = "TRANSPORT_START_EVIDENCE_INCOMPLETE";
      error.evidence = evidence;
      throw error;
    },
    async rollback(plan, cause, rollback) {
      if (typeof rollback !== "function") return { attempted: false };
      try {
        return { attempted: true, ok: true, result: await rollback(plan, cause) };
      } catch (error) {
        return { attempted: true, ok: false, error: String(error?.message ?? error) };
      }
    }
  });
}

function freezeTarget(target) {
  return Object.freeze({
    ...target,
    capabilities: Object.freeze({ ...(target.capabilities ?? {}) })
  });
}

function exactInteger(value, field, minimum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return number;
}
