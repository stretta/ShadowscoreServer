import test from "node:test";
import assert from "node:assert/strict";

import { planClockArmWindow } from "../src/transport/clock-arm-window.mjs";

test("clock arm proceeds immediately near the beginning of a fresh JACK beat", () => {
  const plan = planClockArmWindow({
    fresh: true,
    ageMs: 20,
    latest: { state: "rolling", absoluteBeat: 12, beatsPerMinute: 120 }
  });

  assert.equal(plan.available, true);
  assert.equal(plan.delayed, false);
  assert.equal(plan.delayMs, 0);
  assert.ok(Math.abs(plan.observedPhaseBeats - 0.04) < 0.000001);
});

test("clock arm waits for the next post-beat window late in a beat", () => {
  const plan = planClockArmWindow({
    fresh: true,
    ageMs: 0,
    latest: { state: "rolling", absoluteBeat: 12.75, beatsPerMinute: 120 }
  });

  assert.equal(plan.available, true);
  assert.equal(plan.delayed, true);
  assert.equal(plan.delayMs, 150);
  assert.equal(plan.targetPhaseBeats, 0.05);
});

test("clock arm does not delay without a fresh rolling JACK witness", () => {
  const plan = planClockArmWindow({
    fresh: false,
    latest: { state: "stopped", absoluteBeat: 12.75, beatsPerMinute: 120 }
  });

  assert.deepEqual(plan, {
    available: false,
    delayed: false,
    delayMs: 0,
    reason: "fresh rolling JACK transport is unavailable"
  });
});

test("clock arm refuses an unsafe capped wait at extremely slow tempos", () => {
  const plan = planClockArmWindow({
    fresh: true,
    ageMs: 0,
    latest: { state: "rolling", absoluteBeat: 12.2, beatsPerMinute: 10 }
  });

  assert.equal(plan.available, false);
  assert.equal(plan.delayMs, 0);
  assert.ok(plan.requiredDelayMs > plan.maxDelayMs);
});
