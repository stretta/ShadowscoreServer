import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("initial score creates configured voices", () => {
  const score = createInitialScore(defaultConfig);
  assert.equal(score.ensembleId, "berklee-b51");
  assert.equal(score.scoreRevision, 0);
  assert.equal(score.structureRevision, 0);
  assert.deepEqual(Object.keys(score.voices), defaultConfig.ensemble.voices);
  assert.deepEqual(Object.keys(score.assignments), defaultConfig.ensemble.voices);
  assert.deepEqual(score.oscAssignments, {});
  assert.deepEqual(score.oscClips, {});
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
    assert.equal(block.scale.scale_name, "Ionian");
    assert.equal(block.ttid, 2741);
    assert.deepEqual(block.oscLayers, {});
    assert.equal(Object.keys(block.players).length, 6);
    for (const assignment of Object.values(block.players)) {
      assert.ok(score.clips[assignment.clipId]);
      assert.ok(score.clips[assignment.clipId].notes.length > 0);
    }
  }
});

test("OSC clips are reusable and block layers are revision-aware", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const events = [];
  store.events.on("change", (event) => events.push(event));

  store.replaceOscAssignment("analog-a", { app: "analogsequencer", deviceId: "wren" });
  const clipped = store.addOscClip("analog-opening", {
    name: "Analog opening",
    schemaVersion: 1,
    app: "analogsequencer",
    params: { GateTime: 0.45, Clock: 0 },
    inputPorts: {}
  }, { expectedScoreRevision: 1, expectedStructureRevision: 0 });
  const saved = store.assignOscLayer("A", "analog-a", "analog-opening", {
    expectedScoreRevision: clipped.scoreRevision,
    expectedStructureRevision: clipped.structureRevision
  });

  assert.equal(saved.mesostructure.A.oscLayers["analog-a"].clipId, "analog-opening");
  assert.equal(saved.oscClips["analog-opening"].params.Clock, 0);
  assert.deepEqual(events.map((event) => event.type), ["osc.assignment.replaced", "osc.clip.added", "mesostructure.oscLayer.assigned"]);

  const duplicated = store.duplicateMesoBlock("A", "A2");
  assert.deepEqual(duplicated.mesostructure.A2.oscLayers, duplicated.mesostructure.A.oscLayers);
  assert.equal(duplicated.oscClips["analog-opening"].params.Clock, 0);
  assert.deepEqual(store.inspectOscClipReferences("analog-opening"), {
    clipId: "analog-opening",
    references: [{ blockId: "A", roleId: "analog-a" }, { blockId: "A2", roleId: "analog-a" }],
    orphan: false
  });
  store.addOscClip("analog-variation", { app: "analogsequencer", params: { Clock: 1 }, inputPorts: {} });
  store.assignOscLayer("A2", "analog-a", "analog-variation");
  assert.equal(store.getScore().mesostructure.A.oscLayers["analog-a"].clipId, "analog-opening");
  assert.equal(store.getScore().mesostructure.A2.oscLayers["analog-a"].clipId, "analog-variation");
  assert.equal(store.getScore().oscClips["analog-opening"].params.Clock, 0);

  assert.throws(() => store.removeOscClip("analog-opening"), /assigned in A\/analog-a/);
  store.removeOscLayer("A", "analog-a");
  store.removeOscLayer("A2", "analog-a");
  assert.deepEqual(store.inspectOscClipReferences().orphanClipIds, ["analog-opening", "analog-variation"]);
  const removed = store.removeOscClip("analog-opening");
  assert.ok(removed.oscClips["analog-variation"]);
  store.removeOscClip("analog-variation");
  assert.equal(events.at(-1).type, "osc.clip.removed");
});

