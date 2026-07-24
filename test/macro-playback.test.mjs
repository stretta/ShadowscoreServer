import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createMacroPlayback, deriveMacroPosition, macroBlockDurationMs } from "../src/playback/macro-playback.mjs";
import { createOscSnapshotAutoRecall } from "../src/osc/snapshot-auto-recall.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";
import { createJackTransportState } from "../src/transport/jack-transport-state.mjs";

test("macro playback advances according to the active block duration and tempo", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const timers = createFakeTimers();
  const playback = createMacroPlayback(store, defaultConfig, { timers });

  assert.equal(macroBlockDurationMs(store.getScore(), defaultConfig), 8000);

  const started = playback.start();
  assert.equal(started.running, true);
  assert.equal(started.currentBlockDurationMs, 8000);
  assert.equal(timers.pending[0].delayMs, 8000);

  timers.fire(0);
  assert.equal(store.getScore().structureState.activeBlockId, "B");
  assert.equal(playback.snapshot().running, true);
  assert.equal(timers.pending.at(-1).delayMs, 8000);

  const stopped = playback.stop();
  assert.equal(stopped.running, false);
  assert.equal(timers.pending.length, 0);
  playback.close();
});

test("timer macro playback triggers one automatic snapshot recall at block entry", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const timers = createFakeTimers();
  const playback = createMacroPlayback(store, defaultConfig, { timers });
  const calls = [];
  const automatic = createOscSnapshotAutoRecall(store, { recall: async (request) => { calls.push(request); return { ok: true }; } });

  playback.start();
  timers.fire(0);
  await automatic.flush();

  assert.deepEqual(calls.map(({ blockId, macroIndex }) => ({ blockId, macroIndex })), [{ blockId: "B", macroIndex: 1 }]);
  automatic.close();
  playback.close();
});

test("macro playback uses beat durations and the active block written tempo", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { tempo: 60, duration: { beats: 3 }, players: {} });
  store.updateMacrostructure({ blocks: ["A"] });

  assert.equal(macroBlockDurationMs(store.getScore(), defaultConfig), 3000);
});

test("timer playback re-anchors musical progress when live tempo changes", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { ...store.getScore().mesostructure.A, tempo: 120, duration: { beats: 4 } });
  store.updateMacrostructure({ blocks: ["A"] });
  const timers = createFakeTimers();
  let observedAt = 0;
  let liveTempo = 120;
  const playback = createMacroPlayback(store, defaultConfig, {
    timers,
    now: () => observedAt,
    getTempo: () => liveTempo
  });

  playback.start();
  assert.equal(timers.pending[0].delayMs, 2000);

  observedAt = 500;
  liveTempo = 60;
  playback.tempoChanged();

  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delayMs, 3000);
  assert.equal(playback.snapshot().beatsRemaining, 3);
  playback.close();
});

test("editing written block tempo does not restart running timer playback", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const timers = createFakeTimers();
  const playback = createMacroPlayback(store, defaultConfig, { timers });

  playback.start();
  const scheduled = timers.pending[0];
  store.replaceMesoBlock("A", { ...store.getScore().mesostructure.A, tempo: 88 });

  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0], scheduled);
  playback.close();
});

test("timer playback adopts an edited arrangement at the next block boundary", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("C", { tempo: 120, duration: { beats: 2 }, players: {} });
  store.updateMacrostructure({ blocks: ["A", "B", "C"] });
  const timers = createFakeTimers();
  const playback = createMacroPlayback(store, defaultConfig, { timers });

  playback.start();
  const originalTimer = timers.pending[0];
  store.updateMacrostructure({ blocks: ["B", "A", "C"] });

  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0], originalTimer);
  assert.deepEqual(playback.snapshot().arrangementAdoption, {
    pending: true,
    scoreRevision: store.getScore().scoreRevision,
    blocks: ["B", "A", "C"]
  });
  assert.equal(playback.snapshot().traversalBlockId, "A");

  timers.fire(0);

  assert.equal(store.getScore().structureState.activeBlockId, "C");
  assert.equal(playback.snapshot().traversalBlockId, "C");
  assert.equal(playback.snapshot().arrangementAdoption.pending, false);
  assert.equal(timers.pending.length, 1);
  playback.close();
});

