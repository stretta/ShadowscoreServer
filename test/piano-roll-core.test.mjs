import assert from "node:assert/strict";
import test from "node:test";
import {
  hitTestNotes,
  gridStepsPerBeat,
  moveNote,
  nudgeNote,
  executionBeatForVoice,
  playbackBeatForVoice,
  projectClipOccurrences,
  resizeNoteRight,
  sourceTimeForProjectedTime,
  velocityFromLanePosition
} from "../public/piano-roll/clip-editor-core.js";

test("playback wiper uses the focused voice RNBO stage when macro beat is unavailable", () => {
  assert.equal(playbackBeatForVoice({
    playback: { playing: true, activeBlockId: "F", beatIntoBlock: null },
    blockId: "F",
    voiceId: "player-1",
    assignment: { rnboTargetId: "rnbo-inst-5:shadowscore" },
    targets: [{ id: "rnbo-inst-5:shadowscore", currentStage: 89 }],
    contracts: [{ targetId: "rnbo-inst-5:shadowscore", assignedVoiceId: "player-1", timing: { blockId: "F", stagesPerBeat: 16 } }]
  }), 89 / 16);
});

test("playback wiper prefers the authoritative beat and exposes client execution separately", () => {
  const options = {
    playback: { playing: true, activeBlockId: "F", beatIntoBlock: 6 },
    blockId: "F",
    voiceId: "player-1",
    assignment: { rnboTargetId: "rnbo-inst-5:shadowscore" },
    targets: [{ id: "rnbo-inst-5:shadowscore", currentStage: 89 }],
    contracts: [{ targetId: "rnbo-inst-5:shadowscore", assignedVoiceId: "player-1", timing: { blockId: "F", stagesPerBeat: 16 } }]
  };
  assert.equal(playbackBeatForVoice(options), 6);
  assert.equal(executionBeatForVoice(options), 89 / 16);
});

test("playback wiper exposes a fresh client execution witness while macro playback is stopped", () => {
  assert.equal(playbackBeatForVoice({
    playback: { playing: false, activeBlockId: "A", beatIntoBlock: null },
    blockId: "A",
    voiceId: "player-1",
    assignment: { rnboTargetId: "rnbo-inst-22:shadowscore" },
    targets: [{ id: "rnbo-inst-22:shadowscore", online: true, fresh: true, blockId: "A", currentStage: 163 }],
    contracts: [{ targetId: "rnbo-inst-22:shadowscore", assignedVoiceId: "player-1", timing: { blockId: "A", stagesPerBeat: 16 } }]
  }), 163 / 16);
});

test("playback wiper rejects stale or wrong-block execution witnesses", () => {
  const options = {
    playback: { playing: false, activeBlockId: "A", beatIntoBlock: null },
    blockId: "A",
    voiceId: "player-1",
    assignment: { rnboTargetId: "rnbo-inst-22:shadowscore" },
    targets: [{ id: "rnbo-inst-22:shadowscore", online: true, fresh: false, blockId: "A", currentStage: 163 }],
    contracts: [{ targetId: "rnbo-inst-22:shadowscore", assignedVoiceId: "player-1", timing: { blockId: "A", stagesPerBeat: 16 } }]
  };
  assert.equal(playbackBeatForVoice(options), undefined);
  assert.equal(playbackBeatForVoice({
    ...options,
    targets: [{ ...options.targets[0], fresh: true, blockId: "B" }]
  }), undefined);
});

test("playback wiper falls back to macro beat and remains gated to the active block", () => {
  const options = {
    playback: { playing: true, activeBlockId: "B", beatIntoBlock: 2.5 },
    blockId: "B",
    voiceId: "player-1",
    assignment: {},
    targets: [],
    contracts: []
  };
  assert.equal(playbackBeatForVoice(options), 2.5);
  assert.equal(playbackBeatForVoice({ ...options, blockId: "A" }), undefined);
});

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

test("note-value grid labels convert to subdivisions per quarter-note beat", () => {
  assert.equal(gridStepsPerBeat(4), 1);
  assert.equal(gridStepsPerBeat(8), 2);
  assert.equal(gridStepsPerBeat(16), 4);
  assert.equal(gridStepsPerBeat(32), 8);
});

test("move preserves note identity and expressive fields", () => {
  assert.deepEqual(moveNote(sourceNote, {
    deltaTime: 0.26,
    deltaPitch: 2,
    subdivision: 16,
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
    subdivision: 16,
    clipDuration: 4
  }), {
    ...sourceNote,
    duration: 0.75
  });
});

test("right resize clamps to grid minimum and clip boundary", () => {
  assert.equal(resizeNoteRight(sourceNote, {
    deltaTime: -10,
    subdivision: 32,
    clipDuration: 4
  }).duration, 0.125);
  assert.equal(resizeNoteRight({ ...sourceNote, start_time: 3.75 }, {
    deltaTime: 10,
    subdivision: 32,
    clipDuration: 4
  }).duration, 0.25);
});

test("keyboard nudges move by one grid step and preserve other fields", () => {
  assert.deepEqual(nudgeNote(sourceNote, {
    direction: "right",
    subdivision: 16,
    clipDuration: 4
  }), { ...sourceNote, start_time: 0.5 });
  assert.deepEqual(nudgeNote(sourceNote, {
    direction: "up",
    subdivision: 16,
    clipDuration: 4
  }), { ...sourceNote, pitch: 61 });
});

test("shifted horizontal nudges resize only the right edge", () => {
  assert.deepEqual(nudgeNote(sourceNote, {
    direction: "right",
    resize: true,
    subdivision: 16,
    clipDuration: 4
  }), { ...sourceNote, duration: 0.75 });
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

test("loop projection repeats source notes across block time without cloning identity", () => {
  const occurrences = projectClipOccurrences([sourceNote], {
    clipDuration: 2,
    timelineDuration: 6,
    playbackType: "looped"
  });
  assert.deepEqual(occurrences.map(({ sourceIndex, occurrenceIndex, alias, note }) => ({
    sourceIndex,
    occurrenceIndex,
    alias,
    noteId: note.note_id,
    start: note.start_time
  })), [
    { sourceIndex: 0, occurrenceIndex: 0, alias: false, noteId: 42, start: 0.25 },
    { sourceIndex: 0, occurrenceIndex: 1, alias: true, noteId: 42, start: 2.25 },
    { sourceIndex: 0, occurrenceIndex: 2, alias: true, noteId: 42, start: 4.25 }
  ]);
});

test("one-shot projection never creates aliases", () => {
  const occurrences = projectClipOccurrences([sourceNote], {
    clipDuration: 2,
    timelineDuration: 8,
    playbackType: "one-shot"
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].alias, false);
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
