import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("initial score creates configured voices", () => {
  const score = createInitialScore(defaultConfig);
  assert.equal(score.ensembleId, "berklee-b51");
  assert.deepEqual(Object.keys(score.voices), defaultConfig.ensemble.voices);
});

test("context updates merge into shared score context", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const score = store.updateContext({
    scale: {
      scale_name: "Aeolian",
      root_note: 9
    }
  });

  assert.equal(score.version, 1);
  assert.equal(score.context.scale.scale_name, "Aeolian");
  assert.equal(score.context.scale.root_note, 9);
  assert.deepEqual(score.context.grid, {});
});

test("voice notes can be replaced from a ShadowScore notes document", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const score = store.replaceVoiceNotes("player-1", {
    notes: [
      {
        note_id: 1,
        pitch: 60,
        start_time: 0,
        duration: 1,
        velocity: 100,
        mute: 0,
        probability: 1,
        velocity_deviation: 0,
        release_velocity: 64
      }
    ]
  });

  assert.equal(score.version, 1);
  assert.equal(score.voices["player-1"].version, 1);
  assert.equal(score.voices["player-1"].notes[0].pitch, 60);
});

test("unknown voices are rejected", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  assert.throws(() => store.replaceVoiceNotes("player-99", []), /unknown voice/);
});
