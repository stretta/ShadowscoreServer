import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { compileScoreTransaction, compileTimingContract, createRnboOscAdapter, createScoreTransactionCounter, rnboTargetSignature, scoreTransportInportMessages, sendScoreTransaction, shouldSendScoreTransaction, tempoAuthority, validateScoreActivationAck, validateScoreTransactionAck } from "../src/adapters/rnbo-osc.mjs";

test("hardware transaction ids remain exact and advance across server restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "shadowscore-rnbo-transaction-"));
  const statePath = join(directory, "rnbo-transaction.json");
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      transactionStart: 10000,
      transactionIdMode: "persistent"
    }
  });

  const firstProcess = createScoreTransactionCounter(config, { transactionStatePath: statePath });
  assert.equal(firstProcess.next(), 10001);
  assert.equal(firstProcess.next(), 10002);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { lastTransactionId: 10002 });

  const restartedProcess = createScoreTransactionCounter(config, { transactionStatePath: statePath });
  assert.equal(restartedProcess.current(), 10002);
  assert.equal(restartedProcess.next(), 10003);
  assert.ok(restartedProcess.next() < 2 ** 24);
});

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
  assert.deepEqual(compiled.messages[0].values, [1, 123, 1, 2, 32, 16, 1]);
  assert.deepEqual(compiled.messages[1].values, [20, 123, 0, 10, 60, 0, 4, 100, 0, 10000, 0, 64]);
  assert.deepEqual(compiled.messages[2].values, [20, 123, 1, 20, 64, 8, 8, 90, 0, 7500, 2, 50]);
  assert.deepEqual(compiled.messages[3].values, [90, 123, 2, 0]);
  assert.match(compiled.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(compiled.payloadHash, compileScoreTransaction(score, config, 456).payloadHash);
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

test("staged-capable targets prepare score data without legacy commit activation", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 0
    }
  });
  const target = {
    clientId: 90,
    address: "/rnbo/inst/2/messages/in/shadowscore",
    capabilities: {
      ...compactReplaceCapabilities(),
      stagedScoreActivation: true
    }
  };
  const compiled = compileScoreTransaction(createScore(), config, 123, target);

  assert.equal(compiled.stagedScoreActivation, true);
  assert.equal(compiled.transactionFlags, 1);
  assert.deepEqual(compiled.messages[0].values, [90, 1, 123, 1, 2, 32, 16, 1]);
  assert.equal(validateScoreTransactionAck([90, 92, 123, 2, 32, 1], {
    target,
    compiled,
    transactionId: 123
  }).status, "prepared");
  assert.equal(validateScoreTransactionAck([90, 90, 123, 2, 32, 1], {
    target,
    compiled,
    transactionId: 123
  }).status, "opcode-mismatch");
});

test("fresh continuing clients receive the required client prefix before readback exists", () => {
  const config = mergeConfig(defaultConfig, { rnbo: { stagesPerBeat: 16 } });
  const target = {
    address: "/rnbo/inst/12/messages/in/shadowscore",
    capabilities: {
      ...compactReplaceCapabilities(),
      stagedScoreActivation: true,
      continuingScoreActivation: true
    }
  };

  const compiled = compileScoreTransaction(createScore(), config, 1005, target);

  assert.deepEqual(compiled.messages[0].values.slice(0, 4), [90, 1, 1005, 1]);
  assert.deepEqual(compiled.messages.at(-1).values, [90, 90, 1005, 2, 0]);
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

test("hybrid timing preserves the current long-form MIDI block boundary inside target capacity", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "hybrid"
      }
    }
  });

  const timing = compileTimingContract(createScore(), config, {
    capabilities: { maxStages: 4096 }
  }, {
    blockId: "A",
    selectionStart: 0,
    selectionEnd: 404.25,
    notes: [{ start_time: 0, duration: 1 }]
  });

  assert.equal(timing.stagesPerBeat, 4);
  assert.equal(timing.ticksPerStage, 120);
  assert.equal(timing.patternLength, 1617);
  assert.equal(timing.resolutionMode, "hybrid");
  assert.equal(timing.quantizationError.worstBlockBoundaryBeats, 0);
  assert.ok(timing.patternLength <= timing.maxStages);
});

