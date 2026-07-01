import assert from "node:assert/strict";
import test from "node:test";
import { jackBeatWitness, rnboClientBeatWitness, selectBeatWitness, timerBeatWitness } from "../src/playback/beat-witness.mjs";

test("JACK beat witness requires fresh rolling BBT", () => {
  assert.deepEqual(jackBeatWitness({
    status: "fresh",
    latest: {
      bbtValid: true,
      state: "rolling",
      absoluteBeat: 42.25,
      beatsPerMinute: 121.5
    }
  }), {
    source: "jack",
    usable: true,
    absoluteBeat: 42.25,
    tempo: 121.5,
    fresh: true,
    reason: ""
  });

  assert.deepEqual(jackBeatWitness({
    status: "fresh",
    latest: {
      bbtValid: true,
      state: "stopped",
      absoluteBeat: 42.25,
      beatsPerMinute: 121.5
    }
  }), {
    source: "jack",
    usable: false,
    absoluteBeat: null,
    tempo: null,
    fresh: false,
    reason: "JACK transport stopped"
  });
});

test("beat witness selector keeps timer fallback visibly degraded", () => {
  assert.deepEqual(timerBeatWitness({ running: true, mode: "timer" }), {
    source: "timer",
    usable: true,
    absoluteBeat: null,
    tempo: null,
    fresh: true,
    degraded: true,
    reason: "wall-clock fallback"
  });

  assert.equal(selectBeatWitness({
    running: true,
    mode: "timer",
    jackTransport: {
      status: "fresh",
      latest: {
        bbtValid: true,
        state: "rolling",
        absoluteBeat: 12,
        beatsPerMinute: 120
      }
    }
  }).source, "timer");
});

test("RNBO client witness converts current_stage through the timing contract", () => {
  assert.deepEqual(rnboClientBeatWitness({
    targets: [
      {
        id: "rnbo-inst-2:shadowscore",
        currentStage: 40
      }
    ],
    contracts: [
      {
        targetId: "rnbo-inst-2:shadowscore",
        timing: {
          stagesPerBeat: 16
        }
      }
    ]
  }), {
    source: "rnbo-client",
    usable: true,
    absoluteBeat: 2.5,
    tempo: null,
    fresh: true,
    targetId: "rnbo-inst-2:shadowscore",
    currentStage: 40,
    stagesPerBeat: 16,
    skewBeats: 0,
    targetCount: 1,
    reason: "RNBO current_stage readback"
  });
});

test("RNBO client witness prefers assigned targets", () => {
  assert.deepEqual(rnboClientBeatWitness({
    targets: [
      {
        id: "unassigned",
        currentStage: 0
      },
      {
        id: "assigned",
        currentStage: 32
      }
    ],
    contracts: [
      {
        targetId: "unassigned",
        timing: {
          stagesPerBeat: 16
        }
      },
      {
        targetId: "assigned",
        assignedVoiceId: "player-1",
        timing: {
          stagesPerBeat: 16
        }
      }
    ]
  }), {
    source: "rnbo-client",
    usable: true,
    absoluteBeat: 2,
    tempo: null,
    fresh: true,
    targetId: "assigned",
    assignedVoiceId: "player-1",
    currentStage: 32,
    stagesPerBeat: 16,
    skewBeats: 0,
    targetCount: 1,
    reason: "assigned RNBO current_stage readback"
  });
});

test("RNBO client witness rejects skewed assigned readbacks", () => {
  const witness = rnboClientBeatWitness({
    maxSkewBeats: 0.25,
    targets: [
      {
        id: "left",
        currentStage: 32
      },
      {
        id: "right",
        currentStage: 40
      }
    ],
    contracts: [
      {
        targetId: "left",
        assignedVoiceId: "player-1",
        timing: {
          stagesPerBeat: 16
        }
      },
      {
        targetId: "right",
        assignedVoiceId: "player-2",
        timing: {
          stagesPerBeat: 16
        }
      }
    ]
  });

  assert.equal(witness.usable, false);
  assert.equal(witness.reason, "RNBO current_stage skew 0.5 beats exceeds 0.25");
  assert.equal(witness.skewBeats, 0.5);
  assert.equal(witness.targetCount, 2);
});

test("beat witness selector prefers RNBO client readback when JACK is unusable", () => {
  const witness = selectBeatWitness({
    running: true,
    mode: "jack",
    jackTransport: {
      status: "fresh",
      latest: {
        bbtValid: true,
        state: "stopped",
        absoluteBeat: 12,
        beatsPerMinute: 120
      }
    },
    rnboTargets: [
      {
        id: "rnbo-inst-2:shadowscore",
        currentStage: 32
      }
    ],
    timingContracts: [
      {
        targetId: "rnbo-inst-2:shadowscore",
        timing: {
          stagesPerBeat: 16
        }
      }
    ]
  });

  assert.equal(witness.source, "rnbo-client");
  assert.equal(witness.absoluteBeat, 2);
});