test("JACK playback holds its latched occurrence until an edited arrangement boundary", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("C", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ blocks: ["A", "B", "C"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const playback = createMacroPlayback(store, defaultConfig, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  store.updateMacrostructure({ blocks: ["B", "A", "C"] });

  jackTransport.update(jackSnapshot({ absoluteBeat: 102 }));
  let snapshot = playback.snapshot();
  assert.equal(snapshot.activeBlockId, "A");
  assert.equal(snapshot.traversalBlockId, "A");
  assert.equal(snapshot.activeBlockEndBeat, 104);
  assert.equal(snapshot.arrangementAdoption.pending, true);

  jackTransport.update(jackSnapshot({ absoluteBeat: 104 }));
  snapshot = playback.snapshot();
  assert.equal(snapshot.activeBlockId, "C");
  assert.equal(snapshot.traversalBlockId, "C");
  assert.equal(snapshot.activeBlockStartBeat, 104);
  assert.equal(snapshot.activeBlockEndBeat, 108);
  assert.equal(snapshot.arrangementAdoption.pending, false);
  playback.close();
});

test("JACK look-ahead prepares the pending arrangement's next block", async () => {
  const config = {
    ...defaultConfig,
    rnbo: { ...defaultConfig.rnbo, lookAheadBeats: 2 }
  };
  const store = createScoreStore(createInitialScore(config));
  store.replaceMesoBlock("A", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("C", { tempo: 120, duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ blocks: ["A", "B", "C"] });
  const jackTransport = createJackTransportState(config, { now: () => 1000 });
  const prepared = [];
  const playback = createMacroPlayback(store, config, {
    jackTransport,
    beforeAdvance: async (detail) => {
      prepared.push(detail);
      return { prepared: detail.nextBlockId };
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  store.updateMacrostructure({ blocks: ["B", "A", "C"] });
  jackTransport.update(jackSnapshot({ absoluteBeat: 102.1 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].activeBlockId, "A");
  assert.equal(prepared[0].nextBlockId, "C");
  assert.equal(prepared[0].nextMacroIndex, 2);
  playback.close();
});

test("JACK macro playback advances at anchored beat boundaries", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const playback = createMacroPlayback(store, defaultConfig, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  const started = playback.start({ mode: "jack" });
  assert.equal(started.running, true);
  assert.equal(started.mode, "jack");
  assert.deepEqual(started.witness, {
    source: "jack",
    usable: true,
    absoluteBeat: 100,
    tempo: 120,
    fresh: true,
    reason: ""
  });
  assert.equal(started.activeBlockStartBeat, 100);
  assert.equal(started.activeBlockEndBeat, 104);
  assert.equal(started.activeBlockDurationBeats, 4);
  assert.equal(store.getScore().structureState.activeBlockId, "A");

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.99 }));
  assert.equal(store.getScore().structureState.activeBlockId, "A");
  assert.equal(playback.snapshot().beatsRemaining, 0.010000000000005116);

  jackTransport.update(jackSnapshot({ absoluteBeat: 104 }));
  assert.equal(store.getScore().structureState.activeBlockId, "B");
  assert.equal(playback.snapshot().activeBlockStartBeat, 104);
  assert.equal(playback.snapshot().activeBlockEndBeat, 108);
  assert.equal(playback.snapshot().beatsRemaining, 4);

  playback.close();
});

test("JACK macro playback does not reverse when Link rewrites BBT after a tempo change", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const playback = createMacroPlayback(store, defaultConfig, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 104.25, beatsPerMinute: 60 }));

  assert.equal(store.getScore().structureState.activeBlockId, "B");
  assert.equal(playback.snapshot().compositionBeat, 4.25);

  jackTransport.update(jackSnapshot({ absoluteBeat: 101, beatsPerMinute: 60 }));
  const preserved = playback.snapshot();
  assert.equal(store.getScore().structureState.activeBlockId, "B");
  assert.equal(preserved.compositionBeat, 4.25);
  assert.equal(preserved.beatIntoBlock, 0.25);

  jackTransport.update(jackSnapshot({ absoluteBeat: 102, beatsPerMinute: 60 }));
  assert.equal(playback.snapshot().compositionBeat, 5.25);
  assert.equal(store.getScore().structureState.activeBlockId, "B");

  playback.close();
});

test("JACK-derived block entry triggers one automatic snapshot recall", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const playback = createMacroPlayback(store, defaultConfig, { jackTransport });
  const calls = [];
  const automatic = createOscSnapshotAutoRecall(store, { recall: async (request) => { calls.push(request); return { ok: true }; } });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 104 }));
  playback.snapshot();
  await automatic.flush();

  assert.deepEqual(calls.map(({ blockId, macroIndex }) => ({ blockId, macroIndex })), [{ blockId: "B", macroIndex: 1 }]);
  automatic.close();
  playback.close();
});

