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
    controls: {
      players: { playing: true },
      arrangement: { running: false, mode: "hold", requestedMode: "hold", activeBlockId: "D", macroIndex: 7 }
    },
    playback: {
      running: true,
      mode: "jack",
      activeBlockId: "D",
      macroIndex: 7,
      beatIntoBlock: 40.25,
      compositionBeat: 88.25,
      witness: { source: "jack", usable: true, fresh: true }
    },
    jack: {
      status: "fresh",
      ageMs: 12,
      latest: { state: "rolling", beatsPerMinute: 100 }
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
  assert.equal(snapshot.transport.running, true);
  assert.equal(snapshot.transport.rolling, true);
  assert.equal(snapshot.transport.tempo, 108);
  assert.equal(snapshot.tempo.source, "manual");
  assert.equal(snapshot.controls.players.playing, true);
  assert.equal(snapshot.controls.arrangement.mode, "hold");
  assert.equal(snapshot.transport.beatIntoBlock, 40.25);
  assert.equal(snapshot.targets.finch.beatIntoBlock, 40);
  assert.equal(snapshot.targets.finch.phaseErrorBeats, -0.25);
  assert.equal(snapshot.targets.finch.phaseErrorStages, -4);
  assert.equal(snapshot.targets.finch.activeTransaction, 1103);
  assert.equal(snapshot.targets.finch.payloadHash, "abc123");
  assert.equal(snapshot.targets.finch.noteCount, 392);
  assert.equal(snapshot.targets.finch.preparedTransaction, null);
});

test("playback snapshot freezes transport motion when JACK stops without holding the arrangement", () => {
  const snapshot = buildPlaybackSnapshot({
    playback: {
      running: true,
      mode: "jack",
      activeBlockId: "A",
      beatIntoBlock: 3.5,
      witness: { source: "jack", usable: false, fresh: false, reason: "JACK transport stopped" }
    },
    jack: {
      status: "fresh",
      latest: { state: "stopped", beatsPerMinute: 120 }
    }
  });

  assert.equal(snapshot.playback.running, true);
  assert.equal(snapshot.transport.running, true);
  assert.equal(snapshot.transport.rolling, false);
  assert.equal(snapshot.transport.beatIntoBlock, 3.5);
});

test("playback snapshot remains rolling through an RNBO execution fallback", () => {
  const snapshot = buildPlaybackSnapshot({
    playback: {
      running: true,
      mode: "jack",
      activeBlockId: "A",
      beatIntoBlock: 6,
      witness: { source: "rnbo-client", usable: true, fresh: true, absoluteBeat: 6 }
    },
    jack: {
      status: "stale",
      latest: { state: "rolling", beatsPerMinute: 120 }
    }
  });

  assert.equal(snapshot.transport.rolling, true);
  assert.equal(snapshot.playback.beatIntoBlock, 6);
});

test("playback snapshot keeps timer transport moving without JACK", () => {
  const snapshot = buildPlaybackSnapshot({
    playback: {
      running: true,
      mode: "timer",
      activeBlockId: "A",
      beatIntoBlock: 2
    }
  });

  assert.equal(snapshot.transport.running, true);
  assert.equal(snapshot.transport.rolling, true);
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

test("playback snapshot projects timestamped client phase to the coherent boundary and compares across loop wrap", () => {
  const observedAt = Date.parse("2026-08-17T21:00:05.000Z");
  const snapshot = buildPlaybackSnapshot({
    observedAt,
    tempo: { live: 60 },
    playback: {
      running: true,
      mode: "jack",
      beatIntoBlock: 0.1,
      witness: { source: "jack", usable: true, fresh: true }
    },
    jack: {
      status: "fresh",
      latest: { state: "rolling", beatsPerMinute: 60 }
    },
    targets: [{
      id: "slow-client",
      currentStage: 3,
      stateObservedAt: observedAt - 5000
    }],
    timingContracts: [{
      targetId: "slow-client",
      assignedVoiceId: "player-1",
      timing: { stagesPerBeat: 1, patternLength: 8 }
    }],
    staleAfterMs: 10_000
  });

  assert.equal(snapshot.targets["slow-client"].beatIntoBlock, 3);
  assert.equal(snapshot.targets["slow-client"].projectedBeatIntoBlock, 0);
  assert.equal(snapshot.targets["slow-client"].phaseProjectionMs, 5000);
  assert.ok(Math.abs(snapshot.targets["slow-client"].phaseErrorBeats + 0.1) < 0.000001);
});

test("playback snapshot projects player execution while the arrangement is held", () => {
  const observedAt = Date.parse("2026-08-17T21:00:01.000Z");
  const snapshot = buildPlaybackSnapshot({
    observedAt,
    tempo: { live: 120 },
    controls: { players: { playing: true }, arrangement: { running: false } },
    playback: { running: false, mode: "stopped" },
    targets: [{ id: "held-player", currentStage: 4, stateObservedAt: observedAt - 1000 }],
    timingContracts: [{
      targetId: "held-player",
      assignedVoiceId: "player-1",
      timing: { stagesPerBeat: 4, patternLength: 32 }
    }],
    staleAfterMs: 2000
  });
  assert.equal(snapshot.transport.rolling, false);
  assert.equal(snapshot.targets["held-player"].beatIntoBlock, 1);
  assert.equal(snapshot.targets["held-player"].projectedBeatIntoBlock, 3);
});