test("fixed timing refuses an oversized target contract before transmission", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fixed",
        defaultStagesPerBeat: 16
      }
    }
  });

  assert.throws(() => compileTimingContract(createScore(), config, {
    capabilities: { maxStages: 4096 }
  }, {
    blockId: "A",
    selectionStart: 0,
    selectionEnd: 404.25
  }), (error) => {
    assert.equal(error.code, "RNBO_STAGE_CAPACITY_EXCEEDED");
    assert.deepEqual(error.timing, {
      blockId: "A",
      blockBeats: 404.25,
      stagesPerBeat: 16,
      patternLength: 6468,
      maxStages: 4096,
      resolutionMode: "fixed"
    });
    return true;
  });
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

test("score transactions queue ordered UDP bursts before pacing the next batch", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      clearRowCount: 0,
      sendBatchSize: 3,
      sendDelayMs: 0,
      log: false,
      ack: { enabled: false }
    }
  });
  const pending = [];
  const socket = {
    send(packet, port, host, callback) {
      pending.push({ packet, callback });
    }
  };
  const batchSizes = [];
  const sending = sendScoreTransaction(socket, config, createScore(), 125);

  for (const expectedSize of [3, 1, 1, 1]) {
    await new Promise((resolve) => setImmediate(resolve));
    batchSizes.push(pending.length);
    assert.equal(pending.length, expectedSize);
    const callbacks = pending.splice(0).map(({ callback }) => callback);
    callbacks.forEach((callback) => callback());
  }
  await sending;

  assert.deepEqual(batchSizes, [3, 1, 1, 1]);
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
    worstBlockBoundaryBeats: 0,
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
    worstBlockBoundaryBeats: 0,
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
  assert.deepEqual(compiled.messages[0].values, [4404, 1, 321, 1, 1, 32, 16, 1]);
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

test("mesostructural block TTID quantizes playback independently of scale metadata", () => {
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
      scale: { root_note: 0, scale_name: "major" },
      ttid: 2774,
      players: {
        "player-1": { clipId: "melody" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 555);

  assert.equal(compiled.noteCount, 2);
  assert.deepEqual(compiled.messages.slice(1, 3).map((message) => message.values[4]), [59, 64]);
});

test("chromatic block TTID preserves stored pitches despite non-chromatic scale metadata", () => {
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
        { note_id: 1, pitch: 51, start_time: 0, duration: 1, velocity: 96 },
        { note_id: 2, pitch: 58, start_time: 1, duration: 1, velocity: 96 },
        { note_id: 3, pitch: 63, start_time: 2, duration: 1, velocity: 96 }
      ],
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      duration: { beats: 4 },
      playbackType: "one-shot",
      behavior: { followsPitch: false, followsScale: true, transposeMode: "scale-degree" }
    }
  };
  score.mesostructure = {
    A: {
      duration: { beats: 4 },
      scale: { root_note: 0, scale_name: "Ionian", scale_intervals: [0, 2, 4, 5, 7, 9, 11] },
      ttid: 4095,
      players: {
        "player-1": { clipId: "melody" }
      }
    }
  };
  score.macrostructure = { tempo: 120, blocks: ["A"] };

  const compiled = compileScoreTransaction(score, config, 556);

  assert.equal(compiled.noteCount, 3);
  assert.deepEqual(compiled.messages.slice(1, 4).map((message) => message.values[4]), [51, 58, 63]);
});

test("mandatory compact replacement clears an empty score without padded rows", () => {
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
  assert.equal(compiled.transmittedRowCount, 0);
  assert.equal(compiled.messages.length, 2);
  assert.deepEqual(compiled.messages[0].values, [1, 901, 1, 0, 32, 16, 1]);
  assert.deepEqual(compiled.messages[1].values, [90, 901, 0, 0]);
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
  assert.deepEqual(compiled.messages[0].values, [1, 902, 1, 2, 32, 16, 1]);
  assert.deepEqual(compiled.messages.at(-1).values, [90, 902, 2, 0]);
});

test("configured compact-capable RNBO targets inherit default compact capabilities", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 64,
      capabilities: compactReplaceCapabilities()
    }
  });
  const compiled = compileScoreTransaction(createScore(), config, 904, {
    capabilities: {
      maxNoteRows: 819
    }
  });

  assert.equal(compiled.noteCount, 2);
  assert.equal(compiled.transmittedRowCount, 2);
  assert.equal(compiled.replacementMode, "compact");
  assert.equal(compiled.compactScoreReplace, true);
  assert.deepEqual(compiled.messages[0].values, [1, 904, 1, 2, 32, 16, 1]);
  assert.deepEqual(compiled.messages.at(-1).values, [90, 904, 2, 0]);
});

