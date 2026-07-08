import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { compileScoreTransaction, compileTimingContract, createRnboOscAdapter, rnboTargetSignature, scoreTransportInportMessages, sendScoreTransaction, shouldSendScoreTransaction, tempoAuthority, validateScoreTransactionAck } from "../src/adapters/rnbo-osc.mjs";

test("compiles ensemble score into RNBO ShadowScore transaction messages", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0,
      targets: [
        {
          address: "/rnbo/inst/2/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ]
    }
  });
  const score = createScore();

  const compiled = compileScoreTransaction(score, config, 123);

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.patternLength, 32);
  assert.equal(compiled.stagesPerBeat, 16);
  assert.deepEqual(compiled.timing, {
    blockId: "",
    stagesPerBeat: 16,
    ticksPerStage: 30,
    patternLength: 32,
    maxStages: 4096,
    maxNoteRows: 819,
    resolutionMode: "fixed",
    quantizationError: null
  });
  assert.deepEqual(compiled.messages[0].values, [1, 123, 1, 2, 32, 16, 0]);
  assert.deepEqual(compiled.messages[1].values, [20, 123, 0, 10, 60, 0, 4, 100, 0, 10000, 0, 64]);
  assert.deepEqual(compiled.messages[2].values, [20, 123, 1, 20, 64, 8, 8, 90, 0, 7500, 2, 50]);
  assert.deepEqual(compiled.messages[3].values, [90, 123, 2, 0]);
});

test("RNBO target signature is stable across ordering and changes on reload-sensitive fields", () => {
  const a = {
    id: "rnbo-inst-5:shadowscore",
    instanceId: "5",
    host: "127.0.0.1",
    port: 1234,
    address: "/rnbo/inst/5/messages/in/shadowscore",
    capabilities: {
      maxStages: 4096,
      maxNoteRows: 819,
      noteDataFloatCount: 8192
    }
  };
  const b = {
    id: "peer:rnbo-inst-2:shadowscore",
    localId: "rnbo-inst-2:shadowscore",
    instanceId: "2",
    host: "192.168.68.88",
    port: 1234,
    address: "/rnbo/inst/2/messages/in/shadowscore"
  };

  assert.equal(rnboTargetSignature([a, b]), rnboTargetSignature([b, a]));
  assert.notEqual(rnboTargetSignature([a]), rnboTargetSignature([{ ...a, instanceId: "6", address: "/rnbo/inst/6/messages/in/shadowscore" }]));
  assert.notEqual(rnboTargetSignature([a]), rnboTargetSignature([{ ...a, available: false }]));
});

test("builds a fixed timing contract from config and target capabilities", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 12,
      resolution: {
        mode: "fixed",
        defaultStagesPerBeat: 24,
        maxStages: 4096,
        maxNoteRows: 819
      },
      transport: {
        ClockInterval: 80
      }
    }
  });

  const timing = compileTimingContract(createScore(), config, {
    capabilities: {
      maxStages: 1024,
      maxNoteRows: 256
    }
  }, {
    blockId: "A",
    selectionStart: 2,
    selectionEnd: 6
  });

  assert.deepEqual(timing, {
    blockId: "A",
    stagesPerBeat: 24,
    ticksPerStage: 20,
    patternLength: 96,
    maxStages: 1024,
    maxNoteRows: 256,
    resolutionMode: "fixed",
    quantizationError: null
  });
});

test("fit timing contract chooses the highest 480-grid resolution that fits target stages", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fit",
        defaultStagesPerBeat: 16,
        maxStages: 4096,
        maxNoteRows: 819,
        candidateStagesPerBeat: [1, 2, 4, 8, 16, 24, 30, 48, 60, 80, 96, 120, 160, 240, 480]
      },
      transport: {
        ClockInterval: 999
      }
    }
  });

  const shortBlock = compileTimingContract(createScore(), config, {
    capabilities: { maxStages: 1024 }
  }, {
    blockId: "short",
    selectionStart: 0,
    selectionEnd: 4
  });
  const longBlock = compileTimingContract(createScore(), config, {
    capabilities: { maxStages: 1024 }
  }, {
    blockId: "long",
    selectionStart: 0,
    selectionEnd: 64
  });

  assert.equal(shortBlock.stagesPerBeat, 240);
  assert.equal(shortBlock.ticksPerStage, 2);
  assert.equal(shortBlock.patternLength, 960);
  assert.equal(longBlock.stagesPerBeat, 16);
  assert.equal(longBlock.ticksPerStage, 30);
  assert.equal(longBlock.patternLength, 1024);
});

