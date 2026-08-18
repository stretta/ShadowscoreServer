import assert from "node:assert/strict";
import test from "node:test";
import {
  beatToBbt,
  buildAuthoritativeTransportState,
  deriveSyncHealth,
  secondsAtBeat,
  transportObjectDescriptor
} from "../src/transport/authoritative-transport.mjs";

const score = {
  context: { clip: { TimeSignature: { numerator: 4, denominator: 4 } } },
  mesostructure: {
    A: { duration: { bars: 2 }, tempo: 60 },
    B: { duration: { bars: 2 }, tempo: 120 }
  },
  macrostructure: { blocks: ["A", "B"] },
  structureState: { activeBlockId: "A", macroIndex: 0 }
};

test("authoritative transport exposes one musician-facing state", () => {
  const state = buildAuthoritativeTransportState({
    score,
    revision: 12,
    observedAt: "2026-08-17T20:00:00.000Z",
    playbackSnapshot: {
      transport: { authority: "jack", compositionBeat: 10, running: true, tempo: 120 },
      playback: { running: true, compositionBeat: 10 },
      controls: { players: { playing: true }, arrangement: { running: true, requestedMode: "run" } },
      targets: {
        one: { assignedVoiceId: "player-1", online: true, fresh: true, stageReadbackStatus: "fresh", phaseErrorBeats: 0.02 }
      }
    }
  });

  assert.equal(state.object_id, "transport");
  assert.equal(state.revision, 12);
  assert.equal(state.authority, "server");
  assert.equal(state.clock_source, "jack");
  assert.equal(state.is_playing, true);
  assert.equal(state.position_beats, 10);
  assert.equal(state.position_seconds, 9);
  assert.equal(state.duration_beats, 16);
  assert.equal(state.duration_seconds, 12);
  assert.equal(state.position_bbt, "3.3.000");
  assert.equal(state.active_section, "B");
  assert.equal(state.beat_into_section, 2);
  assert.equal(state.sync.state, "aligned");
  assert.deepEqual(state.arrangement.sections.map(({ id, start_beat, end_beat, tempo }) => ({ id, start_beat, end_beat, tempo })), [
    { id: "A", start_beat: 0, end_beat: 8, tempo: 60 },
    { id: "B", start_beat: 8, end_beat: 16, tempo: 120 }
  ]);
});

test("transport time integrates tempo changes and formats bars, beats, and ticks", () => {
  assert.equal(secondsAtBeat(score, 4), 4);
  assert.equal(secondsAtBeat(score, 12), 10);
  assert.equal(secondsAtBeat(score, 100), 12);
  assert.equal(beatToBbt(5.5, 4), "2.2.480");
});

test("sync health distinguishes slipped, stale, and preparing clients", () => {
  assert.equal(deriveSyncHealth({
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: true, phaseErrorBeats: 0, projectedBeatIntoBlock: 1, timing: { stagesPerBeat: 4, patternLength: 32 } },
      two: { assignedVoiceId: "player-2", online: true, fresh: true, phaseErrorBeats: 1, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 4, patternLength: 32 } }
    }
  }).state, "slipped");
  assert.equal(deriveSyncHealth({
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: false, phaseErrorBeats: 0.01 }
    }
  }).state, "stale");
  assert.equal(deriveSyncHealth({
    sendQueue: { inProgress: true },
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: true, phaseErrorBeats: 0.01 }
    }
  }).state, "preparing");
});

test("sync health separates coherent client offset from inter-player slip and respects stage resolution", () => {
  const health = deriveSyncHealth({
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: true, phaseErrorBeats: 0.6, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 1, patternLength: 8 } },
      two: { assignedVoiceId: "player-2", online: true, fresh: true, phaseErrorBeats: 0.6, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 1, patternLength: 8 } }
    }
  });
  assert.equal(health.state, "aligned");
  assert.equal(health.max_client_skew_beats, 0);
  assert.equal(health.tolerance_beats, 0.75);

  const offset = deriveSyncHealth({
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: true, phaseErrorBeats: 0.7, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 4, patternLength: 32 } },
      two: { assignedVoiceId: "player-2", online: true, fresh: true, phaseErrorBeats: 0.7, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 4, patternLength: 32 } }
    }
  });
  assert.equal(offset.state, "offset");
  assert.equal(offset.re_sync_recommended, true);

  const oneStageSlip = deriveSyncHealth({
    targets: {
      one: { assignedVoiceId: "player-1", online: true, fresh: true, phaseErrorBeats: 0, projectedBeatIntoBlock: 2, timing: { stagesPerBeat: 4, patternLength: 32 } },
      two: { assignedVoiceId: "player-2", online: true, fresh: true, phaseErrorBeats: 0.25, projectedBeatIntoBlock: 2.25, timing: { stagesPerBeat: 4, patternLength: 32 } }
    }
  });
  assert.equal(oneStageSlip.state, "slipped");
  assert.equal(oneStageSlip.tolerance_beats, 0.1875);
  assert.equal(oneStageSlip.re_sync_recommended, true);
});

test("transport descriptor is stable for path/object clients", () => {
  assert.equal(transportObjectDescriptor.path, "shadow_score transport");
  assert.ok(transportObjectDescriptor.properties.includes("position_bbt"));
  assert.ok(transportObjectDescriptor.methods.includes("re_sync"));
});

test("stopped transport follows the stored score playhead instead of a stale clock beat", () => {
  const state = buildAuthoritativeTransportState({
    score: { ...score, structureState: { activeBlockId: "B", macroIndex: 1 } },
    playbackSnapshot: {
      transport: { compositionBeat: 0, running: false },
      playback: { compositionBeat: 0, running: false, macroIndex: 0, activeBlockId: "A" },
      controls: { players: { playing: false } }
    }
  });
  assert.equal(state.active_section, "B");
  assert.equal(state.position_beats, 8);
  assert.equal(state.position_bbt, "3.1.000");
});
