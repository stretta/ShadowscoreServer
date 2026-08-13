import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTtid, quantizePitchToTtid, scaleCatalog, scaleToPitchClasses, scaleToTtid, ttidToPitchClasses } from "../src/harmonic/scale.mjs";

test("canonical scales encode pitch class zero as TTID bit zero", () => {
  const scales = scaleCatalog();
  assert.equal(scaleToTtid({ root_note: 0, scale_name: "Ionian", scale_intervals: scales.ionian }), 2741);
  assert.equal(scaleToTtid({ root_note: 0, scale_name: "Chromatic", scale_intervals: scales.chromatic }), 4095);
  assert.equal(scaleToTtid({ root_note: 2, scale_name: "Major Pentatonic", scale_intervals: scales["major-pentatonic"] }), 2644);
  assert.equal(scaleToTtid({ root_note: 1, scale_name: "Whole Tone", scale_intervals: scales["whole-tone"] }), 2730);
  assert.equal(scaleToTtid({ root_note: 5, scale_name: "Altered", scale_intervals: scales.altered }), 2922);
  assert.deepEqual(scaleToPitchClasses({ root_note: 2, scale_name: "Ionian", scale_intervals: scales.ionian }), [1, 2, 4, 6, 7, 9, 11]);
});

test("TTID validation is strict", () => {
  assert.equal(normalizeTtid(0), 0);
  assert.equal(normalizeTtid(4095), 4095);
  assert.throws(() => normalizeTtid(4096), /0 through 4095/);
  assert.throws(() => normalizeTtid(2.5), /integer/);
});

test("TTID converts back to its absolute pitch-class set", () => {
  assert.deepEqual(ttidToPitchClasses(2741), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(ttidToPitchClasses(4095), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(ttidToPitchClasses(0), []);
});

test("TTID pitch quantization preserves chromatic pitches and breaks ties downward", () => {
  assert.equal(quantizePitchToTtid(63, 4095), 63);
  assert.equal(quantizePitchToTtid(60, 2774), 59);
  assert.equal(quantizePitchToTtid(63, 2774), 62);
  assert.equal(quantizePitchToTtid(63, 0), 63);
});
