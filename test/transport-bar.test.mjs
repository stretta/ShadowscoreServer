import assert from "node:assert/strict";
import test from "node:test";
import { dragTempoValue, formatBbt, formatClock, transportPositionAtFraction } from "../public/shared/transport-bar.js";

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

test("transport slider previews beat position and tempo-integrated time", () => {
  const snapshot = {
    duration_beats: 16,
    duration_seconds: 12,
    arrangement: {
      sections: [
        { start_beat: 0, end_beat: 8, tempo: 60 },
        { start_beat: 8, end_beat: 16, tempo: 120 }
      ]
    }
  };
  assert.deepEqual(transportPositionAtFraction(snapshot, 0.75), {
    fraction: 0.75,
    beats: 12,
    seconds: 10
  });
});