test("OSC role assignments remain separate from player assignments and emit explicit events", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const events = [];
  store.events.on("change", (event) => events.push(event.type));

  const assigned = store.replaceOscAssignment("plate-a", {
    label: "Plate A",
    app: "Plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:main",
    ignoreRecall: true,
    ignoreScale: true,
    locked: true
  }, { expectedScoreRevision: 0 });

  assert.equal(assigned.oscAssignments["plate-a"].app, "plate");
  assert.equal(assigned.oscAssignments["plate-a"].ignoreRecall, true);
  assert.equal(assigned.oscAssignments["plate-a"].ignoreScale, true);
  assert.equal(assigned.assignments["player-1"].deviceId, "");
  assert.equal(assigned.structureRevision, 0);
  assert.deepEqual(events, ["osc.assignment.replaced"]);

  const removed = store.removeOscAssignment("plate-a", { expectedScoreRevision: 1 });
  assert.deepEqual(removed.oscAssignments, {});
  assert.deepEqual(events, ["osc.assignment.replaced", "osc.assignment.removed"]);
});

test("OSC layer and clip replacements enforce role app compatibility", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceOscAssignment("analog-a", { app: "analogsequencer", deviceId: "wren" });
  store.addOscClip("analog-opening", { app: "analogsequencer", params: { Clock: 1 }, inputPorts: {} });
  store.addOscClip("plate-space", { app: "plate", params: { Decay: 0.5 }, inputPorts: {} });
  store.assignOscLayer("A", "analog-a", "analog-opening");

  assert.throws(() => store.assignOscLayer("A", "analog-a", "plate-space"), /incompatible/);
  assert.throws(() => store.replaceOscClip("analog-opening", {
    app: "plate",
    params: { Decay: 0.8 },
    inputPorts: {}
  }), /incompatible/);
  assert.throws(() => store.replaceOscAssignment("analog-a", { app: "plate", deviceId: "wren" }), /incompatible/);
});

test("OSC assignment reconciliation refreshes routing without modifying clips or block layers", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceOscAssignment("plate-a", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:old"
  });
  store.addOscClip("plate-opening", {
    app: "plate",
    params: { Decay: 0.5 },
    inputPorts: {}
  });
  store.assignOscLayer("A", "plate-a", "plate-opening");
  const clipBefore = store.getScore().oscClips["plate-opening"];
  const layerBefore = store.getScore().mesostructure.A.oscLayers["plate-a"];
  const events = [];
  store.events.on("change", (event) => events.push(event.type));

  const reconciled = store.reconcileOscAssignments([{
    id: "heron:plate:new",
    deviceId: "heron",
    unitId: "heron",
    app: "plate",
    status: "online",
    sendable: true,
    capabilities: ["osc", "plate-edit"]
  }]);

  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.assignments["plate-a"].oscTargetId, "heron:plate:new");
  assert.equal(reconciled.assignments["plate-a"].routingStatus, "");
  assert.deepEqual(store.getScore().oscClips["plate-opening"], clipBefore);
  assert.deepEqual(store.getScore().mesostructure.A.oscLayers["plate-a"], layerBefore);
  assert.deepEqual(events, ["osc.assignment.reconciled"]);

  const unchanged = store.reconcileOscAssignments([{
    id: "heron:plate:new",
    deviceId: "heron",
    unitId: "heron",
    app: "plate",
    status: "online",
    sendable: true,
    capabilities: ["osc", "plate-edit"]
  }]);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(events, ["osc.assignment.reconciled"]);
});

