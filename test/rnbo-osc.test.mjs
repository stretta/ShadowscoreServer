import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { compileScoreTransaction, sendScoreTransaction } from "../src/adapters/rnbo-osc.mjs";

test("compiles ensemble score into RNBO ShadowScore transaction messages", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16
    }
  });
  const score = createScore();

  const compiled = compileScoreTransaction(score, config, 123);

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.patternLength, 32);
  assert.deepEqual(compiled.messages[0].values, [1, 123, 1, 2, 32, 16, 0]);
  assert.deepEqual(compiled.messages[1].values, [20, 123, 0, 10, 60, 0, 4, 100, 0, 10000, 0, 64]);
  assert.deepEqual(compiled.messages[2].values, [20, 123, 1, 20, 64, 8, 8, 90, 0, 7500, 2, 50]);
  assert.deepEqual(compiled.messages[3].values, [90, 123, 2, 0]);
});

test("sends one OSC packet per compiled transaction message", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      sendDelayMs: 0,
      log: false
    }
  });
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  const compiled = await sendScoreTransaction(socket, config, createScore(), 124);

  assert.equal(compiled.messages.length, 4);
  assert.equal(packets.length, 4);
  assert.equal(packets[0].host, "127.0.0.1");
  assert.equal(packets[0].port, 9000);
});

function createScore() {
  return {
    ensembleId: "berklee-b51",
    version: 4,
    context: {
      clip: {
        time_selection_start: 0,
        time_selection_end: 2
      },
      scale: {},
      grid: {
        interval: 0.25,
        enabled: 1
      },
      seed: 0
    },
    voices: {
      "player-1": {
        version: 1,
        notes: [
          {
            note_id: 10,
            pitch: 60,
            start_time: 0,
            duration: 0.25,
            velocity: 100,
            mute: 0,
            probability: 1,
            velocity_deviation: 0,
            release_velocity: 64
          }
        ]
      },
      "player-2": {
        version: 1,
        notes: [
          {
            note_id: 20,
            pitch: 64,
            start_time: 0.5,
            duration: 0.5,
            velocity: 90,
            mute: 0,
            probability: 0.75,
            velocity_deviation: 2,
            release_velocity: 50
          }
        ]
      }
    }
  };
}