test("target capability flags cannot opt out of the mandatory compact contract", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      stagesPerBeat: 16,
      clearRowCount: 64,
      capabilities: compactReplaceCapabilities()
    }
  });
  const compiled = compileScoreTransaction(createScore(), config, 905, {
    capabilities: {
      maxNoteRows: 819,
      compactScoreReplace: false
    }
  });

  assert.equal(compiled.transmittedRowCount, 2);
  assert.equal(compiled.replacementMode, "compact");
  assert.equal(compiled.compactScoreReplace, true);
  assert.deepEqual(compiled.messages[0].values, [1, 905, 1, 2, 32, 16, 1]);
  assert.deepEqual(compiled.messages.at(-1).values, [90, 905, 2, 0]);
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
  assert.deepEqual(compiled.messages[0].values, [1, 903, 1, 819, 32, 16, 1]);
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
    transport: {
      tempoAuthority: "link"
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
  assert.deepEqual(result.messages[0].values, [2202, 1, 700, 1, 1, 32, 16, 1]);
  assert.equal(result.replacementMode, "compact");
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
  assert.deepEqual(result.messages[0].values, [90, 1, 701, 1, 1, 32, 16, 1]);
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
    [92, 702, 1, 32, 1]
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
  assert.equal(result.ack.status, "prepared");
  assert.equal(result.ack.attempt, 1);
  assert.deepEqual(result.deliveryProfile, {
    attempt: 1,
    batchSize: 2,
    delayMs: 0,
    mode: "conservative-retry"
  });
  assert.equal(packets.length, 12);
});

test("score transaction retries with progressively safer delivery profiles", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      clearRowCount: 0,
      sendBatchSize: 4,
      sendDelayMs: 0,
      log: false,
      targets: [{
        address: "/rnbo/inst/2/messages/in/shadowscore",
        capabilities: compactReplaceCapabilities()
      }],
      oscQuery: { enabled: true, url: "http://127.0.0.1:5678/" },
      ack: { enabled: true, retries: 2, retryDelayMs: 0, settleMs: 0 }
    }
  });
  const lifecycle = [];
  const ackValues = [
    [91, 706, 2, 0, 0],
    [91, 706, 2, 1, 0],
    [92, 706, 2, 32, 1]
  ];
  const socket = { send(packet, port, host, callback) { callback(); } };

  const result = await sendScoreTransaction(socket, config, createScore(), 706, {
    onLifecycleEvent(event) { lifecycle.push(event); },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { VALUE: ackValues.shift() }; }
    })
  });

  assert.equal(result.ack.ok, true);
  assert.deepEqual(result.deliveryProfile, {
    attempt: 2,
    batchSize: 1,
    delayMs: 0,
    mode: "conservative-retry"
  });
  assert.deepEqual(lifecycle.at(-1).deliveryProfile, result.deliveryProfile);
});

test("resumable staged targets retransmit only the missing dense suffix", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      clearRowCount: 0,
      sendBatchSize: 4,
      sendDelayMs: 0,
      log: false,
      targets: [{
        address: "/rnbo/inst/2/messages/in/shadowscore",
        capabilities: {
          ...compactReplaceCapabilities(),
          stagedScoreActivation: true,
          resumableScoreReplace: true
        }
      }],
      oscQuery: { enabled: true, url: "http://127.0.0.1:5678/" },
      ack: { enabled: true, retries: 2, retryDelayMs: 0, settleMs: 0 }
    }
  });
  const packets = [];
  const lifecycle = [];
  const ackValues = [
    [91, 707, 2, 1, 0],
    [92, 707, 2, 32, 1]
  ];
  const socket = {
    send(packet, port, host, callback) {
      packets.push({ packet, port, host });
      callback();
    }
  };

  const result = await sendScoreTransaction(socket, config, createScore(), 707, {
    onLifecycleEvent(event) { lifecycle.push(event); },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { VALUE: ackValues.shift() }; }
    })
  });

  assert.equal(result.ack.status, "prepared");
  assert.equal(result.ack.attempt, 1);
  assert.equal(result.resumableScoreReplace, true);
  assert.equal(result.resumedRowCount, 1);
  assert.equal(packets.length, 10);
  assert.deepEqual(lifecycle.find((event) => event.type === "prepare_retry")?.nextDelivery, {
    strategy: "resume-dense-prefix",
    resumeFromRow: 1,
    rowCount: 1
  });
  assert.deepEqual(lifecycle.at(-1).delivery, {
    strategy: "resume-dense-prefix",
    resumeFromRow: 1,
    rowCount: 1
  });
});

