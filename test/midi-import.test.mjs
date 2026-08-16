import assert from "node:assert/strict";
import test from "node:test";
import { parseStandardMidiFile } from "../public/piano-roll/midi-import.js";

test("Standard MIDI parser splits format-0 track channels into beat-space lanes", () => {
  const track = [
    0x00, 0xff, 0x03, 0x04, ...ascii("Demo"),
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
    0x00, 0x90, 0x3c, 0x64,
    0x60, 0x3e, 0x50,
    0x60, 0x80, 0x3c, 0x40,
    0x00, 0x3e, 0x20,
    0x00, 0x91, 0x30, 0x70,
    0x81, 0x40, 0x91, 0x30, 0x00,
    0x00, 0xff, 0x2f, 0x00
  ];
  const parsed = parseStandardMidiFile(midiFile(0, 96, [track]), { sourceName: "demo.mid" });

  assert.equal(parsed.format, 0);
  assert.equal(parsed.ppq, 96);
  assert.equal(parsed.tempo, 120);
  assert.deepEqual(parsed.timeSignature, { numerator: 3, denominator: 4 });
  assert.equal(parsed.lanes.length, 2);
  assert.deepEqual(parsed.lanes.map((lane) => [lane.label, lane.noteCount, lane.lowestPitch, lane.highestPitch]), [
    ["Demo · ch 1", 2, 60, 62],
    ["Demo · ch 2", 1, 48, 48]
  ]);
  assert.deepEqual(parsed.lanes[0].notes.map((note) => [note.start_time, note.duration, note.velocity]), [
    [0, 2, 100],
    [1, 1, 80]
  ]);
  assert.equal(parsed.durationBeats, 4);
});

test("Standard MIDI parser rejects format 2 and SMPTE division", () => {
  assert.throws(() => parseStandardMidiFile(midiFile(2, 96, [[]])), /format 2 is not supported/);
  assert.throws(() => parseStandardMidiFile(midiFile(0, 0xe728, [[]])), /SMPTE time division is not supported/);
});

function midiFile(format, division, tracks) {
  return Uint8Array.from([
    ...ascii("MThd"), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division),
    ...tracks.flatMap((track) => [...ascii("MTrk"), ...u32(track.length), ...track])
  ]);
}

function ascii(value) { return [...value].map((character) => character.charCodeAt(0)); }
function u16(value) { return [(value >> 8) & 0xff, value & 0xff]; }
function u32(value) { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
