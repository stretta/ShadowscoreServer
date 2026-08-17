import assert from "node:assert/strict";
import test from "node:test";
import { createWiperEstimator } from "../public/shared/wiper-estimator.js";

test("wiper estimator freewheels from an absolute beat and tempo anchor", () => {
  const estimator = createWiperEstimator();
  estimator.update({ beat: 2, tempo: 120, running: true, blockId: "A", observedAt: 1000 }, 1000);
  assert.equal(estimator.estimate(1250).beat, 2.5);
});

test("wiper estimator advances an observation to its receipt time", () => {
  const estimator = createWiperEstimator();
  estimator.update({ beat: 4, tempo: 120, running: true, blockId: "A", observedAt: 1000 }, 1100);
  assert.equal(estimator.estimate(1100).beat, 4.2);
});

test("wiper estimator eases small corrections without jumping", () => {
  const estimator = createWiperEstimator({ correctionMs: 200, snapThresholdBeats: 0.25, staleAfterMs: 2000 });
  estimator.update({ beat: 0, tempo: 60, running: true, blockId: "A", observedAt: 0 }, 0);
  assert.equal(estimator.estimate(1000).beat, 1);
  estimator.update({ beat: 0.85, tempo: 60, running: true, blockId: "A", observedAt: 1000 }, 1000);
  assert.equal(estimator.estimate(1000).beat, 1);
  assert.ok(estimator.estimate(1100).beat > 1);
  assert.ok(estimator.estimate(1100).beat < 1.1);
  assert.equal(estimator.estimate(1200).beat, 1.05);
});

test("wiper estimator ignores recurring micro-corrections while refreshing freshness", () => {
  const estimator = createWiperEstimator({ deadbandBeats: 0.02, staleAfterMs: 750 });
  estimator.update({ beat: 0, tempo: 60, running: true, blockId: "A" }, 0);
  assert.equal(estimator.estimate(250).beat, 0.25);

  estimator.update({ beat: 0.26, tempo: 60, running: true, blockId: "A" }, 250);
  assert.equal(estimator.estimate(250).beat, 0.25);
  assert.equal(estimator.estimate(750).beat, 0.75);
  assert.equal(estimator.estimate(999).stale, false);
  assert.equal(estimator.estimate(1000).stale, true);
});

test("wiper estimator still corrects drift outside the deadband", () => {
  const estimator = createWiperEstimator({ deadbandBeats: 0.02, correctionMs: 400, snapThresholdBeats: 0.25, staleAfterMs: 2000 });
  estimator.update({ beat: 0, tempo: 60, running: true, blockId: "A" }, 0);
  estimator.update({ beat: 0.2, tempo: 60, running: true, blockId: "A" }, 250);

  assert.equal(estimator.estimate(250).beat, 0.25);
  assert.ok(estimator.estimate(450).beat < 0.45);
  assert.ok(Math.abs(estimator.estimate(650).beat - 0.6) < 1e-9);
});

test("wiper estimator snaps large corrections and block changes", () => {
  const estimator = createWiperEstimator({ snapThresholdBeats: 0.25 });
  estimator.update({ beat: 1, tempo: 120, running: true, blockId: "A" }, 1000);
  estimator.update({ beat: 4, tempo: 120, running: true, blockId: "A" }, 1100);
  assert.equal(estimator.estimate(1100).beat, 4);
  estimator.update({ beat: 2, tempo: 120, running: true, blockId: "B" }, 1200);
  assert.equal(estimator.estimate(1200).beat, 2);
});

test("wiper estimator stops immediately at the stopped observation", () => {
  const estimator = createWiperEstimator();
  estimator.update({ beat: 1, tempo: 120, running: true, blockId: "A" }, 1000);
  estimator.update({ beat: 1.5, tempo: 120, running: false, blockId: "A" }, 1250);
  assert.deepEqual(estimator.estimate(5000), {
    beat: 1.5,
    blockId: "A",
    running: false,
    stale: false
  });
});

test("wiper estimator applies tempo changes from the latest absolute anchor", () => {
  const estimator = createWiperEstimator();
  estimator.update({ beat: 1, tempo: 60, running: true, blockId: "A" }, 1000);
  estimator.update({ beat: 1.5, tempo: 120, running: true, blockId: "A" }, 1500);
  assert.equal(estimator.estimate(2000).beat, 2.5);
});

test("wiper estimator freezes after the observation becomes stale", () => {
  const estimator = createWiperEstimator({ staleAfterMs: 750 });
  estimator.update({ beat: 0, tempo: 120, running: true, blockId: "A" }, 1000);
  assert.deepEqual(estimator.estimate(2000), {
    beat: 1.5,
    blockId: "A",
    running: true,
    stale: true
  });
});

test("wiper estimator keeps moving across a slow snapshot interval within its dropout grace", () => {
  const estimator = createWiperEstimator({ staleAfterMs: 3000 });
  estimator.update({ beat: 0, tempo: 120, running: true, blockId: "A" }, 1000);
  assert.deepEqual(estimator.estimate(3000), {
    beat: 4,
    blockId: "A",
    running: true,
    stale: false
  });
  assert.equal(estimator.estimate(4000).stale, true);
});