test("scores normalize empty OSC collections and restore preserves clips and layers", () => {
  const current = createInitialScore(defaultConfig);
  const oldScore = structuredClone(current);
  delete oldScore.oscAssignments;
  delete oldScore.oscClips;
  for (const block of Object.values(oldScore.mesostructure)) delete block.oscLayers;
  const oldStore = createScoreStore(oldScore);
  assert.deepEqual(oldStore.getScore().oscAssignments, {});
  assert.deepEqual(oldStore.getScore().oscClips, {});
  assert.deepEqual(oldStore.getScore().mesostructure.A.oscLayers, {});

  const source = createScoreStore(current);
  source.replaceOscAssignment("list-a", { app: "listsequencer", deviceId: "finch" });
  source.addOscClip("list-opening", {
    app: "listsequencer",
    params: { Clock: 1 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  });
  source.assignOscLayer("B", "list-a", "list-opening");
  const restored = oldStore.restore(source.getScore());
  assert.equal(restored.oscAssignments["list-a"].deviceId, "finch");
  assert.equal(restored.mesostructure.B.oscLayers["list-a"].clipId, "list-opening");
  assert.deepEqual(restored.oscClips["list-opening"].inputPorts.Steps, [1, 0, 1, 0]);
});

test("structure and OSC assignment resets preserve or clear OSC clips deliberately", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceOscAssignment("plate-a", { app: "plate", deviceId: "heron" });
  store.addOscClip("plate-opening", { app: "plate", params: { Decay: 0.5 }, inputPorts: {} });
  store.assignOscLayer("A", "plate-a", "plate-opening");

  const playerReset = store.reset({ assignments: true });
  assert.ok(playerReset.oscAssignments["plate-a"]);
  assert.ok(playerReset.mesostructure.A.oscLayers["plate-a"]);
  assert.ok(playerReset.oscClips["plate-opening"]);

  const roleReset = store.reset({ oscAssignments: true });
  assert.deepEqual(roleReset.oscAssignments, {});
  assert.ok(roleReset.mesostructure.A.oscLayers["plate-a"]);
  assert.ok(roleReset.oscClips["plate-opening"]);

  const structureReset = store.reset({ structure: true });
  assert.deepEqual(structureReset.mesostructure.A.oscLayers, {});
  assert.deepEqual(structureReset.oscClips, {});
});

test("New Score restores configured empty OSC state after runtime mutations", () => {
  const defaults = createInitialScore(defaultConfig);
  const store = createScoreStore(defaults, { defaultScore: defaults });
  store.replaceOscAssignment("plate-a", { app: "plate", deviceId: "heron" });
  store.addOscClip("plate-opening", { app: "plate", params: { Decay: 0.5 }, inputPorts: {} });
  store.assignOscLayer("A", "plate-a", "plate-opening");

  const created = store.createNewScore();
  assert.deepEqual(created.oscAssignments, {});
  assert.deepEqual(created.oscClips, {});
  assert.deepEqual(created.mesostructure.A.oscLayers, {});
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
  assert.equal(added.scoreRevision, 1);
  assert.equal(added.structureRevision, 1);
  assert.equal(added.mesostructure.G.duration.beats, 24);
  assert.equal(added.mesostructure.G.players["player-1"].clipId, "clip-a");
  assert.equal(added.mesostructure.G.players["player-2"].clipId, "clip-b");

  const chained = store.updateMacrostructure({ blocks: ["A", "G", "B"] });
  assert.equal(chained.scoreRevision, 2);
  assert.equal(chained.structureRevision, 2);
  assert.deepEqual(chained.macrostructure.blocks, ["A", "G", "B"]);

  const removed = store.removeMesoBlock("G");
  assert.equal(removed.scoreRevision, 3);
  assert.equal(removed.structureRevision, 3);
  assert.equal(removed.mesostructure.G, undefined);
  assert.deepEqual(removed.macrostructure.blocks, ["A", "B"]);
});

test("mesostructural blocks can be duplicated with independent assigned clips", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const duplicated = store.duplicateMesoBlock("A", "G");
  assert.equal(duplicated.scoreRevision, 1);
  assert.equal(duplicated.structureRevision, 1);
  assert.deepEqual(duplicated.mesostructure.G.duration, duplicated.mesostructure.A.duration);
  assert.equal(duplicated.mesostructure.A.players["player-1"].clipId, "a-player-1");
  assert.equal(duplicated.mesostructure.G.players["player-1"].clipId, "g-player-1");
  assert.notEqual(
    duplicated.mesostructure.G.players["player-1"].clipId,
    duplicated.mesostructure.A.players["player-1"].clipId
  );
  assert.deepEqual(duplicated.clips["g-player-1"], duplicated.clips["a-player-1"]);

  const edited = store.replaceClip("g-player-1", {
    ...duplicated.clips["g-player-1"],
    notes: [{ pitch: 36, start_time: 0, duration: 1, velocity: 100 }]
  });
  assert.equal(edited.clips["g-player-1"].notes[0].pitch, 36);
  assert.notEqual(edited.clips["a-player-1"].notes[0].pitch, 36);
});

