import assert from "node:assert/strict";
import test from "node:test";
import {
  atomicClockArmRequest,
  selectAtomicClockArmCohort,
  supportsAtomicClockArm
} from "../src/playback/atomic-clock-arm.mjs";

test("atomic clock arm preserves ClockInterval MaxSteps SetStage order", () => {
  assert.deepEqual(atomicClockArmRequest({
    clockInterval: 120,
    maxSteps: 64,
    setStage: 12
  }), [120, 64, 12]);
  assert.throws(() => atomicClockArmRequest({ clockInterval: 0, maxSteps: 64, setStage: 0 }), /clockInterval/);
  assert.throws(() => atomicClockArmRequest({ clockInterval: 120, maxSteps: 64, setStage: 64 }), /setStage/);
});

test("atomic clock arm requires the complete live cohort", () => {
  const supported = {
    id: "wren",
    available: true,
    clockArmPath: "/rnbo/inst/9/messages/in/ClockArm",
    clockPhaseAckPath: "/rnbo/inst/9/messages/out/clock_phase_ack",
    capabilities: { atomicClockArm: true }
  };
  const legacy = { id: "raven", available: true, capabilities: { atomicClockArm: false } };
  assert.equal(supportsAtomicClockArm(supported), true);
  assert.deepEqual(selectAtomicClockArmCohort([supported], ["wren"]).map(({ id }) => id), ["wren"]);
  assert.deepEqual(selectAtomicClockArmCohort([supported, legacy], ["wren", "raven"]), []);
});
