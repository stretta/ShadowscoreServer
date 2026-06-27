import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("initial score creates configured voices", () => {
  const score = createInitialScore(defaultConfig);
  assert.equal(score.ensembleId, "berklee-b51");
  assert.deepEqual(Object.keys(score.voices), defaultConfig.ensemble.voices);
  assert.deepEqual(Object.keys(score.assignments), defaultConfig.ensemble.voices);
  assert.deepEqual(Object.keys(score.mesostructure), ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(score.macrostructure.blocks, ["A", "B", "C", "D", "E", "F"]);
  assert.equal(Object.keys(score.clips).length, 36);
  assert.equal(score.macrostructure.tempo, 120);
  assert.deepEqual(score.structureState, { activeBlockId: "A", macroIndex: 0 });
  assert.equal(score.assignments["player-1"].label, "Player 1");
  assert.equal(score.assignments["player-1"].color, "#d1453b");
  assert.deepEqual(score.mesostructure.A.duration, { bars: 4 });
  assert.equal(score.mesostructure.A.players["player-1"].clipId, "a-player-1");
  assert.deepEqual(score.clips["a-player-1"].duration, { bars: 2 });
  assert.equal(score.clips["a-player-1"].notes.length, 2);
  assert.equal(score.clips["a-player-1"].playbackType, "looped");
  for (const block of Object.values(score.mesostructure)) {
    assert.deepEqual(block.duration, { bars: 4 });
    assert.equal(Object.keys(block.players).length, 6);
    for (const assignment of Object.values(block.players)) {
      assert.ok(score.clips[assignment.clipId]);
      assert.ok(score.clips[assignment.clipId].notes.length > 0);
    }
  }
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

test("mesostructural blocks can be added, replaced, and removed at runtime", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const added = store.replaceMesoBlock("G", {
    duration: { beats: 24 },
    scale: { root_note: 2, scale_name: "Dorian" },
    players: {
      "player-1": { clipId: "clip-a" },
      "player-2": "clip-b"
    }
  });
  assert.equal(added.version, 1);
  assert.equal(added.mesostructure.G.duration.beats, 24);
  assert.equal(added.mesostructure.G.players["player-1"].clipId, "clip-a");
  assert.equal(added.mesostructure.G.players["player-2"].clipId, "clip-b");

  const chained = store.updateMacrostructure({ blocks: ["A", "G", "B"] });
  assert.deepEqual(chained.macrostructure.blocks, ["A", "G", "B"]);

  const removed = store.removeMesoBlock("G");
  assert.equal(removed.mesostructure.G, undefined);
  assert.deepEqual(removed.macrostructure.blocks, ["A", "B"]);
});

test("clips can be added, replaced, renamed, and removed", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const added = store.addClip("bass-a", {
    notes: [{ pitch: 48, start_time: 0, duration: 1, velocity: 100 }],
    duration: { bars: 1 },
    behavior: { transposeMode: "chromatic" }
  });
  assert.equal(added.clips["bass-a"].notes[0].pitch, 48);
  assert.deepEqual(added.clips["bass-a"].duration, { bars: 1 });
  assert.equal(added.clips["bass-a"].playbackType, "looped");
  assert.equal(added.clips["bass-a"].behavior.transposeMode, "chromatic");

  const replaced = store.replaceClip("bass-a", {
    notes: [{ pitch: 50, start_time: 0, duration: 1, velocity: 100 }],
    duration: { beats: 2 },
    playbackType: "one-shot"
  });
  assert.equal(replaced.clips["bass-a"].notes[0].pitch, 50);
  assert.deepEqual(replaced.clips["bass-a"].duration, { beats: 2 });
  assert.equal(replaced.clips["bass-a"].playbackType, "one-shot");

  store.replaceMesoBlock("A", {
    duration: { bars: 8 },
    players: { "player-1": { clipId: "bass-a" } }
  });
  assert.throws(() => store.removeClip("bass-a"), /clip 'bass-a' is assigned in A\/player-1/);

  const renamed = store.renameClip("bass-a", "bass-main");
  assert.equal(renamed.clips["bass-a"], undefined);
  assert.equal(renamed.clips["bass-main"].notes[0].pitch, 50);
  assert.equal(renamed.mesostructure.A.players["player-1"].clipId, "bass-main");

  store.replaceMesoBlock("A", { duration: { bars: 8 }, players: {} });
  const removed = store.removeClip("bass-main");
  assert.equal(removed.clips["bass-main"], undefined);
});

test("macrostructure rejects unknown mesostructural blocks", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  assert.throws(
    () => store.updateMacrostructure({ blocks: ["A", "missing"] }),
    /macrostructure references unknown mesostructural block 'missing'/
  );
});