test("JACK macro playback runs phase alignment after block advance", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const calls = [];
  const playback = createMacroPlayback(store, defaultConfig, {
    jackTransport,
    afterAdvance: async (detail) => {
      calls.push(detail);
      return {
        action: "SetStage",
        value: 0,
        writes: [{ targetId: "rnbo-inst-2:shadowscore" }]
      };
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 104 }));

  assert.equal(playback.snapshot().phaseAlignment.pending, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    {
      mode: "jack",
      activeBlockId: "B",
      macroIndex: 1,
      anchorBeat: 104,
      boundaryBeat: 104,
      absoluteBeat: 104,
      compositionBeat: 4,
      beatIntoBlock: 0,
      witnessSource: "jack"
    }
  ]);
  const lastAlignment = playback.snapshot().phaseAlignment.last;
  assert.match(lastAlignment.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(lastAlignment, {
    ok: true,
    at: lastAlignment.at,
    action: "SetStage",
    value: 0,
    writeCount: 1
  });
  assert.equal(playback.snapshot().phaseAlignment.pending, false);

  playback.close();
});

test("JACK macro playback prepares the next block once inside the look-ahead window", async () => {
  const config = {
    ...defaultConfig,
    rnbo: { ...defaultConfig.rnbo, lookAheadBeats: 1 }
  };
  const store = createScoreStore(createInitialScore(config));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(config, { now: () => 1000 });
  const calls = [];
  const playback = createMacroPlayback(store, config, {
    jackTransport,
    beforeAdvance: async (detail) => {
      calls.push(detail);
      return { prepared: detail.nextBlockId };
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 102.9 }));
  assert.equal(calls.length, 0);

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.1 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  playback.snapshot();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].activeBlockId, "A");
  assert.equal(calls[0].nextBlockId, "B");
  assert.equal(calls[0].nextMacroIndex, 1);
  assert.equal(calls[0].boundaryBeat, 104);
  assert.equal(playback.snapshot().lookAhead.last.ok, true);
  assert.equal(playback.snapshot().lookAhead.last.nextBlockId, "B");

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.5 }));
  playback.snapshot();
  assert.equal(calls.length, 1);
  playback.close();
});

test("JACK macro playback arms a prepared block once during the preceding beat", async () => {
  const config = {
    ...defaultConfig,
    rnbo: {
      ...defaultConfig.rnbo,
      lookAheadBeats: 2,
      activation: { ...defaultConfig.rnbo.activation, armLeadBeats: 0.75 }
    }
  };
  const store = createScoreStore(createInitialScore(config));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(config, { now: () => 1000 });
  const prepared = [];
  const armed = [];
  const playback = createMacroPlayback(store, config, {
    jackTransport,
    beforeAdvance: async (detail) => {
      prepared.push(detail);
      return { prepared: detail.nextBlockId };
    },
    armAdvance: async (detail) => {
      armed.push(detail);
      return { armed: detail.nextBlockId };
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 102.1 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared.length, 1);

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.1 }));
  playback.snapshot();
  assert.equal(armed.length, 0);

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.3 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(armed.length, 1);
  assert.equal(armed[0].nextBlockId, "B");
  assert.equal(armed[0].boundaryBeat, 104);
  assert.deepEqual(armed[0].preparation, { prepared: "B" });
  assert.equal(playback.snapshot().activationArm.last.ok, true);

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.8 }));
  playback.snapshot();
  assert.equal(armed.length, 1);
  playback.close();
});