test("progress-making suffix delivery receives a bounded additional retry budget", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      clearRowCount: 0,
      sendBatchSize: 4,
      sendDelayMs: 5,
      log: false,
      targets: [{
        address: "/rnbo/inst/2/messages/in/shadowscore",
        capabilities: {
          ...compactReplaceCapabilities(),
          stagedScoreActivation: true,
          resumableScoreReplace: true
        }
      }],
      oscQuery: { enabled: true, url: "http://127.0.0.1:5678/" },
      ack: { enabled: true, retries: 2, resumeRetries: 2, retryDelayMs: 0, settleMs: 0 }
    }
  });
  const ackValues = [
    [91, 708, 2, 1, 0],
    [91, 708, 5, 1, 0],
    [91, 708, 2, 1, 0],
    [92, 708, 2, 32, 1]
  ];
  const lifecycle = [];

  const result = await sendScoreTransaction({ send(packet, port, host, callback) { callback(); } }, config, createScore(), 708, {
    onLifecycleEvent(event) { lifecycle.push(event); },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { VALUE: ackValues.shift() }; }
    })
  });

  assert.equal(result.ack.status, "prepared");
  assert.equal(result.ack.attempt, 3);
  assert.equal(lifecycle.filter((event) => event.type === "prepare_retry")[1].acknowledgement.rejectReasonLabel, "row-order");
  assert.equal(lifecycle.filter((event) => event.type === "prepare_retry")[1].nextDelivery.resumeFromRow, 1);
  assert.deepEqual(result.deliveryProfile, {
    attempt: 3,
    batchSize: 1,
    delayMs: 20,
    mode: "conservative-retry"
  });
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
        return { VALUE: [92, 700, 1, 32, 1] };
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
  assert.equal(rejected.committedNoteCount, undefined);
  assert.equal(rejected.rejectReason, 0);
  assert.equal(rejected.rejectReasonLabel, "unknown");
  assert.equal(rejected.receivedNoteCount, 0);
});

