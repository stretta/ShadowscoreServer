import assert from "node:assert/strict";
import test from "node:test";
import {
  hitTestNotes,
  moveNote,
  resizeNoteRight,
  sourceTimeForProjectedTime,
  velocityFromLanePosition
} from "../public/piano-roll/clip-editor-core.js";

const sourceNote = {
  note_id: 42,
  pitch: 60,
  start_time: 0.25,
  duration: 0.5,
  velocity: 91,
  probability: 0.8,
  velocity_deviation: 7,
  release_velocity: 54
};

test("move preserves note identity and expressive fields", () => {
  assert.deepEqual(moveNote(sourceNote, {
    deltaTime: 0.26,
    deltaPitch: 2,
    subdivision: 4,
    clipDuration: 4
  }), {
    ...sourceNote,
    pitch: 62,
    start_time: 0.5
  });
});

test("right resize preserves onset and fractional expressive note fields", () => {
  assert.deepEqual(resizeNoteRight(sourceNote, {
    deltaTime: 0.26,
    subdivision: 4,
    clipDuration: 4
  }), {
    ...sourceNote,
    duration: 0.75
  });
});

test("right resize clamps to grid minimum and clip boundary", () => {
  assert.equal(resizeNoteRight(sourceNote, {
    deltaTime: -10,
    subdivision: 8,
    clipDuration: 4
  }).duration, 0.125);
  assert.equal(resizeNoteRight({ ...sourceNote, start_time: 3.75 }, {
    deltaTime: 10,
    subdivision: 8,
    clipDuration: 4
  }).duration, 0.25);
});

test("loop aliases map back to source clip time", () => {
  assert.deepEqual(sourceTimeForProjectedTime(9.25, 4, "looped"), {
    sourceTime: 1.25,
    occurrenceIndex: 2,
    alias: true
  });
  assert.deepEqual(sourceTimeForProjectedTime(3, 4, "one-shot"), {
    sourceTime: 3,
    occurrenceIndex: 0,
    alias: false
  });
});

test("overlap hit testing chooses the last deterministic candidate", () => {
  const hit = hitTestNotes([
    sourceNote,
    { ...sourceNote, note_id: 43, duration: 1 }
  ], { pitch: 60, time: 0.5 });
  assert.equal(hit.index, 1);
  assert.equal(hit.note.note_id, 43);
});

test("velocity hit testing spans the full enlarged lane", () => {
  assert.equal(velocityFromLanePosition(4, 112), 127);
  assert.equal(velocityFromLanePosition(108, 112), 1);
  assert.ok(velocityFromLanePosition(56, 112) >= 63);
});
