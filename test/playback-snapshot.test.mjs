import assert from "node:assert/strict";
import test from "node:test";
import { buildPlaybackSnapshot, nextPlaybackSnapshotGeneration } from "../src/playback/playback-snapshot.mjs";

test("playback snapshot generations are monotonic per runtime", () => {
  const left = {};
  const right = {};
  assert.equal(nextPlaybackSnapshotGeneration(left), 1);
  assert.equal(nextPlaybackSnapshotGeneration(left), 2);
  assert.equal(nextPlaybackSnapshotGeneration(right), 1);
});

test("playback snapshot keeps JACK playhead separate from target execution witnesses", () => {
  const snapshot = buildPlaybackSnapshot({
    generation: 8,
    observedAt: Date.parse("2026-07-20T13:07:42.125Z"),
    score: { scoreRevision: 14, structureRevision: 5 },
    tempo: {
      live: 108,
      written: 96,
      followBlockTempo: false,
      source: "manual",
      activeBlockId: "D"
    },
    playback: {
      running: true,
      activeBlockId: "D",
      macroIndex: 7,
      beatIntoBlock: 40.25,
      compositionBeat: 88.25,
      witness: { source: "jack", usable: true, fresh: true }
    },
    jack: {
      status: "fresh",
      ageMs: 12,
      latest: { beatsPerMinute: 100 }
    },
    targets: [{
      id: "finch",
      available: true,
      currentStage: 640,
      sendStatus: {
        transactionId: 1103,
        scoreRevision: 14,
        payloadRevision: "14:D",
        payloadHash: "abc123",
        blockId: "D",
        noteCount: 392,
        transmittedRowCount: 392,
        preparationDurationMs: 2800,
        ack: { ok: true, transactionId: 1103 }
      }
    }],
    timingContracts: [{
      targetId: "finch",
      assignedVoiceId: "player-1",
      timing: { blockId: "D", stagesPerBeat: 16 }
    }]
  });

  assert.equal(snapshot.transport.authority, "jack");
  assert.equal(snapshot.transport.tempo, 108);
  assert.equal(snapshot.tempo.source, "manual");
  assert.equal(snapshot.transport.beatIntoBlock, 40.25);
  assert.equal(snapshot.targets.finch.beatIntoBlock, 40);
  assert.equal(snapshot.targets.finch.phaseErrorBeats, -0.25);
  assert.equal(snapshot.targets.finch.phaseErrorStages, -4);
  assert.equal(snapshot.targets.finch.activeTransaction, 1103);
  assert.equal(snapshot.targets.finch.payloadHash, "abc123");
  assert.equal(snapshot.targets.finch.noteCount, 392);
  assert.equal(snapshot.targets.finch.preparedTransaction, null);
});

test("playback snapshot distinguishes prepared and active RNBO transactions", () => {
  const snapshot = buildPlaybackSnapshot({
    generation: 9,
    observedAt: Date.parse("2026-07-20T13:07:43.125Z"),
    targets: [{
      id: "finch",
      sendStatus: {
        transactionId: 1104,
        activeTransaction: 1103,
        preparedTransaction: 1104,
        activationAcknowledgementAt: "2026-07-20T13:07:43.100Z",
        activationAck: { ok: false, status: "awaiting activation", transactionId: 1104 },
        ack: { ok: true, transactionId: 1104, status: "prepared" }
      }
    }]
  });

  assert.equal(snapshot.targets.finch.activeTransaction, 1103);
  assert.equal(snapshot.targets.finch.preparedTransaction, 1104);
  assert.equal(snapshot.targets.finch.activationAcknowledgement.status, "awaiting activation");
  assert.equal(snapshot.targets.finch.activationAcknowledgementAt, "2026-07-20T13:07:43.100Z");
});

test("playback snapshot exposes shared desired/prepared/active update state", () => {
  const updates = { blockId: "A", state: "saved-not-active", affectedTargetCount: 1 };
  const snapshot = buildPlaybackSnapshot({ updates });
  assert.deepEqual(snapshot.updates, updates);
});