test("decodes client-prefixed note-count rejection diagnostics", () => {
  const rejected = validateScoreTransactionAck([90, 91, 1006, 2, 65, 0], {
    target: { clientId: 90 },
    compiled: { noteCount: 277, transmittedRowCount: 277, stagedScoreActivation: true },
    transactionId: 1006
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectReason, 2);
  assert.equal(rejected.rejectReasonLabel, "note-count");
  assert.equal(rejected.receivedNoteCount, 65);
  assert.equal(rejected.noteCount, 277);
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

test("validates Finch staged activation ACKs independently from READY", () => {
  const active = validateScoreActivationAck([90, 93, 1104, 32, 0, 1], {
    transactionId: 1104,
    expectedClientId: 90,
    initialStage: 0
  });
  const stillPrepared = validateScoreActivationAck([90, 92, 1104, 32, 1], {
    transactionId: 1104,
    expectedClientId: 90,
    initialStage: 0
  });
  const wrongStage = validateScoreActivationAck([90, 93, 1104, 32, 1, 1], {
    transactionId: 1104,
    expectedClientId: 90,
    initialStage: 0
  });

  assert.equal(active.ok, true);
  assert.equal(active.status, "active");
  assert.equal(active.activeRowCount, 32);
  assert.equal(stillPrepared.ok, false);
  assert.equal(stillPrepared.status, "awaiting activation");
  assert.equal(wrongStage.ok, false);
  assert.equal(wrongStage.status, "stage mismatch");
});

test("RNBO adapter resends score transactions when assignments change", () => {
  assert.equal(shouldSendScoreTransaction({ type: "voice.assignment.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "clip.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "mesostructure.block.replaced", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "mesostructure.block.duplicated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "mesostructure.ttid.updated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "macrostructure.updated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "structure.playhead.updated", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "voice.assignment.cleared", detail: {} }), false);
  assert.equal(shouldSendScoreTransaction({ type: "admin.legacyVoiceNotes.imported", detail: {} }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { assignments: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { voices: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "admin.reset", detail: { notes: true } }), true);
  assert.equal(shouldSendScoreTransaction({ type: "voice.notes.replaced", detail: {} }), true);
});

test("RNBO adapter promotes only a prepared Finch transaction after ACTIVE readback", async () => {
  let ackValue = [90, 92, 1104, 2, 32, 1];
  let packetCount = 0;
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1103,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: {
          ...compactReplaceCapabilities(),
          stagedScoreActivation: true
        }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 },
      activation: { timeoutMs: 20, beatMarginMs: 0, pollIntervalMs: 1, requestTimeoutMs: 20 }
    }
  });
  const store = {
    events: new EventEmitter(),
    getScore: () => createScore()
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { VALUE: ackValue };
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        packetCount += 1;
        callback();
      },
      close() {}
    },
    fetchImpl
  });
  adapter.attach(store);
  try {
    await adapter.resendCurrentScore("manual", { fetchImpl });
    assert.equal(adapter.sendStatus()[0].activeTransaction, null);
    assert.equal(adapter.sendStatus()[0].preparedTransaction, 1104, JSON.stringify(adapter.sendStatus()[0]));

    const requests = adapter.schedulePreparedActivations({ initialStage: 0 });
    ackValue = [90, 93, 1104, 2, 0, 1];
    const activations = await adapter.confirmPreparedActivations(requests, { tempo: 120 });

    assert.equal(activations[0].acknowledgement.status, "active");
    assert.equal(adapter.sendStatus()[0].activeTransaction, 1104);
    assert.equal(adapter.sendStatus()[0].preparedTransaction, null);
    assert.equal(adapter.sendStatus()[0].activationAck.status, "active");
    assert.deepEqual(adapter.lifecycleEvents().slice(-2).map((event) => event.type), [
      "activation_scheduled",
      "activation_completed"
    ]);

    const packetsAfterActivation = packetCount;
    await adapter.resendCurrentScore("structure.playhead.updated", { immediate: true, fetchImpl });
    assert.equal(packetCount, packetsAfterActivation);
    assert.equal(adapter.sendStatus()[0].activeTransaction, 1104);
    assert.equal(adapter.sendStatus()[0].preparedTransaction, null);
    assert.equal(adapter.lifecycleEvents().at(-1).type, "prepare_reused");
  } finally {
    adapter.close();
  }
});

test("RNBO adapter applies a prepared update in continue mode without requiring stage zero", async () => {
  let activationRequested = false;
  const addresses = [];
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1200,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        voiceId: "player-1",
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true, continuingScoreActivation: true }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 },
      activation: { timeoutMs: 20, beatMarginMs: 0, pollIntervalMs: 1, requestTimeoutMs: 20 }
    }
  });
  const score = scoreWithBlock(9);
  const store = { events: new EventEmitter(), getScore: () => score };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { VALUE: activationRequested ? [90, 93, 1201, 2, 7, 1] : [90, 92, 1201, 2, 32, 1] };
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        const address = readOscAddress(packet);
        addresses.push(address);
        if (address.endsWith("/ActivatePrepared")) activationRequested = true;
        callback();
      },
      close() {}
    },
    fetchImpl
  });
  adapter.attach(store);
  try {
    const result = await adapter.applyBlockUpdate("A", {
      activationMode: "continue",
      expectedScoreRevision: 9,
      fetchImpl
    });
    assert.equal(addresses.some((address) => address.endsWith("/ActivatePrepared")), true);
    assert.equal(result.action, "active");
    assert.equal(result.targets.finch.activeTransaction, 1201);
    assert.equal(result.activations[0].acknowledgement.activatedStage, 7);
  } finally {
    adapter.close();
  }
});

