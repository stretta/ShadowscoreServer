import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createTempoPolicy } from "../src/playback/tempo-policy.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("tempo policy follows written tempo on block entry and latches manual tempo when disabled", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { ...store.getScore().mesostructure.A, tempo: 120 });
  store.replaceMesoBlock("B", { ...store.getScore().mesostructure.B, tempo: 96 });
  const applied = [];
  const changed = [];
  const policy = createTempoPolicy(store, defaultConfig, {
    applyTempo: async (tempo) => applied.push(tempo),
    onTempoChanged: (tempo) => changed.push(tempo)
  });

  policy.setLiveTempo(108);
  assert.equal(policy.snapshot().live, 108);
  store.advanceStructurePlayhead();
  await policy.flush();
  assert.deepEqual(policy.snapshot(), {
    live: 96,
    written: 96,
    followBlockTempo: true,
    source: "block",
    activeBlockId: "B"
  });

  policy.setFollowBlockTempo(false);
  policy.setLiveTempo(104);
  store.resetStructurePlayhead();
  await policy.flush();
  assert.equal(policy.snapshot().live, 104);
  assert.equal(policy.snapshot().written, 120);
  assert.equal(policy.snapshot().source, "manual");
  assert.deepEqual(applied, [108, 96, 104]);
  assert.deepEqual(changed, [108, 96, 104]);
  policy.close();
});

test("enabling follow is deferred until the next boundary and use-block is explicit", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { ...store.getScore().mesostructure.A, tempo: 90 });
  store.replaceMesoBlock("B", { ...store.getScore().mesostructure.B, tempo: 110 });
  const policy = createTempoPolicy(store, defaultConfig);

  policy.setFollowBlockTempo(false);
  policy.setLiveTempo(100);
  policy.setFollowBlockTempo(true);
  assert.equal(policy.snapshot().live, 100);
  assert.equal(policy.snapshot().written, 90);

  store.advanceStructurePlayhead();
  assert.equal(policy.snapshot().live, 110);
  policy.setLiveTempo(105);
  policy.useBlockTempo();
  assert.equal(policy.snapshot().live, 110);
  assert.equal(policy.snapshot().source, "block");
  assert.throws(() => policy.setLiveTempo(0), /live tempo must be a positive number/);
  policy.close();
});

test("editing the active block written tempo does not silently change live tempo", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const policy = createTempoPolicy(store, defaultConfig);

  store.replaceMesoBlock("A", { ...store.getScore().mesostructure.A, tempo: 88 });

  assert.equal(policy.snapshot().written, 88);
  assert.equal(policy.snapshot().live, 120);
  policy.close();
});