test("block TTID edits are non-destructive and scale transforms commit notes, metadata, scale, and TTID atomically", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const originalPitch = store.getScore().clips["a-player-1"].notes[0].pitch;
  const edited = store.updateBlockTtid("A", 1, { expectedScoreRevision: 0 });
  assert.equal(edited.mesostructure.A.ttid, 1);
  assert.equal(edited.clips["a-player-1"].notes[0].pitch, originalPitch);

  store.replaceClip("a-player-1", {
    ...edited.clips["a-player-1"],
    context: { ...edited.clips["a-player-1"].context, scale: { root_note: 0, scale_name: "Chromatic", scale_intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } },
    notes: [{ pitch: 61 }]
  });
  store.replaceClip("a-player-2", {
    ...store.getScore().clips["a-player-2"],
    behavior: { followsScale: false },
    notes: [{ pitch: 61 }]
  });
  const result = store.transformBlockScale("A", { root_note: 0, scale_name: "Ionian", scale_intervals: [0, 2, 4, 5, 7, 9, 11] });

  assert.equal(result.score.clips["a-player-1"].notes[0].pitch, 62);
  assert.equal(result.score.clips["a-player-1"].context.scale.scale_name, "Ionian");
  assert.equal(result.score.clips["a-player-2"].notes[0].pitch, 61);
  assert.equal(result.score.mesostructure.A.scale.scale_name, "Ionian");
  assert.equal(result.score.mesostructure.A.ttid, 2741);
  assert.equal(result.summary.blockId, "A");
  assert.equal(result.summary.exemptClipCount, 1);
  assert.throws(() => store.replaceMesoBlock("A", {
    ...result.score.mesostructure.A,
    scale: { root_note: 0, scale_name: "Chromatic", scale_intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  }), /must use scale-transform/);
});

test("mesostructural block duplication preserves shared clip assignments inside the copy", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  store.replaceMesoBlock("A", {
    duration: { bars: 4 },
    players: {
      "player-1": { clipId: "a-player-1" },
      "player-2": { clipId: "a-player-1" }
    }
  });
  const duplicated = store.duplicateMesoBlock("A", "G");

  assert.equal(duplicated.mesostructure.G.players["player-1"].clipId, "g-player-1");
  assert.equal(duplicated.mesostructure.G.players["player-2"].clipId, "g-player-1");
  assert.equal(Object.keys(duplicated.clips).filter((clipId) => clipId === "g-player-1").length, 1);
});

test("clips can be added, replaced, renamed, and removed", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));

  const added = store.addClip("bass-a", {
    notes: [{ pitch: 48, start_time: 0, duration: 1, velocity: 100 }],
    duration: { bars: 1 },
    behavior: { transposeMode: "chromatic" }
  });
  assert.equal(added.scoreRevision, 1);
  assert.equal(added.structureRevision, 0);
  assert.equal(added.clips["bass-a"].notes[0].pitch, 48);
  assert.deepEqual(added.clips["bass-a"].duration, { bars: 1 });
  assert.equal(added.clips["bass-a"].playbackType, "looped");
  assert.equal(added.clips["bass-a"].behavior.transposeMode, "chromatic");

  const replaced = store.replaceClip("bass-a", {
    notes: [{ pitch: 50, start_time: 0, duration: 1, velocity: 100 }],
    duration: { beats: 2 },
    playbackType: "one-shot"
  });
  assert.equal(replaced.scoreRevision, 2);
  assert.equal(replaced.structureRevision, 0);
  assert.equal(replaced.clips["bass-a"].notes[0].pitch, 50);
  assert.deepEqual(replaced.clips["bass-a"].duration, { beats: 2 });
  assert.equal(replaced.clips["bass-a"].playbackType, "one-shot");

  store.replaceMesoBlock("A", {
    duration: { bars: 8 },
    players: { "player-1": { clipId: "bass-a" } }
  });
  assert.throws(() => store.removeClip("bass-a"), /clip 'bass-a' is assigned in A\/player-1/);

  const renamed = store.renameClip("bass-a", "bass-main");
  assert.equal(renamed.structureRevision, 2);
  assert.equal(renamed.clips["bass-a"], undefined);
  assert.equal(renamed.clips["bass-main"].notes[0].pitch, 50);
  assert.equal(renamed.mesostructure.A.players["player-1"].clipId, "bass-main");

  store.replaceMesoBlock("A", { duration: { bars: 8 }, players: {} });
  const removed = store.removeClip("bass-main");
  assert.equal(removed.scoreRevision, 6);
  assert.equal(removed.structureRevision, 3);
  assert.equal(removed.clips["bass-main"], undefined);
});