test("fit transactions send derived ClockInterval with compiled MaxSteps", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      resolution: {
        mode: "fit",
        maxStages: 1024,
        candidateStagesPerBeat: [16, 24, 30, 48, 60, 80, 96, 120, 160, 240, 480]
      },
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      transport: {
        Tempo: 120,
        ClockInterval: 999
      }
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

  assert.equal(compiled.stagesPerBeat, 480);
  assert.equal(compiled.patternLength, 960);
  assert.deepEqual(scoreTransportInportMessages(config, compiled), [
    { name: "ClockInterval", value: 1 },
    { name: "MaxSteps", value: 960 }
  ]);
  assert.deepEqual(packets.slice(-2).map(({ packet }) => readOscAddress(packet)), [
    "/rnbo/inst/2/messages/in/ClockInterval",
    "/rnbo/inst/2/messages/in/MaxSteps"
  ]);
});

test("fidelity timing contract chooses the lowest grid that meets the error target", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fidelity",
        maxStages: 4096,
        quantizationErrorTargetBeats: 0,
        candidateStagesPerBeat: [16, 32, 64, 128]
      }
    }
  });

  const timing = compileTimingContract(createScore(), config, {}, {
    selectionStart: 0,
    selectionEnd: 2,
    notes: [
      { start_time: 0.03125, duration: 0.09375 },
      { start_time: 0.5, duration: 0.25 }
    ]
  });

  assert.equal(timing.stagesPerBeat, 32);
  assert.equal(timing.ticksPerStage, 15);
  assert.equal(timing.patternLength, 64);
  assert.deepEqual(timing.quantizationError, {
    targetBeats: 0,
    noteCount: 2,
    worstBeats: 0,
    worstOnsetBeats: 0,
    worstDurationBeats: 0,
    meanAbsoluteBeats: 0,
    meanSignedOnsetBeats: 0,
    meanSignedDurationBeats: 0
  });
});

test("fidelity timing contract reports quantization sloppiness and beat-relative offset", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fidelity",
        maxStages: 4096,
        quantizationErrorTargetBeats: 0,
        candidateStagesPerBeat: [16]
      }
    }
  });

  const timing = compileTimingContract(createScore(), config, {}, {
    selectionStart: 0,
    selectionEnd: 2,
    notes: [
      { start_time: 0.03125, duration: 0.09375 }
    ]
  });

  assert.equal(timing.stagesPerBeat, 16);
  assert.deepEqual(timing.quantizationError, {
    targetBeats: 0,
    noteCount: 1,
    worstBeats: 0.03125,
    worstOnsetBeats: 0.03125,
    worstDurationBeats: 0.03125,
    meanAbsoluteBeats: 0.03125,
    meanSignedOnsetBeats: 0.03125,
    meanSignedDurationBeats: 0.03125
  });
});

test("hybrid timing contract falls back to fit when fidelity target cannot be met", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "hybrid",
        maxStages: 1024,
        quantizationErrorTargetBeats: 0,
        candidateStagesPerBeat: [16, 32]
      }
    }
  });

  const timing = compileTimingContract(createScore(), config, {}, {
    selectionStart: 0,
    selectionEnd: 64,
    notes: [
      { start_time: 0.03125, duration: 0.09375 }
    ]
  });

  assert.equal(timing.stagesPerBeat, 16);
  assert.equal(timing.patternLength, 1024);
  assert.equal(timing.quantizationError.worstBeats, 0.03125);
});

test("compiles client-prefixed transactions for a specific voice target", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0,
      targets: [
        {
          voiceId: "player-2",
          clientId: 4404,
          address: "/rnbo/inst/4/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ]
    }
  });

  const compiled = compileScoreTransaction(createScore(), config, 321, config.rnbo.targets[0]);

  assert.equal(compiled.noteCount, 1);
  assert.deepEqual(compiled.messages[0].values, [4404, 1, 321, 1, 1, 32, 16, 0]);
  assert.deepEqual(compiled.messages[1].values, [4404, 20, 321, 0, 20, 64, 8, 8, 90, 0, 7500, 2, 50]);
  assert.deepEqual(compiled.messages[2].values, [4404, 90, 321, 1, 0]);
});

