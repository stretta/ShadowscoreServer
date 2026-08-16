import test from "node:test";
import assert from "node:assert/strict";
import { canvasMetrics } from "../public/piano-roll/canvas-metrics.js";

test("canvas metrics preserve native display density when it is safe", () => {
  assert.deepEqual(canvasMetrics(800, 480, { devicePixelRatio: 2 }), {
    cssWidth: 800,
    cssHeight: 480,
    scale: 2,
    width: 1600,
    height: 960
  });
});

test("canvas metrics reduce density without shortening a long score", () => {
  const metrics = canvasMetrics(16248, 806, { devicePixelRatio: 2 });

  assert.equal(metrics.cssWidth, 16248);
  assert.equal(metrics.cssHeight, 806);
  assert.ok(metrics.scale < 2);
  assert.ok(metrics.width <= 16384);
  assert.ok(metrics.height <= 16384);
  assert.ok(metrics.width * metrics.height <= 16000000);
});

test("canvas metrics remain bounded for extreme timeline widths", () => {
  const metrics = canvasMetrics(100000, 1000, { devicePixelRatio: 3 });

  assert.equal(metrics.cssWidth, 100000);
  assert.ok(metrics.scale < 1);
  assert.ok(metrics.width <= 16384);
  assert.ok(metrics.width * metrics.height <= 16000000);
});
