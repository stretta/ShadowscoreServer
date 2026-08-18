import assert from "node:assert/strict";
import test from "node:test";

import { createEnsembleSyncSupervisor, phaseStageAtBeat } from "../src/transport/ensemble-sync-supervisor.mjs";

test("sync supervisor requires sustained slip and enforces a cooldown", () => {
  let now = Date.parse("2026-08-17T20:00:00Z");
  const supervisor = createEnsembleSyncSupervisor({
    requiredConsecutiveSlips: 3,
    cooldownMs: 10000,
    now: () => now
  });
  const slipped = { state: "slipped", max_client_skew_beats: 0.25 };

  assert.equal(supervisor.observe(slipped).trigger, false);
  assert.equal(supervisor.observe(slipped).trigger, false);
  assert.equal(supervisor.observe(slipped).trigger, true);
  assert.equal(supervisor.begin(), true);
  supervisor.finish({ ok: true });

  assert.equal(supervisor.observe(slipped).trigger, false);
  assert.equal(supervisor.observe(slipped).trigger, false);
  assert.equal(supervisor.observe(slipped).trigger, false);
  now += 10000;
  assert.equal(supervisor.observe(slipped).trigger, true);
});

test("non-slip observations clear the sustained-slip counter", () => {
  const supervisor = createEnsembleSyncSupervisor({ requiredConsecutiveSlips: 2 });
  assert.equal(supervisor.observe({ state: "slipped" }).consecutiveSlips, 1);
  assert.equal(supervisor.observe({ state: "stale" }).consecutiveSlips, 0);
  assert.equal(supervisor.observe({ state: "slipped" }).trigger, false);
});

test("phase stage follows the current block beat and wraps to the pattern", () => {
  assert.equal(phaseStageAtBeat({ beatIntoBlock: 5.25, stagesPerBeat: 4, patternLength: 32 }), 21);
  assert.equal(phaseStageAtBeat({ beatIntoBlock: 8.25, stagesPerBeat: 4, patternLength: 32 }), 1);
  assert.equal(phaseStageAtBeat({ beatIntoBlock: -0.25, stagesPerBeat: 4, patternLength: 32 }), 31);
});
