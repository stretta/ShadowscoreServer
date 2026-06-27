import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createMacroPlayback, macroBlockDurationMs } from "../src/playback/macro-playback.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

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
