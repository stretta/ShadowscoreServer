import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("initial score creates configured voices", () => {
  const score = createInitialScore(defaultConfig);
  assert.equal(score.ensembleId, "berklee-b51");
  assert.deepEqual(Object.keys(score.voices), defaultConfig.ensemble.voices);
  assert.deepEqual(Object.keys(score.assignments), defaultConfig.ensemble.voices);
  assert.equal(score.assignments["player-1"].label, "Player 1");
  assert.equal(score.assignments["player-1"].color, "#d1453b");
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

test("voices can be added and removed at runtime", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const added = store.addVoice("player-12", { label: "Player 12", color: "#2457a6" });
  assert.equal(added.version, 1);
  assert.deepEqual(added.voices["player-12"], { version: 0, notes: [] });
  assert.equal(added.assignments["player-12"].label, "Player 12");
  assert.equal(added.assignments["player-12"].color, "#2457a6");

  const removed = store.removeVoice("player-12");
  assert.equal(removed.version, 2);
  assert.equal(removed.voices["player-12"], undefined);
  assert.equal(removed.assignments["player-12"], undefined);
});

test("restore can import voices that are not in the current score", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const restored = store.restore({
    ...createInitialScore(defaultConfig),
    version: 4,
    voices: {
      guest: { version: 3, notes: [{ pitch: 72 }] }
    },
    assignments: {
      guest: { label: "Guest", color: "#2457a6" }
    }
  });

  assert.deepEqual(restored.voices.guest.notes, [{ pitch: 72 }]);
  assert.equal(restored.assignments.guest.label, "Guest");
  assert.equal(restored.voices["player-1"].notes.length, 0);
});

test("voice notes can reject stale collaboration writes", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceVoiceNotes("player-1", [{ pitch: 60 }], { expectedVoiceVersion: 0 });

  assert.throws(
    () => store.replaceVoiceNotes("player-1", [{ pitch: 61 }], { expectedVoiceVersion: 0 }),
    /stale voice 'player-1' version 0; current version is 1/
  );
});

test("score mutations can reject stale score versions", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateContext({ seed: 1 }, { expectedVersion: 0 });

  assert.throws(
    () => store.updateContext({ seed: 2 }, { expectedVersion: 0 }),
    /stale score version 0; current version is 1/
  );
});

test("voice assignments can be replaced and cleared", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const assigned = store.replaceVoiceAssignment("player-1", {
    assignee: "Ari",
    deviceId: "shadowbox-05",
    clientId: 5505,
    rnboTargetId: "rnbo-inst-5:shadowscore",
    rnboHost: "192.168.68.96",
    rnboPort: "1234",
    rnboAddress: "/rnbo/inst/5/messages/in/shadowscore",
    label: "left table",
    color: "#256f86",
    locked: true
  });

  assert.equal(assigned.version, 1);
  assert.equal(assigned.assignments["player-1"].assignee, "Ari");
  assert.equal(assigned.assignments["player-1"].deviceId, "shadowbox-05");
  assert.equal(assigned.assignments["player-1"].clientId, "5505");
  assert.equal(assigned.assignments["player-1"].rnboTargetId, "rnbo-inst-5:shadowscore");
  assert.equal(assigned.assignments["player-1"].rnboHost, "192.168.68.96");
  assert.equal(assigned.assignments["player-1"].rnboPort, 1234);
  assert.equal(assigned.assignments["player-1"].rnboAddress, "/rnbo/inst/5/messages/in/shadowscore");
  assert.equal(assigned.assignments["player-1"].locked, true);

  const cleared = store.clearVoiceAssignment("player-1");
  assert.equal(cleared.version, 2);
  assert.deepEqual(cleared.assignments["player-1"], {
    assignee: "",
    deviceId: "",
    clientId: null,
    rnboTargetId: "",
    rnboHost: "",
    rnboPort: null,
    rnboAddress: "",
    label: "Player 1",
    color: "#d1453b",
    locked: false
  });
});

test("admin reset can clear notes and assignments without changing context", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateContext({ scale: { scale_name: "Aeolian" } });
  store.replaceVoiceAssignment("player-1", { assignee: "Ari" });
  store.replaceVoiceNotes("player-1", [{ pitch: 60 }]);

  const reset = store.reset({ voices: true, assignments: true });

  assert.equal(reset.context.scale.scale_name, "Aeolian");
  assert.deepEqual(reset.voices["player-1"].notes, []);
  assert.equal(reset.voices["player-1"].version, 2);
  assert.equal(reset.assignments["player-1"].assignee, "");
  assert.equal(reset.assignments["player-1"].label, "Player 1");
});

test("unknown voices are rejected", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  assert.throws(() => store.replaceVoiceNotes("player-99", []), /unknown voice/);
  assert.throws(() => store.replaceVoiceAssignment("player-99", {}), /unknown voice/);
});
