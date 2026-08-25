import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePlaybackUpdateState,
  createPlaybackUpdateState,
  summarizePlaybackUpdates
} from "../src/playback/playback-update-state.mjs";

test("playback update state preserves one prepared slot per participant", () => {
  let currentTime = Date.parse("2026-08-25T18:10:00.000Z");
  const state = createPlaybackUpdateState({ now: () => currentTime });
  state.recordDelivery(delivery({ blockId: "A", transactionId: 101, hash: "hash-a", prepared: true }));
  currentTime += 1_000;
  state.recordDelivery(delivery({ blockId: "B", transactionId: 102, hash: "hash-b", prepared: true }));

  const blockA = state.get("A", "finch");
  const blockB = state.get("B", "finch");
  assert.equal(blockA.preparedTransaction, null);
  assert.equal(blockA.preparedHash, null);
  assert.equal(blockA.state, "saved-not-active");
  assert.equal(blockB.preparedTransaction, 102);
  assert.equal(blockB.preparedHash, "hash-b");
  assert.equal(blockB.state, "prepared");
});

test("playback update promotion activates only the matching adapter transaction", () => {
  const state = createPlaybackUpdateState();
  state.recordDelivery(delivery({ blockId: "A", transactionId: 201, hash: "hash-a", prepared: true }));
  state.recordDelivery(delivery({ blockId: "B", targetId: "heron", transactionId: 301, hash: "hash-b", prepared: true }));

  state.promote("finch", 201, { ok: true, status: "active" });
  assert.equal(state.get("A", "finch").state, "active");
  assert.equal(state.get("A", "finch").activeHash, "hash-a");
  assert.equal(state.get("A", "finch").preparedTransaction, null);
  assert.equal(state.get("B", "heron").state, "prepared");

  state.promote("heron", 999, { ok: false });
  assert.equal(state.get("B", "heron").state, "saved-not-active");
  assert.equal(state.get("B", "heron").activeTransaction, null);
  assert.equal(state.get("B", "heron").preparedTransaction, null);
});

test("playback update summaries retain unavailable cohort semantics", () => {
  const updates = [
    { targetId: "finch", state: "active" },
    { targetId: "heron", state: "prepared" },
    { targetId: "raven", state: "unavailable" }
  ];
  assert.equal(aggregatePlaybackUpdateState(updates), "prepared");
  assert.deepEqual(summarizePlaybackUpdates(updates), {
    state: "prepared",
    affectedTargetCount: 1,
    preparedTargetCount: 1,
    activeTargetCount: 1,
    participatingTargetCount: 2,
    unavailableTargetCount: 1,
    unavailableTargetIds: ["raven"],
    degraded: true
  });
  assert.equal(aggregatePlaybackUpdateState([{ state: "unavailable" }]), "no-targets");
  assert.equal(aggregatePlaybackUpdateState([{ state: "failed" }]), "failed");
  assert.equal(aggregatePlaybackUpdateState([{ state: "saved-not-active" }]), "saved-not-active");
});

test("playback update desired invalidation and cached reads remain isolated", () => {
  const state = createPlaybackUpdateState();
  state.recordDelivery(delivery({ blockId: "A", transactionId: 401, hash: "hash-a", active: true }));
  state.markDesired({ scoreRevision: 12, type: "clip.replaced" }, (record) => record.blockId === "A");

  const cached = state.cached("A");
  assert.equal(cached.finch.state, "saved-not-active");
  assert.equal(cached.finch.desiredScoreRevision, 12);
  assert.equal(cached.finch.desiredHash, null);
  cached.finch.state = "mutated";
  assert.equal(state.get("A", "finch").state, "saved-not-active");
  assert.equal(state.hasVoice("A", "player-1"), true);
});

function delivery({ blockId, targetId = "finch", transactionId, hash, prepared = false, active = false }) {
  return {
    blockId,
    targetId,
    voiceId: "player-1",
    desiredScoreRevision: 11,
    desiredHash: hash,
    adapterTransactionId: transactionId,
    prepared,
    active,
    failed: false
  };
}