test("compiles the active mesostructural block from assigned clips", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const score = createScore();
  delete score.context.clip.time_selection_end;
  score.voices["player-1"].notes = [{ note_id: 99, pitch: 72, start_time: 0, duration: 1, velocity: 100 }];
  score.clips = {
    "bass-a": {
      notes: [{ note_id: 7, pitch: 48, start_time: 0, duration: 1, velocity: 96 }],
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      playbackType: "one-shot",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    },
    "lead-a": {
      notes: [{ note_id: 8, pitch: 67, start_time: 1, duration: 0.5, velocity: 88 }],
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      playbackType: "one-shot",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { beats: 8 },
      scale: {},
      players: {
        "player-1": { clipId: "bass-a" },
        "player-2": { clipId: "lead-a" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 222);

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.patternLength, 128);
  assert.equal(compiled.timing.blockId, "A");
  assert.deepEqual(compiled.messages[1].values, [20, 222, 0, 7, 48, 0, 16, 96, 0, 10000, 0, 64]);
  assert.deepEqual(compiled.messages[2].values, [20, 222, 1, 8, 67, 16, 8, 88, 0, 10000, 0, 64]);
});

test("compiles short-form mesostructural clip assignments", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const score = createScore();
  delete score.context.clip.time_selection_end;
  score.voices["player-1"].notes = [{ note_id: 99, pitch: 72, start_time: 0, duration: 1, velocity: 100 }];
  score.clips = {
    "bass-a": {
      notes: [{ note_id: 7, pitch: 48, start_time: 0, duration: 1, velocity: 96 }],
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      playbackType: "one-shot",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { beats: 4 },
      scale: {},
      players: {
        "player-1": "bass-a"
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 223);

  assert.equal(compiled.noteCount, 1);
  assert.deepEqual(compiled.messages[1].values, [20, 223, 0, 7, 48, 0, 16, 96, 0, 10000, 0, 64]);
});

test("looped clips repeat across the containing mesostructural block duration", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const score = createScore();
  delete score.context.clip.time_selection_end;
  score.clips = {
    "bass-loop": {
      notes: [{ note_id: 7, pitch: 48, start_time: 0, duration: 1, velocity: 96 }],
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      duration: { bars: 1 },
      playbackType: "looped",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { bars: 8 },
      scale: {},
      players: {
        "player-1": { clipId: "bass-loop" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 333);

  assert.equal(compiled.noteCount, 8);
  assert.equal(compiled.patternLength, 512);
  assert.deepEqual(compiled.messages.slice(1, 9).map((message) => message.values[5]), [0, 64, 128, 192, 256, 320, 384, 448]);
});

test("clip bar duration uses the clip time signature when looped in a block", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const score = createScore();
  delete score.context.clip.time_selection_end;
  score.clips = {
    "three-four": {
      notes: [{ note_id: 7, pitch: 48, start_time: 0, duration: 1, velocity: 96 }],
      context: { clip: { TimeSignature: { numerator: 3, denominator: 4 } }, scale: {}, grid: {}, seed: 0 },
      duration: { bars: 1 },
      playbackType: "looped",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { beats: 6 },
      scale: {},
      players: {
        "player-1": { clipId: "three-four" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 444);

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.patternLength, 96);
  assert.deepEqual(compiled.messages.slice(1, 3).map((message) => message.values[5]), [0, 48]);
});

test("mesostructural block scale transposes assigned clips during playback compilation", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const score = createScore();
  delete score.context.clip.time_selection_end;
  score.clips = {
    melody: {
      notes: [
        { note_id: 1, pitch: 60, start_time: 0, duration: 1, velocity: 96 },
        { note_id: 2, pitch: 64, start_time: 1, duration: 1, velocity: 96 }
      ],
      context: { clip: {}, scale: { root_note: 0, scale_name: "major" }, grid: {}, seed: 0 },
      duration: { beats: 2 },
      playbackType: "one-shot",
      behavior: { followsPitch: true, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { beats: 4 },
      scale: { root_note: 2, scale_name: "major" },
      players: {
        "player-1": { clipId: "melody" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 555);

  assert.equal(compiled.noteCount, 2);
  assert.deepEqual(compiled.messages.slice(1, 3).map((message) => message.values[4]), [62, 66]);
});

test("pads clear rows to the target row capacity so RNBO playback lookup overwrites stale note rows", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 64
    }
  });
  const score = createScore();
  score.voices["player-1"].notes = [];
  score.voices["player-2"].notes = [];

  const compiled = compileScoreTransaction(score, config, 901, {
    capabilities: {
      maxNoteRows: 819
    }
  });

  assert.equal(compiled.noteCount, 0);
  assert.equal(compiled.transmittedRowCount, 819);
  assert.equal(compiled.messages.length, 821);
  assert.deepEqual(compiled.messages[0].values, [1, 901, 1, 819, 32, 16, 0]);
  assert.deepEqual(compiled.messages[1].values, [20, 901, 0, 0, 0, 0, 1, 0, 1, 0, 0, 64]);
  assert.deepEqual(compiled.messages[819].values, [20, 901, 818, 0, 0, 0, 1, 0, 1, 0, 0, 64]);
  assert.deepEqual(compiled.messages[820].values, [90, 901, 819, 0]);
});

test("compact-capable RNBO targets send only actual note rows", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 64
    }
  });
  const compiled = compileScoreTransaction(createScore(), config, 902, {
    capabilities: {
      maxNoteRows: 819,
      ...compactReplaceCapabilities()
    }
  });

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.transmittedRowCount, 2);
  assert.equal(compiled.replacementMode, "compact");
  assert.equal(compiled.compactScoreReplace, true);
  assert.deepEqual(compiled.messages[0].values, [1, 902, 1, 2, 32, 16, 0]);
  assert.deepEqual(compiled.messages.at(-1).values, [90, 902, 2, 0]);
});

