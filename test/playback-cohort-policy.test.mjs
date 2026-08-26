import assert from "node:assert/strict";
import test from "node:test";
import {
  activationActionForState,
  evaluatePreparedPlaybackCohort,
  playbackActivationPolicy
} from "../src/playback/playback-cohort-policy.mjs";

test("prepared playback cohort degrades around unavailable assigned voices", () => {
  const cohort = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1", "player-2"],
    states: [{ targetId: "finch", voiceId: "player-1", state: "prepared" }],
    availability: [
      { targetId: "finch", voiceId: "player-1", available: true },
      { targetId: "heron", voiceId: "player-2", available: false }
    ]
  });

  assert.equal(cohort.decision, "ready");
  assert.equal(cohort.ready, true);
  assert.equal(cohort.degraded, true);
  assert.deepEqual(cohort.participatingVoiceIds, ["player-1"]);
  assert.deepEqual(cohort.unavailableVoiceIds, ["player-2"]);
  assert.equal(cohort.unavailableTargetCount, 1);
});

test("prepared playback cohort distinguishes missing, invalid, active, and empty cohorts", () => {
  const missing = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1", "player-2"],
    states: [{ voiceId: "player-1", state: "prepared" }]
  });
  assert.equal(missing.decision, "not-ready");
  assert.deepEqual(missing.missingVoiceIds, ["player-2"]);

  const invalid = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1"],
    states: [{ voiceId: "player-1", state: "failed" }]
  });
  assert.equal(invalid.decision, "not-ready");
  assert.equal(invalid.invalidStates[0].state, "failed");

  const active = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1"],
    states: [{ voiceId: "player-1", state: "active" }]
  });
  assert.equal(active.decision, "already-active");

  const empty = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1"],
    availability: [{ voiceId: "player-1", available: false }]
  });
  assert.equal(empty.decision, "no-targets");
  assert.equal(empty.degraded, true);
});

test("prepared playback cohort ignores states for voices outside the selected block", () => {
  const cohort = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-1"],
    states: [
      { targetId: "finch", voiceId: "player-1", state: "prepared" },
      { targetId: "silent", voiceId: "player-5", state: "activation-failed" }
    ]
  });

  assert.equal(cohort.decision, "ready");
  assert.deepEqual(cohort.participatingStates.map((state) => state.targetId), ["finch"]);
  assert.deepEqual(cohort.invalidStates, []);

  const policy = playbackActivationPolicy([
    { targetId: "finch", voiceId: "player-1", state: "prepared" },
    { targetId: "silent", voiceId: "player-5", state: "activation-failed" }
  ], ["player-1"]);
  assert.equal(policy.reusable, true);
  assert.deepEqual(policy.participating.map((state) => state.targetId), ["finch"]);
});

test("activation policy excludes unavailable targets from readiness and failure", () => {
  const policy = playbackActivationPolicy([
    { targetId: "finch", state: "active" },
    { targetId: "heron", state: "unavailable" }
  ]);
  assert.equal(policy.reusable, true);
  assert.deepEqual(policy.pending, []);
  assert.equal(policy.degraded, true);

  const failed = playbackActivationPolicy([{ targetId: "finch", state: "failed" }]);
  assert.equal(failed.reusable, false);
  assert.equal(failed.pending[0].targetId, "finch");
  assert.equal(activationActionForState("active"), "active");
  assert.equal(activationActionForState("no-targets"), "activation-failed");
  assert.equal(activationActionForState("failed"), "activation-failed");
});

test("activation policy promotes a newer prepared transaction even when stale state is active", () => {
  const staleActive = {
    targetId: "raven",
    voiceId: "player-3",
    state: "active",
    activeTransaction: 15405,
    preparedTransaction: 15418
  };
  const policy = playbackActivationPolicy([staleActive], ["player-3"]);
  assert.equal(policy.reusable, true);
  assert.deepEqual(policy.pending, [staleActive]);

  const cohort = evaluatePreparedPlaybackCohort({
    assignedVoiceIds: ["player-3"],
    states: [staleActive]
  });
  assert.equal(cohort.decision, "ready");
  assert.deepEqual(cohort.preparedStates, [staleActive]);
});