test("RNBO adapter restores the upcoming block after applying the playing block", async () => {
  let phase = "prepare-playing";
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1200,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        voiceId: "player-1",
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true, continuingScoreActivation: true }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 },
      activation: { timeoutMs: 20, beatMarginMs: 0, pollIntervalMs: 1, requestTimeoutMs: 20 }
    }
  });
  const base = scoreWithBlock(9);
  const score = {
    ...base,
    clips: {
      ...base.clips,
      next: {
        ...base.clips.main,
        notes: base.clips.main.notes.map((note) => ({ ...note, pitch: note.pitch + 7 }))
      }
    },
    mesostructure: {
      A: base.mesostructure.A,
      B: { duration: { beats: 2 }, players: { "player-1": { clipId: "next" } } }
    },
    macrostructure: { tempo: 120, blocks: ["A", "B"] }
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      if (phase === "activate-playing") return { VALUE: [90, 93, 1201, 2, 7, 1] };
      if (phase === "restore-upcoming") return { VALUE: [90, 92, 1202, 2, 32, 1] };
      return { VALUE: [90, 92, 1201, 2, 32, 1] };
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        const address = readOscAddress(packet);
        if (address.endsWith("/ActivatePrepared")) phase = "activate-playing";
        else if (phase === "activate-playing" && address.endsWith("/shadowscore")) phase = "restore-upcoming";
        callback();
      },
      close() {}
    },
    fetchImpl
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => score });
  try {
    const result = await adapter.applyBlockUpdate("A", {
      activationMode: "continue",
      expectedScoreRevision: 9,
      restoreBlockId: "B",
      fetchImpl
    });

    assert.deepEqual(result.restoredPreparation, { ok: true, blockId: "B" });
    assert.equal(adapter.sendStatus()[0].blockId, "B");
    assert.equal(adapter.sendStatus()[0].activeTransaction, 1201);
    assert.equal(adapter.sendStatus()[0].preparedTransaction, 1202);
  } finally {
    adapter.close();
  }
});

test("RNBO adapter reactivates a populated block after the arrangement activates an empty block", async () => {
  let expectedTransaction = 1501;
  let expectedNoteCount = 2;
  let activationRequested = false;
  const activatedTransactions = [];
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1500,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        voiceId: "player-1",
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true, continuingScoreActivation: true }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 },
      activation: { timeoutMs: 20, beatMarginMs: 0, pollIntervalMs: 1, requestTimeoutMs: 20 }
    }
  });
  const base = scoreWithBlock(12);
  const score = {
    ...base,
    clips: {
      ...base.clips,
      empty: { ...base.clips.main, notes: [] }
    },
    mesostructure: {
      A: base.mesostructure.A,
      B: { duration: { beats: 2 }, players: { "player-1": { clipId: "empty" } } }
    },
    macrostructure: { tempo: 120, blocks: ["A", "B"] }
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        VALUE: activationRequested
          ? [90, 93, expectedTransaction, expectedNoteCount, 7, 1]
          : [90, 92, expectedTransaction, expectedNoteCount, 32, 1]
      };
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        if (readOscAddress(packet).endsWith("/ActivatePrepared")) {
          activationRequested = true;
          activatedTransactions.push(expectedTransaction);
        }
        callback();
      },
      close() {}
    },
    fetchImpl
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => score });
  try {
    const apply = async (blockId, transactionId, noteCount) => {
      expectedTransaction = transactionId;
      expectedNoteCount = noteCount;
      activationRequested = false;
      return adapter.applyBlockUpdate(blockId, {
        activationMode: "continue",
        expectedScoreRevision: 12,
        fetchImpl
      });
    };

    const firstA = await apply("A", 1501, 2);
    const emptyB = await apply("B", 1502, 0);
    expectedTransaction = 1503;
    expectedNoteCount = 2;
    activationRequested = false;
    await adapter.resendCurrentScore("lookahead:A", { immediate: true, stagedOnly: true, fetchImpl });
    const secondA = await adapter.applyBlockUpdate("A", {
      activationMode: "continue",
      expectedScoreRevision: 12,
      fetchImpl
    });

    assert.equal(firstA.action, "active");
    assert.equal(emptyB.action, "active");
    assert.equal(secondA.action, "active");
    assert.deepEqual(activatedTransactions, [1501, 1502, 1503]);
    assert.equal(secondA.targets.finch.activeTransaction, 1503);
    assert.equal((await adapter.playbackUpdates("B")).targets.finch.state, "saved-not-active");
  } finally {
    adapter.close();
  }
});

