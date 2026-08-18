import assert from "node:assert/strict";
import test from "node:test";
import { dragTempoValue, formatBbt, formatClock } from "../public/shared/transport-bar.js";

test("transport bar formats musician time readouts", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(65.9), "01:05");
  assert.equal(formatBbt(0, 4), "1.1.000");
  assert.equal(formatBbt(5.5, 4), "2.2.480");
});

test("transport bar maps vertical tempo drags with coarse and fine resolution", () => {
  assert.equal(dragTempoValue(120, -10), 122);
  assert.equal(dragTempoValue(120, 10), 118);
  assert.equal(dragTempoValue(120, -10, { fine: true }), 120.2);
  assert.equal(dragTempoValue(20, 100), 20);
  assert.equal(dragTempoValue(400, -100), 400);
});
