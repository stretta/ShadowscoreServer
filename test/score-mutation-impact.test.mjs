import assert from "node:assert/strict";
import test from "node:test";
import { impactAffectsRnbo, scoreMutationImpact } from "../src/playback/score-mutation-impact.mjs";

function score(revision = 1) {
  return {
    scoreRevision: revision,
    clips: { shared: {}, other: {} },
    mesostructure: {
      A: { duration: { beats: 4 }, players: { soprano: { clipId: "shared" }, alto: { clipId: "other" } } },
      B: { duration: { beats: 8 }, players: { alto: { clipId: "shared" } } },
      C: { duration: { beats: 4 }, players: {} }
    }
  };
}

test("clip mutation impact includes every referencing block and voice", () => {
  const current = score(12);
  const impact = scoreMutationImpact({ type: "clip.replaced", detail: { clipId: "shared" }, score: current }, score(11));
  assert.deepEqual(impact.blockIds, ["A", "B"]);
  assert.deepEqual(impact.voiceIdsByBlock, { A: ["soprano"], B: ["alto"] });
  assert.equal(impact.scoreRevision, 12);
  assert.equal(impactAffectsRnbo(impact), true);
});

test("orchestration move impact includes source and destination clip players", () => {
  const previous = score(11);
  const current = score(12);
  const impact = scoreMutationImpact({
    type: "clip.note.moved",
    detail: { sourceClipId: "shared", destinationClipId: "other" },
    score: current
  }, previous);
  assert.deepEqual(impact.blockIds, ["A", "B"]);
  assert.deepEqual(impact.voiceIdsByBlock, { A: ["alto", "soprano"], B: ["alto"] });
  assert.equal(impactAffectsRnbo(impact), true);
});

test("unreferenced clip and macro ordering changes cause no RNBO payload impact", () => {
  const current = score(12);
  const clipImpact = scoreMutationImpact({ type: "clip.replaced", detail: { clipId: "unused" }, score: current }, score(11));
  const macroImpact = scoreMutationImpact({ type: "macrostructure.updated", detail: {}, score: current }, score(11));
  assert.equal(impactAffectsRnbo(clipImpact), false);
  assert.equal(impactAffectsRnbo(macroImpact), false);
  assert.equal(macroImpact.scheduleChanged, true);
});

test("block timing changes affect all players in that block", () => {
  const previous = score(11);
  const current = score(12);
  current.mesostructure.A.duration = { beats: 6 };
  const impact = scoreMutationImpact({ type: "mesostructure.block.replaced", detail: { blockId: "A" }, score: current }, previous);
  assert.deepEqual(impact.voiceIdsByBlock.A, ["alto", "soprano"]);
  assert.equal(impact.timingChanged, true);
});

test("block TTID changes affect every assigned playback voice in that block", () => {
  const current = score(12);
  current.mesostructure.A.ttid = 4095;
  const impact = scoreMutationImpact({
    type: "mesostructure.ttid.updated",
    detail: { blockId: "A", ttid: 4095 },
    score: current
  }, score(11));
  assert.deepEqual(impact.blockIds, ["A"]);
  assert.deepEqual(impact.voiceIdsByBlock.A, ["alto", "soprano"]);
  assert.equal(impactAffectsRnbo(impact), true);
});

test("destructive score replacement invalidates every block", () => {
  const current = score(12);
  const impact = scoreMutationImpact({ type: "admin.restore", detail: {}, score: current }, score(11));
  assert.equal(impact.invalidateAll, true);
  assert.deepEqual(impact.blockIds, ["A", "B", "C"]);
  assert.deepEqual(impact.voiceIdsByBlock.B, ["alto"]);
});
