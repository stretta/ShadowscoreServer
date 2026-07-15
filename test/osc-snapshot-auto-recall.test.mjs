import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createOscSnapshotAutoRecall } from "../src/osc/snapshot-auto-recall.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("automatic recall runs once for select, advance, and reset block entries", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const calls = [];
  const automatic = createOscSnapshotAutoRecall(store, {
    async recall(request) {
      calls.push(request);
      return { ok: true, id: `recall-${calls.length}`, attemptedWriteCount: 2 };
    }
  });

  store.updateStructureState({ macroIndex: 1, activeBlockId: "B" }, { sourceClientId: "manual-select" });
  store.updateStructureState({ macroIndex: 1, activeBlockId: "B" }, { sourceClientId: "repeated-snapshot" });
  store.advanceStructurePlayhead({ sourceClientId: "manual-advance" });
  store.resetStructurePlayhead({ sourceClientId: "manual-reset" });
  await automatic.flush();

  assert.deepEqual(calls.map(({ blockId, macroIndex, sourceClientId }) => ({ blockId, macroIndex, sourceClientId })), [
    { blockId: "B", macroIndex: 1, sourceClientId: "manual-select" },
    { blockId: "C", macroIndex: 2, sourceClientId: "manual-advance" },
    { blockId: "A", macroIndex: 0, sourceClientId: "manual-reset" }
  ]);
  assert.equal(automatic.snapshot().last.recallId, "recall-3");
  assert.equal(automatic.snapshot().pending, false);
  automatic.close();
});

test("automatic recall serializes rapid entries and records failures without blocking later recalls", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const order = [];
  const automatic = createOscSnapshotAutoRecall(store, {
    async recall({ blockId }) {
      order.push(`start:${blockId}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end:${blockId}`);
      if (blockId === "B") throw new Error("B unavailable");
      return { ok: true, id: `recall-${blockId}` };
    }
  });

  store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
  store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
  await automatic.flush();

  assert.deepEqual(order, ["start:B", "end:B", "start:C", "end:C"]);
  assert.equal(automatic.snapshot().last.ok, true);
  assert.equal(automatic.snapshot().last.blockId, "C");
  automatic.close();
});

test("repeated block ids at different macro positions each trigger recall", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  store.updateMacrostructure({ tempo: 120, blocks: ["A", "B", "A"] });
  const calls = [];
  const automatic = createOscSnapshotAutoRecall(store, { recall: async (request) => { calls.push(request); return { ok: true }; } });

  store.updateStructureState({ macroIndex: 2, activeBlockId: "A" }, { sourceClientId: "macro-playback" });
  await automatic.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].macroIndex, 2);
  automatic.close();
});

test("block and snapshot edits do not recall when the active entry is unchanged", async () => {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const calls = [];
  const automatic = createOscSnapshotAutoRecall(store, { recall: async (request) => { calls.push(request); return { ok: true }; } });

  store.replaceMesoBlock("A", { duration: { bars: 8 }, players: {} });
  store.replaceOscAssignment("list-a", { app: "listsequencer", deviceId: "heron" });
  store.addOscClip("list-a-opening", { app: "listsequencer", params: { Clock: 0 }, inputPorts: {} });
  store.assignOscLayer("A", "list-a", "list-a-opening");
  await automatic.flush();

  assert.deepEqual(calls, []);
  automatic.close();
});