test("JACK macro playback retries a failed transition arm before the boundary", async () => {
  const config = {
    ...defaultConfig,
    rnbo: {
      ...defaultConfig.rnbo,
      lookAheadBeats: 2,
      activation: { ...defaultConfig.rnbo.activation, armLeadBeats: 0.75 }
    }
  };
  const store = createScoreStore(createInitialScore(config));
  store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(config, { now: () => 1000 });
  let armCount = 0;
  const playback = createMacroPlayback(store, config, {
    jackTransport,
    beforeAdvance: async ({ nextBlockId }) => ({ prepared: nextBlockId }),
    armAdvance: async () => {
      armCount += 1;
      if (armCount === 1) throw new Error("prepared transaction was superseded");
      return { armed: "B" };
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  playback.start({ mode: "jack" });
  jackTransport.update(jackSnapshot({ absoluteBeat: 102.1 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.3 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playback.snapshot().activationArm.last.ok, false);

  jackTransport.update(jackSnapshot({ absoluteBeat: 103.5 }));
  playback.snapshot();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(armCount, 2);
  assert.equal(playback.snapshot().activationArm.last.ok, true);
  playback.close();
});

test("beat-derived macro position preserves repeated block ids", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 2 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 3 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B", "A"] });
  const score = store.getScore();

  assert.deepEqual(deriveMacroPosition(score, 1.5), {
    macroIndex: 0,
    activeBlockId: "A",
    compositionBeat: 1.5,
    cycleBeat: 1.5,
    blockStartBeat: 0,
    blockEndBeat: 2,
    beatIntoBlock: 1.5,
    durationBeats: 2
  });
  assert.deepEqual(deriveMacroPosition(score, 5.5), {
    macroIndex: 2,
    activeBlockId: "A",
    compositionBeat: 5.5,
    cycleBeat: 5.5,
    blockStartBeat: 5,
    blockEndBeat: 7,
    beatIntoBlock: 0.5,
    durationBeats: 2
  });
});

test("JACK macro playback catches up from the previous block end beat", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 2 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 2 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(defaultConfig, { now: () => 1000 });
  const playback = createMacroPlayback(store, defaultConfig, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 20 }));
  playback.start({ mode: "jack" });

  jackTransport.update(jackSnapshot({ absoluteBeat: 25.1 }));
  const snapshot = playback.snapshot();
  assert.equal(store.getScore().structureState.activeBlockId, "A");
  assert.equal(snapshot.activeBlockStartBeat, 24);
  assert.equal(snapshot.activeBlockEndBeat, 26);
  assert.equal(snapshot.beatsRemaining, 0.8999999999999986);

  playback.close();
});

test("JACK macro playback ignores snapshots that are not rolling and fresh", () => {
  let now = 1000;
  const config = {
    ...defaultConfig,
    transport: {
      jack: {
        freshnessMs: 100
      }
    }
  };
  const store = createScoreStore(createInitialScore(config));
  store.replaceMesoBlock("A", { duration: { beats: 2 }, players: {} });
  store.replaceMesoBlock("B", { duration: { beats: 2 }, players: {} });
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  const jackTransport = createJackTransportState(config, { now: () => now });
  const playback = createMacroPlayback(store, config, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 20, state: "stopped" }));
  playback.start({ mode: "jack" });
  assert.equal(playback.snapshot().activeBlockStartBeat, null);

  jackTransport.update(jackSnapshot({ absoluteBeat: 20, state: "rolling" }));
  assert.equal(playback.snapshot().activeBlockEndBeat, 22);

  now = 1200;
  jackTransport.events.emit("snapshot", { type: "snapshot", transport: jackTransport.snapshot() });
  assert.equal(jackTransport.snapshot().status, "stale");
  assert.equal(store.getScore().structureState.activeBlockId, "A");

  playback.close();
});

function createFakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = pending.indexOf(timer);
      if (index >= 0) {
        pending.splice(index, 1);
      }
    },
    fire(index) {
      const [timer] = pending.splice(index, 1);
      timer.callback();
    }
  };
}

function jackSnapshot(options = {}) {
  const absoluteBeat = options.absoluteBeat ?? 100;
  return {
    source: "jack",
    host: "wren",
    state: options.state ?? "rolling",
    frame: 767223806,
    frameRate: 48000,
    bbtValid: options.bbtValid ?? true,
    bar: Math.floor(absoluteBeat / 4) + 1,
    beat: Math.floor(absoluteBeat % 4) + 1,
    tick: (absoluteBeat % 1) * 1920,
    beatsPerBar: 4,
    beatType: 4,
    ticksPerBeat: 1920,
    beatsPerMinute: 120,
    absoluteBeat,
    observedAt: 1782580000000
  };
}
