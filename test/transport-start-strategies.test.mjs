import test from "node:test";
import assert from "node:assert/strict";
import {
  executeTransportStartStrategy,
  planTransportStartStrategy,
  TRANSPORT_START_STRATEGY_IDS
} from "../src/playback/transport-start-strategies.mjs";

test("transport-start planning freezes one atomic cohort and timing set", () => {
  let compileCount = 0;
  const targets = [target("finch"), target("raven")];
  const plan = planTransportStartStrategy({
    targets,
    targetIds: ["finch", "raven"],
    phaseStage: 3,
    compileTiming(entry) {
      compileCount += 1;
      return { patternLength: entry.id === "finch" ? 64 : 32, ticksPerStage: 120 };
    }
  });

  assert.equal(plan.strategyId, TRANSPORT_START_STRATEGY_IDS.atomic);
  assert.equal(compileCount, 2);
  assert.deepEqual(plan.entries.map(({ targetId, timing }) => ({ targetId, timing })), [
    { targetId: "finch", timing: { patternLength: 64, ticksPerStage: 120 } },
    { targetId: "raven", timing: { patternLength: 32, ticksPerStage: 120 } }
  ]);
  targets[0].capabilities.atomicClockArm = false;
  assert.equal(plan.entries[0].target.capabilities.atomicClockArm, true);
  assert.equal(Object.isFrozen(plan.entries), true);
});

test("transport-start planning selects transactional then legacy compatibility", () => {
  const transactional = target("finch");
  transactional.capabilities.atomicClockArm = false;
  assert.equal(plan([transactional], ["finch"]).strategyId, TRANSPORT_START_STRATEGY_IDS.transactional);

  transactional.capabilities.transactionalTransportStart = false;
  assert.equal(plan([transactional], ["finch"]).strategyId, TRANSPORT_START_STRATEGY_IDS.legacy);
  assert.equal(plan([transactional], ["missing"]).strategyId, TRANSPORT_START_STRATEGY_IDS.legacy);
});

test("transport-start execution normalizes evidence and dispatches rollback", async () => {
  const selected = plan([target("finch")], ["finch"]);
  const executed = await executeTransportStartStrategy(selected, {
    [TRANSPORT_START_STRATEGY_IDS.atomic]: {
      async execute(strategyPlan) {
        return {
          ok: true,
          targetIds: strategyPlan.targetIds,
          active: { verified: true },
          phaseResetAcknowledgement: { verified: true }
        };
      }
    }
  });
  assert.equal(executed.strategyId, TRANSPORT_START_STRATEGY_IDS.atomic);
  assert.equal(executed.strategyEvidence.ok, true);

  await assert.rejects(
    executeTransportStartStrategy(selected, {
      [TRANSPORT_START_STRATEGY_IDS.atomic]: {
        async execute() { return { ok: true, active: { verified: false } }; },
        async rollback(strategyPlan, cause) {
          return { targetIds: strategyPlan.targetIds, code: cause.code };
        }
      }
    }),
    (error) => error.code === "TRANSPORT_START_EVIDENCE_INCOMPLETE"
      && error.strategyRollback.ok === true
      && error.strategyRollback.result.code === "TRANSPORT_START_EVIDENCE_INCOMPLETE"
  );
});

test("transport-start execution accepts driver-specific normalized evidence", async () => {
  const legacyTarget = target("legacy");
  legacyTarget.capabilities.atomicClockArm = false;
  legacyTarget.capabilities.transactionalTransportStart = false;
  const legacyPlan = plan([legacyTarget], ["legacy"]);
  const executed = await executeTransportStartStrategy(legacyPlan, {
    [TRANSPORT_START_STRATEGY_IDS.legacy]: {
      async execute() {
        return { clockStarted: true, phaseAligned: true };
      },
      normalizeEvidence(result, strategyPlan) {
        return {
          ok: result.clockStarted,
          activeVerified: result.clockStarted,
          phaseVerified: result.phaseAligned,
          targetIds: strategyPlan.targetIds
        };
      }
    }
  });
  assert.equal(executed.strategyId, TRANSPORT_START_STRATEGY_IDS.legacy);
  assert.equal(executed.strategyEvidence.phaseVerified, true);
});

function plan(targets, targetIds) {
  return planTransportStartStrategy({
    targets,
    targetIds,
    phaseStage: 0,
    compileTiming: () => ({ patternLength: 64, ticksPerStage: 120 })
  });
}

function target(id) {
  return {
    id,
    available: true,
    clockArmPath: `/rnbo/${id}/messages/in/ClockArm`,
    clockPhaseResetPath: `/rnbo/${id}/messages/in/clock_phase_reset`,
    clockPhaseAckPath: `/rnbo/${id}/messages/out/clock_phase_ack`,
    transportStartPath: `/rnbo/${id}/messages/in/TransportStart`,
    transportStartAckPath: `/rnbo/${id}/messages/out/transport_start_ack`,
    capabilities: { atomicClockArm: true, transactionalTransportStart: true }
  };
}