test("structure playhead selects, advances, and resets active blocks", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const selected = store.updateStructureState({ activeBlockId: "C" });
  assert.equal(selected.structureState.activeBlockId, "C");
  assert.equal(selected.structureState.macroIndex, 2);

  const advanced = store.advanceStructurePlayhead();
  assert.equal(advanced.structureState.activeBlockId, "D");
  assert.equal(advanced.structureState.macroIndex, 3);

  const reset = store.resetStructurePlayhead();
  assert.deepEqual(reset.structureState, { activeBlockId: "A", macroIndex: 0 });

  assert.throws(
    () => store.updateStructureState({ activeBlockId: "missing" }),
    /unknown|structureState|activeBlockId/
  );
});

test("structure playhead preserves macro position for repeated block ids", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateMacrostructure({ blocks: ["A", "B", "A"] });

  const firstAdvance = store.advanceStructurePlayhead();
  assert.deepEqual(firstAdvance.structureState, { activeBlockId: "B", macroIndex: 1 });

  const secondAdvance = store.advanceStructurePlayhead();
  assert.deepEqual(secondAdvance.structureState, { activeBlockId: "A", macroIndex: 2 });
});

test("legacy voice notes import into clips assigned to a mesostructural block", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateContext({
    scale: {
      scale_name: "Dorian",
      root_note: 2
    }
  });
  store.replaceVoiceNotes("player-1", [{ pitch: 60, start_time: 0, duration: 1, velocity: 100 }]);
  store.replaceVoiceNotes("player-2", [{ pitch: 67, start_time: 2, duration: 1, velocity: 96 }]);

  const imported = store.importLegacyVoiceNotes({ blockId: "A" });

  assert.equal(imported.clips["player-1-main"].notes[0].pitch, 60);
  assert.equal(imported.clips["player-1-main"].context.scale.scale_name, "Dorian");
  assert.deepEqual(imported.clips["player-1-main"].duration, { bars: 1 });
  assert.equal(imported.clips["player-1-main"].playbackType, "looped");
  assert.equal(imported.clips["player-2-main"].notes[0].pitch, 67);
  assert.equal(imported.mesostructure.A.players["player-1"].clipId, "player-1-main");
  assert.equal(imported.mesostructure.A.players["player-2"].clipId, "player-2-main");
  assert.equal(imported.voices["player-1"].notes[0].pitch, 60);

  store.replaceVoiceNotes("player-1", [{ pitch: 61 }]);
  const repeated = store.importLegacyVoiceNotes({ blockId: "A" });
  assert.equal(repeated.clips["player-1-main"].notes[0].pitch, 60);

  const overwritten = store.importLegacyVoiceNotes({ blockId: "A", overwriteClips: true });
  assert.equal(overwritten.clips["player-1-main"].notes[0].pitch, 61);
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
    },
    mesostructure: {
      Intro: { duration: { bars: 4 }, players: {} }
    },
    macrostructure: {
      tempo: 96,
      blocks: ["Intro"]
    }
  });

  assert.deepEqual(restored.voices.guest.notes, [{ pitch: 72 }]);
  assert.equal(restored.assignments.guest.label, "Guest");
  assert.equal(restored.mesostructure.Intro.duration.bars, 4);
  assert.deepEqual(restored.macrostructure.blocks, ["Intro"]);
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