test("full-clear option forces capacity rows for compact-capable RNBO targets", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 64
    }
  });
  const score = createScore();
  score.voices["player-1"].notes = [];
  score.voices["player-2"].notes = [];

  const compiled = compileScoreTransaction(score, config, 903, {
    capabilities: {
      maxNoteRows: 819,
      ...compactReplaceCapabilities()
    }
  }, {
    forceFullClearRows: true
  });

  assert.equal(compiled.noteCount, 0);
  assert.equal(compiled.transmittedRowCount, 819);
  assert.equal(compiled.replacementMode, "legacy-full-clear");
  assert.equal(compiled.compactScoreReplace, false);
  assert.equal(compiled.forceFullClearRows, true);
  assert.deepEqual(compiled.messages[0].values, [1, 903, 1, 819, 32, 16, 0]);
});

test("sends one OSC packet per compiled transaction message", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      targets: [
        {
          address: "/rnbo/inst/2/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ]
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
  assert.equal(packets.length, compiled.messages.length + 2);
  assert.equal(packets[0].host, "127.0.0.1");
  assert.equal(packets[0].port, 9000);
  assert.equal(readOscAddress(packets[0].packet), "/rnbo/inst/2/messages/in/shadowscore");
  assert.equal(readOscAddress(packets[5].packet), "/rnbo/inst/2/messages/in/MaxSteps");
});

test("link tempo authority omits Tempo from routine score transport writes", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      transport: {
        Tempo: 132.5,
        ClockInterval: 100,
        MaxSteps: 16
      }
    }
  });
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  await sendScoreTransaction(socket, config, createScore(), 124);

  assert.equal(tempoAuthority(config), "link");
  assert.deepEqual(packets.slice(-2).map(({ packet }) => readOscAddress(packet)), [
    "/rnbo/inst/2/messages/in/ClockInterval",
    "/rnbo/inst/2/messages/in/MaxSteps"
  ]);
  assert.deepEqual(scoreTransportInportMessages(config, { patternLength: 32 }), [
    { name: "ClockInterval", value: 100 },
    { name: "MaxSteps", value: 32 }
  ]);
});

test("server tempo authority sends Tempo with routine score transport writes", async () => {
  const config = mergeConfig(defaultConfig, {
    transport: {
      tempoAuthority: "server"
    },
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      transport: {
        Tempo: 132.5,
        ClockInterval: 100,
        MaxSteps: 16
      }
    }
  });
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  await sendScoreTransaction(socket, config, createScore(), 124);

  assert.equal(tempoAuthority(config), "server");
  assert.deepEqual(packets.slice(-3).map(({ packet }) => readOscAddress(packet)), [
    "/rnbo/inst/2/messages/in/Tempo",
    "/rnbo/inst/2/messages/in/ClockInterval",
    "/rnbo/inst/2/messages/in/MaxSteps"
  ]);
  assert.deepEqual(scoreTransportInportMessages(config, { patternLength: 32 }), [
    { name: "Tempo", value: 132.5 },
    { name: "ClockInterval", value: 100 },
    { name: "MaxSteps", value: 32 }
  ]);
});

