import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackPreparationState } from "../src/playback/playback-preparation-state.mjs";

test("playback preparation state selects dirty and missing voices", () => {
  const state = createPlaybackPreparationState();
  const present = new Set(["player-1"]);
  assert.deepEqual(state.selectVoices("A", ["player-1", "player-2"], (voiceId) => present.has(voiceId)), ["player-2"]);

  state.recordImpact(impact({ blockIds: ["A"], voices: { A: ["player-1"] } }), { affectsPlayback: true });
  assert.deepEqual(state.selectVoices("A", ["player-1", "player-2"], (voiceId) => present.has(voiceId)), [
    "player-1", "player-2"
  ]);

  state.clearPrepared([{ ok: true, blockId: "A", voiceId: "player-1" }]);
  assert.deepEqual(state.selectVoices("A", ["player-1", "player-2"], (voiceId) => present.has(voiceId)), ["player-2"]);
});

test("playback preparation state invalidates desired hashes by block and voice", () => {
  const state = createPlaybackPreparationState();
  state.cacheDesiredHash("A", "finch", "player-1", "a-finch");
  state.cacheDesiredHash("A", "heron", "player-2", "a-heron");
  state.cacheDesiredHash("B", "finch", "player-1", "b-finch");

  state.recordImpact(impact({ blockIds: ["A"], voices: { A: ["player-1"] } }), { affectsPlayback: true });
  assert.equal(state.desiredHash("A", "finch"), null);
  assert.equal(state.desiredHash("A", "heron"), "a-heron");
  assert.equal(state.desiredHash("B", "finch"), "b-finch");

  state.recordImpact(impact({ blockIds: ["A", "B"], voices: { A: ["player-2"], B: ["player-1"] }, invalidateAll: true }), {
    affectsPlayback: true
  });
  assert.equal(state.desiredHash("A", "heron"), null);
  assert.equal(state.desiredHash("B", "finch"), null);
  assert.equal(state.invalidatesAll(), true);
  assert.deepEqual(state.selectVoices("A", ["player-1", "player-2"], () => true), ["player-1", "player-2"]);

  state.clearPrepared([
    { ok: true, blockId: "A", voiceId: "player-1" },
    { ok: true, blockId: "A", voiceId: "player-2" },
    { ok: true, blockId: "B", voiceId: "player-1" }
  ]);
  assert.equal(state.invalidatesAll(), false);
});

test("playback preparation state bounds and isolates mutation history", () => {
  const state = createPlaybackPreparationState({ impactLimit: 2 });
  state.recordImpact(impact({ scoreRevision: 1 }));
  state.recordImpact(impact({ scoreRevision: 2 }));
  state.recordImpact(impact({ scoreRevision: 3 }));

  const history = state.impacts();
  assert.deepEqual(history.map((entry) => entry.scoreRevision), [2, 3]);
  assert.equal(state.latestImpact().scoreRevision, 3);
  history[0].scoreRevision = 99;
  assert.equal(state.impacts()[0].scoreRevision, 2);
});

function impact({ scoreRevision = 1, blockIds = [], voices = {}, invalidateAll = false }) {
  return {
    eventType: "clip.replaced",
    scoreRevision,
    blockIds,
    voiceIdsByBlock: voices,
    invalidateAll
  };
}
