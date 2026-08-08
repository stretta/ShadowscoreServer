import assert from "node:assert/strict";
import test from "node:test";
import { bipolarRangeState } from "../public/shared/bipolar-range.js";

test("symmetric bipolar ranges fill outward from the midpoint", () => {
  assert.deepEqual(bipolarRangeState(-1, 1, 0.5), {
    zero: 50,
    value: 75,
    fillStart: 50,
    fillEnd: 75
  });
  assert.deepEqual(bipolarRangeState(-1, 1, -0.5), {
    zero: 50,
    value: 25,
    fillStart: 25,
    fillEnd: 50
  });
});

test("asymmetric bipolar ranges place zero at its actual range position", () => {
  assert.deepEqual(bipolarRangeState(-24, 6, 3), {
    zero: 80,
    value: 90,
    fillStart: 80,
    fillEnd: 90
  });
});

test("unipolar and one-sided ranges are not treated as bipolar", () => {
  assert.equal(bipolarRangeState(0, 1, 0.5), null);
  assert.equal(bipolarRangeState(-70, 0, -12), null);
  assert.equal(bipolarRangeState(-1, 1, Number.NaN), null);
});