test("RNBO adapter serializes overlapping block activation operations", async () => {
  let activationRequested = false;
  let releaseFirst;
  let firstAuthorized;
  const firstAuthorizedPromise = new Promise((resolve) => { firstAuthorized = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const addresses = [];
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1400,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        voiceId: "player-1",
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true, continuingScoreActivation: true }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 },
      activation: { timeoutMs: 20, beatMarginMs: 0, pollIntervalMs: 1, requestTimeoutMs: 20 }
    }
  });
  const score = scoreWithBlock(11);
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { VALUE: activationRequested ? [90, 93, 1401, 2, 7, 1] : [90, 92, 1401, 2, 32, 1] };
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        const address = readOscAddress(packet);
        addresses.push(address);
        if (address.endsWith("/ActivatePrepared")) activationRequested = true;
        callback();
      },
      close() {}
    },
    fetchImpl
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => score });
  try {
    const first = adapter.applyBlockUpdate("A", {
      expectedScoreRevision: 11,
      fetchImpl,
      authorizeActivation: async () => {
        firstAuthorized();
        await firstGate;
      }
    });
    await firstAuthorizedPromise;

    const second = adapter.applyBlockUpdate("A", { expectedScoreRevision: 11, fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.metrics().transmissionCount, 1);
    assert.equal(addresses.filter((address) => address.endsWith("/ActivatePrepared")).length, 0);

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.action, "active");
    assert.equal(secondResult.action, "already-active");
    assert.equal(addresses.filter((address) => address.endsWith("/ActivatePrepared")).length, 1);
  } finally {
    adapter.close();
  }
});

test("RNBO adapter refuses live application when a target lacks continuing activation", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      transactionStart: 1300,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      targets: [{
        id: "finch",
        host: "finch.local",
        port: 1234,
        instanceId: "20",
        clientId: 90,
        voiceId: "player-1",
        address: "/rnbo/inst/20/messages/in/shadowscore",
        capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true }
      }],
      oscQuery: { enabled: true, url: "http://wren.local:5678/" },
      ack: { enabled: true, retries: 0, settleMs: 0 }
    }
  });
  const score = scoreWithBlock(10);
  const adapter = createRnboOscAdapter(config, {
    socket: { send(packet, port, host, callback) { callback(); }, close() {} },
    fetchImpl: async () => ({ ok: true, async json() { return { VALUE: [90, 92, 1301, 2, 32, 1] }; } })
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => score });
  try {
    await assert.rejects(
      adapter.applyBlockUpdate("A", { expectedScoreRevision: 10 }),
      (error) => error.code === "CONTINUING_ACTIVATION_UNSUPPORTED"
    );
  } finally {
    adapter.close();
  }
});

test("RNBO adapter removes stale send status when a target instance is replaced", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      oscQuery: { enabled: false },
      targets: [{
        host: "127.0.0.1",
        port: 1234,
        address: "/rnbo/inst/18/messages/in/shadowscore"
      }]
    }
  });
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        callback();
      },
      close() {}
    }
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => createScore() });
  try {
    await adapter.resendCurrentScore("manual");
    assert.equal(adapter.sendStatus()[0].targetId, "/rnbo/inst/18/messages/in/shadowscore");

    config.rnbo.targets = [{
      host: "127.0.0.1",
      port: 1234,
      address: "/rnbo/inst/22/messages/in/shadowscore"
    }];
    await adapter.resendCurrentScore("manual");

    assert.deepEqual(adapter.sendStatus().map((status) => status.targetId), [
      "/rnbo/inst/22/messages/in/shadowscore"
    ]);
  } finally {
    adapter.close();
  }
});

test("RNBO look-ahead preparation sends to every mandatory staged target", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      oscQuery: { enabled: false },
      targets: [
        {
          host: "127.0.0.1",
          port: 1234,
          address: "/rnbo/inst/20/messages/in/shadowscore",
          capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true }
        },
        {
          host: "127.0.0.1",
          port: 1234,
          address: "/rnbo/inst/22/messages/in/shadowscore",
          capabilities: compactReplaceCapabilities()
        }
      ]
    }
  });
  const packets = [];
  const score = {
    ...createScore(),
    clips: {
      "b-player-1": {
        notes: [],
        context: { clip: {}, scale: {}, grid: {}, seed: 0 },
        duration: { beats: 4 },
        playbackType: "looped"
      }
    },
    mesostructure: {
      A: { duration: { beats: 4 }, players: {} },
      B: { duration: { beats: 4 }, players: { "player-1": { clipId: "b-player-1" } } }
    },
    macrostructure: { tempo: 120, blocks: ["A", "B"] },
    structureState: { activeBlockId: "A", macroIndex: 0 }
  };
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) {
        packets.push(readOscAddress(packet));
        callback();
      },
      close() {}
    }
  });
  adapter.attach({ events: new EventEmitter(), getScore: () => score });
  try {
    await adapter.prepareBlock("B");
    assert.ok(packets.length > 0);
    assert.equal(packets.some((address) => address.includes("/rnbo/inst/20/")), true);
    assert.equal(packets.some((address) => address.includes("/rnbo/inst/22/")), true);
    assert.equal(adapter.sendStatus().length, 2);
    assert.equal(adapter.sendStatus().every((status) => status.stagedScoreActivation), true);
    assert.equal(adapter.sendStatus().every((status) => status.blockId === "B"), true);
  } finally {
    adapter.close();
  }
});