test("configured RNBO target capabilities constrain score transactions", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      resolution: {
        mode: "fit",
        maxStages: 4096,
        candidateStagesPerBeat: [16, 60, 120, 240, 480]
      },
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      targets: [
        {
          id: "legacy-client",
          address: "/rnbo/inst/2/messages/in/shadowscore",
          capabilities: {
            maxStages: 1024,
            maxNoteRows: 256
          }
        }
      ]
    }
  });
  const score = createScore();
  score.context.clip.time_selection_end = 16;
  const socket = {
    send(packet, port, host, callback) {
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, score, 501);

  assert.equal(result.timing.maxStages, 1024);
  assert.equal(result.timing.maxNoteRows, 256);
  assert.equal(result.timing.stagesPerBeat, 60);
  assert.equal(result.patternLength, 960);
});

test("sends one transaction per configured RNBO target", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      targets: [
        {
          voiceId: "player-1",
          clientId: 5505,
          address: "/rnbo/inst/5/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        },
        {
          voiceId: "player-2",
          clientId: 4404,
          address: "/rnbo/inst/4/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ]
    }
  });
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, createScore(), 500);

  assert.equal(result.targets.length, 2);
  assert.equal(packets.length, 10);
  assert.equal(packets.map(({ packet }) => readOscAddress(packet)).includes("/rnbo/inst/5/messages/in/Tempo"), false);
  assert.equal(packets.map(({ packet }) => readOscAddress(packet)).includes("/rnbo/inst/4/messages/in/Tempo"), false);
});

test("sends score updates to assignment-bound RNBO targets", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false
    }
  });
  const score = createScore();
  score.assignments = {
    "player-1": {
      rnboTargetId: "rnbo-inst-2:shadowscore",
      rnboHost: "192.168.68.96",
      rnboPort: 1234,
      rnboAddress: "/rnbo/inst/2/messages/in/shadowscore",
      clientId: "2202"
    }
  };
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, score, 700);

  assert.equal(result.noteCount, 1);
  assert.equal(packets.length, result.messages.length + 2);
  assert.equal(packets[0].host, "192.168.68.96");
  assert.equal(packets[0].port, 1234);
  assert.deepEqual(result.messages[0].values, [2202, 1, 700, 1, 819, 32, 16, 0]);
  assert.equal(result.replacementMode, "legacy-full-clear");
  assert.equal(packets.map(({ packet }) => readOscAddress(packet)).includes("/rnbo/inst/2/messages/in/Tempo"), false);
});

test("assignment-bound RNBO targets inherit live target connection details", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false
    }
  });
  const score = createScore();
  score.assignments = {
    "player-1": {
      rnboTargetId: "peer-a:rnbo-inst-4:shadowscore",
      rnboHost: "192.168.68.67",
      rnboPort: 1234,
      rnboAddress: "/rnbo/inst/4/messages/in/shadowscore",
      clientId: null
    }
  };
  const packets = [];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };
  const runtime = {
    peerRegistry: {
      targets() {
        return [
          {
            id: "peer-a:rnbo-inst-4:shadowscore",
            localId: "rnbo-inst-4:shadowscore",
            host: "192.168.68.88",
            port: 1234,
            address: "/rnbo/inst/4/messages/in/shadowscore",
            clientId: "90",
            capabilities: compactReplaceCapabilities()
          }
        ];
      }
    }
  };

  const result = await sendScoreTransaction(socket, config, score, 701, { runtime });

  assert.equal(packets[0].host, "192.168.68.88");
  assert.equal(packets[0].port, 1234);
  assert.deepEqual(result.messages[0].values, [90, 1, 701, 1, 1, 32, 16, 0]);
  assert.deepEqual(result.messages.at(-1).values, [90, 90, 701, 1, 0]);
});

