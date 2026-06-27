import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createMacroPlayback, macroBlockDurationMs } from "../src/playback/macro-playback.mjs";
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

test("macro playback uses beat durations directly", () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.replaceMesoBlock("A", { duration: { beats: 3 }, players: {} });
  store.updateMacrostructure({ tempo: 60, blocks: ["A"] });

  assert.equal(macroBlockDurationMs(store.getScore(), defaultConfig), 3000);
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
      absoluteBeat: 104
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