test("RNBO preparation sends only the voice made dirty by a clip edit", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      enabled: true,
      clearRowCount: 0,
      sendDelayMs: 0,
      discoveryResendIntervalMs: 0,
      log: false,
      oscQuery: { enabled: false },
      ack: { enabled: false },
      targets: [
        {
          id: "finch",
          voiceId: "player-1",
          host: "127.0.0.1",
          port: 1234,
          address: "/rnbo/inst/20/messages/in/shadowscore",
          capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true }
        },
        {
          id: "wren-player",
          voiceId: "player-2",
          host: "127.0.0.1",
          port: 1234,
          address: "/rnbo/inst/22/messages/in/shadowscore",
          capabilities: { ...compactReplaceCapabilities(), stagedScoreActivation: true }
        }
      ]
    }
  });
  let score = {
    ...createScore(),
    scoreRevision: 1,
    clips: {
      one: { notes: createScore().voices["player-1"].notes, context: createScore().context, duration: { beats: 2 }, playbackType: "looped" },
      two: { notes: createScore().voices["player-2"].notes, context: createScore().context, duration: { beats: 2 }, playbackType: "looped" }
    },
    mesostructure: {
      A: { duration: { beats: 2 }, players: { "player-1": { clipId: "one" }, "player-2": { clipId: "two" } } }
    },
    macrostructure: { tempo: 120, blocks: ["A"] },
    structureState: { activeBlockId: "A", macroIndex: 0 }
  };
  const events = new EventEmitter();
  const addresses = [];
  const adapter = createRnboOscAdapter(config, {
    socket: {
      send(packet, port, host, callback) { addresses.push(readOscAddress(packet)); callback(); },
      close() {}
    }
  });
  adapter.attach({ events, getScore: () => score });
  try {
    await adapter.prepareBlock("A");
    assert.equal(addresses.some((address) => address.includes("/inst/20/")), true);
    assert.equal(addresses.some((address) => address.includes("/inst/22/")), true);

    addresses.length = 0;
    score = structuredClone(score);
    score.scoreRevision = 2;
    score.clips.one.notes[0].pitch = 61;
    events.emit("change", { type: "clip.replaced", detail: { clipId: "one" }, score });
    await adapter.prepareBlock("A");

    assert.equal(addresses.some((address) => address.includes("/inst/20/")), true);
    assert.equal(addresses.some((address) => address.includes("/inst/22/")), false);
  } finally {
    adapter.close();
  }
});

test("RNBO adapter records automatic score changes without sending and leaves manual resend immediate", async () => {
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
    store.events.emit("change", {
      type: "voice.notes.replaced",
      detail: { voiceId: "player-1" },
      score: createScore()
    });
    await delay(5);
    assert.equal(adapter.sendQueueStatus().inProgress, false);
    assert.equal(adapter.sendQueueStatus().queued, false);
    assert.equal(adapter.mutationImpacts().at(-1).eventType, "voice.notes.replaced");

    const manual = adapter.resendCurrentScore("manual");
    await manual;
    assert.equal(adapter.sendQueueStatus().inProgress, false);
    assert.deepEqual(adapter.lifecycleEvents().slice(-2).map((event) => event.type), ["prepare_started", "prepare_completed"]);
    assert.match(adapter.sendStatus()[0].payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(adapter.sendStatus()[0].noteCount, 2);
    assert.ok(adapter.sendStatus()[0].preparationDurationMs >= 0);
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

function scoreWithBlock(scoreRevision) {
  const score = createScore();
  return {
    ...score,
    scoreRevision,
    clips: {
      main: {
        notes: score.voices["player-1"].notes,
        context: score.context,
        duration: { beats: 2 },
        playbackType: "looped"
      }
    },
    mesostructure: { A: { duration: { beats: 2 }, players: { "player-1": { clipId: "main" } } } },
    macrostructure: { tempo: 120, blocks: ["A"] },
    structureState: { activeBlockId: "A", macroIndex: 0 }
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