test("new score restores configured defaults after persisted-state boot", () => {
  const defaultScore = createInitialScore(defaultConfig);
  const persistedScore = structuredClone(defaultScore);
  persistedScore.version = 41;
  persistedScore.clips["a-player-2"].notes.push({
    note_id: 3,
    pitch: 37,
    start_time: 1.1875,
    duration: 0.25,
    velocity: 100
  });
  persistedScore.mesostructure.A.players["player-1"] = { clipId: "a-player-2" };
  persistedScore.structureState = { activeBlockId: "E", macroIndex: 4 };
  persistedScore.assignments["player-1"] = {
    ...persistedScore.assignments["player-1"],
    label: "Mutated"
  };

  const store = createScoreStore(persistedScore, { defaultScore });
  const created = store.createNewScore();

  assert.equal(created.version, 42);
  assert.deepEqual(created.clips["a-player-2"].notes, defaultScore.clips["a-player-2"].notes);
  assert.deepEqual(created.mesostructure.A.players["player-1"], { clipId: "a-player-1" });
  assert.deepEqual(created.structureState, { activeBlockId: "A", macroIndex: 0 });
  assert.equal(created.assignments["player-1"].label, "Player 1");
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
    locked: false,
    routingStatus: "",
    routingMessage: ""
  });
});

test("voice assignments reject duplicate RNBO targets", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceVoiceAssignment("player-1", {
    rnboTargetId: "rnbo-inst-5:shadowscore",
    rnboHost: "192.168.68.96",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/5/messages/in/shadowscore"
  });

  assert.throws(
    () => store.replaceVoiceAssignment("player-2", {
      rnboTargetId: "rnbo-inst-5:shadowscore",
      rnboHost: "192.168.68.96",
      rnboPort: 1234,
      rnboAddress: "/rnbo/inst/5/messages/in/shadowscore"
    }),
    /RNBO target 'rnbo-inst-5:shadowscore' is already assigned to player-1/
  );
});

test("admin reset can clear notes and assignments without changing context", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateContext({ scale: { scale_name: "Aeolian" } });
  store.replaceVoiceAssignment("player-1", { assignee: "Ari" });
  store.replaceVoiceNotes("player-1", [{ pitch: 60 }]);
  store.replaceClip("a-player-1", { notes: [{ pitch: 67 }] });

  const reset = store.reset({ notes: true, assignments: true });

  assert.equal(reset.context.scale.scale_name, "Aeolian");
  assert.deepEqual(reset.voices["player-1"].notes, []);
  assert.deepEqual(reset.clips["a-player-1"].notes, []);
  assert.equal(reset.voices["player-1"].version, 2);
  assert.equal(reset.assignments["player-1"].assignee, "");
  assert.equal(reset.assignments["player-1"].label, "Player 1");
  assert.equal(reset.structureRevision, 0);
});

test("admin reset bumps structure revision when structure is reset", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("G", { duration: { bars: 2 }, players: {} });

  const reset = store.reset({ structure: true });

  assert.equal(reset.scoreRevision, 2);
  assert.equal(reset.structureRevision, 2);
  assert.equal(reset.mesostructure.G, undefined);
});

test("unknown voices are rejected", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  assert.throws(() => store.replaceVoiceNotes("player-99", []), /unknown voice/);
  assert.throws(() => store.replaceVoiceAssignment("player-99", {}), /unknown voice/);
});