test("score transaction retries once when RNBO ACK reports a rejected commit", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      targets: [
        {
          address: "/rnbo/inst/2/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ],
      oscQuery: {
        enabled: true,
        url: "http://127.0.0.1:5678/"
      },
      ack: {
        enabled: true,
        retries: 1,
        retryDelayMs: 0,
        settleMs: 0
      }
    }
  });
  const packets = [];
  const ackValues = [
    [91, 702, 0, -1, -1],
    [90, 702, 1, 1, 1]
  ];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, createScore(), 702, {
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        return { VALUE: ackValues.shift(), url };
      }
    })
  });

  assert.equal(result.ack.ok, true);
  assert.equal(result.ack.status, "committed");
  assert.equal(result.ack.attempt, 1);
  assert.equal(packets.length, 12);
});

test("score transaction surfaces stale or failed RNBO ACK state without throwing", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      stagesPerBeat: 16,
      clearRowCount: 0,
      sendDelayMs: 0,
      log: false,
      oscQuery: {
        enabled: true,
        url: "http://127.0.0.1:5678/"
      },
      ack: {
        enabled: true,
        retries: 0,
        settleMs: 0
      }
    }
  });
  const socket = {
    send(packet, port, host, callback) {
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, createScore(), 703, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { VALUE: [90, 700, 1, 1, 1] };
      }
    })
  });

  assert.equal(result.ack.ok, false);
  assert.equal(result.ack.status, "stale transaction");
  assert.equal(result.ack.expectedTransactionId, 703);
  assert.equal(result.ack.transactionId, 700);
});

test("validates operational RNBO ACK failure states", () => {
  const mismatch = validateScoreTransactionAck([90, 705, 2, 819, 1], {
    compiled: { noteCount: 3, transmittedRowCount: 819, validateAckNoteCount: true },
    transactionId: 705
  });
  const rejected = validateScoreTransactionAck([91, 705, 0, 0, -1], {
    compiled: { noteCount: 3, transmittedRowCount: 819 },
    transactionId: 705
  });

  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, "note count mismatch");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "rejected");
});

test("validates client-prefixed RNBO commit ACKs", () => {
  const ack = validateScoreTransactionAck([90, 90, 704, 74, 64, 1], {
    target: { clientId: "90" },
    compiled: { noteCount: 13, transmittedRowCount: 819 },
    transactionId: 704
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.status, "committed");
  assert.equal(ack.clientId, 90);
});

test("RNBO adapter resends score transactions when assignments change", () => {
  assert.equal(shouldSendScoreTransaction({ type: "voice.assignment.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "clip.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "mesostructure.block.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "macrostructure.updated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "structure.playhead.updated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "voice.assignment.cleared", detail: {} }), false);
  assert.equal(shouldSendScoreTransaction({ type: "admin.legacyVoiceNotes.imported", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { assignments: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { voices: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { notes: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "voice.notes.replaced", detail: {} }), true);
});

test("RNBO adapter debounces automatic score-change resends but leaves manual resend immediate", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      host: "127.0.0.1",
      port: 9,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      oscQuery: { enabled: false },
      targets: [
        {
          host: "127.0.0.1",
          port: 9,
          address: "/rnbo/inst/2/messages/in/shadowscore"
        }
      ],
      clearRowCount: 0,
      sendDelayMs: 0,
      resendDebounceMs: 25,
      discoveryResendIntervalMs: 0,
      log: false
    }
  });
  const store = {
    events: new EventEmitter(),
    getScore: () => createScore()
  };
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        callback();
      },
      close() {}
    }
  });
  adapter.attach(store);
  try {
    const debounced = new Promise((resolve, reject) => {
      store.events.emit("change", {
        type: "voice.notes.replaced",
        score: createScore()
      });
      setTimeout(() => {
        try {
          const queue = adapter.sendQueueStatus();
          assert.equal(queue.inProgress, false);
          assert.equal(queue.queued, true);
          assert.deepEqual(queue.queuedRequest.reasons, ["voice.notes.replaced"]);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 5);
    });
    await debounced;
    await delay(50);
    assert.equal(adapter.sendQueueStatus().queued, false);

    const manual = adapter.resendCurrentScore("manual");
    await manual;
    assert.equal(adapter.sendQueueStatus().inProgress, false);
  } finally {
    adapter.close();
  }
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readOscAddress(packet) {
  const end = packet.indexOf(0, 0);
  return packet.subarray(0, end).toString("utf8");
}

function compactReplaceCapabilities() {
  return {
    compactScoreReplace: true,
    supportsBeginReplaceClear: true,
    activeRowCountCommit: true
  };
}
