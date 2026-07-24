import assert from "node:assert/strict";
import test from "node:test";
import { createScoreInitializationPlan } from "../src/state/score-initialization.mjs";

const request = {
  name: "Small ensemble",
  players: [
    { id: "player-1", label: "One" },
    { id: "player-2", label: "Two" }
  ],
  clips: [
    { id: "a-one", notes: [], duration: { bars: 1 }, playbackType: "looped" },
    { id: "a-two", notes: [{ pitch: 60, start_time: 0, duration: 1, velocity: 96 }], duration: { bars: 1 } }
  ],
  blocks: [
    { id: "A", duration: { bars: 1 }, players: { "player-1": "a-one", "player-2": { clipId: "a-two" } } }
  ],
  macrostructure: { tempo: 96, blocks: ["A", "A"] },
  oscRoles: [
    { id: "analog-1", app: "Analog Sequencer", label: "Analog 1" },
    { id: "plate-1", app: "plate" }
  ]
};

test("score initialization builds an exact device-free score skeleton", () => {
  const plan = createScoreInitializationPlan(request, { ensembleId: "test-ensemble" });

  assert.equal(plan.score.ensembleId, "test-ensemble");
  assert.deepEqual(Object.keys(plan.score.voices), ["player-1", "player-2"]);
  assert.equal(plan.score.assignments["player-1"].label, "One");
  assert.equal(plan.score.assignments["player-1"].rnboTargetId, "");
  assert.equal(plan.score.oscAssignments["analog-1"].app, "analog-sequencer");
  assert.equal(plan.score.oscAssignments["analog-1"].oscTargetId, "");
  assert.deepEqual(plan.score.mesostructure.A.players, { "player-1": "a-one", "player-2": "a-two" });
  assert.deepEqual(plan.score.mesostructure.A.oscLayers, {});
  assert.equal(plan.score.mesostructure.A.scale.scale_name, "Ionian");
  assert.equal(plan.score.mesostructure.A.ttid, 2741);
  assert.equal(plan.score.mesostructure.A.tempo, 96);
  assert.deepEqual(plan.score.macrostructure, { blocks: ["A", "A"] });
  assert.deepEqual(plan.score.structureState, { activeBlockId: "A", macroIndex: 0 });
  assert.equal(plan.summary.emptyOscLayerSlotCount, 2);
  assert.equal(plan.summary.deviceMappingCount, 0);
  assert.equal(plan.summary.noteCount, 1);
});

test("score initialization rejects broken references before producing a score", () => {
  assert.throws(
    () => createScoreInitializationPlan({ ...request, blocks: [{ id: "A", players: { "player-1": "missing" } }] }),
    /references unknown clip 'missing'/
  );
  assert.throws(
    () => createScoreInitializationPlan({ ...request, macrostructure: { tempo: 120, blocks: ["B"] } }),
    /macrostructure references unknown block 'B'/
  );
  assert.throws(
    () => createScoreInitializationPlan({ ...request, blocks: [{ ...request.blocks[0], tempo: 0 }] }),
    /block 'A' tempo must be a positive number/
  );
  assert.throws(
    () => createScoreInitializationPlan({ ...request, players: [...request.players, request.players[0]] }),
    /duplicate player id 'player-1'/
  );
  assert.throws(
    () => createScoreInitializationPlan({ ...request, oscRoles: [{ id: "analog-1", app: "analogsequencer", deviceId: "wren" }] }),
    /use rig discovery\/onboarding for live mappings/
  );
});
