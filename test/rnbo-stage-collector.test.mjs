import assert from "node:assert/strict";
import test from "node:test";
import { createRnboStageCollector, rnboCurrentStageUrl } from "../src/playback/rnbo-stage-collector.mjs";

const targets = [
  { id: "finch:rnbo", host: "192.168.68.104", currentStagePath: "/rnbo/inst/9/messages/out/current_stage", available: true },
  { id: "heron:rnbo", host: "192.168.68.101", currentStagePath: "/rnbo/inst/7/messages/out/current_stage", available: true }
];

test("RNBO stage collector polls peer OSCQuery paths concurrently and overlays observations", async () => {
  let now = 1000;
  const urls = [];
  const collector = createRnboStageCollector({
    transport: { rnboClient: { pollIntervalMs: 0, timeoutMs: 50, staleAfterMs: 500 } }
  }, {
    autoStart: false,
    now: () => now,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, async json() { return { VALUE: [url.includes("68.104") ? 863 : 864] }; } };
    }
  });

  await collector.refresh(targets);
  const observed = collector.targets(targets);

  assert.deepEqual(urls.sort(), [
    "http://192.168.68.101:5678/rnbo/inst/7/messages/out/current_stage",
    "http://192.168.68.104:5678/rnbo/inst/9/messages/out/current_stage"
  ]);
  assert.equal(observed[0].currentStage, 863);
  assert.equal(observed[0].stateAgeMs, 0);
  assert.equal(observed[0].stageReadbackStatus, "fresh");

  now = 1600;
  assert.equal(collector.targets(targets)[0].stageReadbackStatus, "stale");
});

test("RNBO stage collector retains the last value and reports read failures", async () => {
  let fail = false;
  let now = 1000;
  const collector = createRnboStageCollector({}, {
    autoStart: false,
    now: () => now,
    fetchImpl: async () => {
      if (fail) throw new Error("peer offline");
      return { ok: true, async json() { return { VALUE: [42] }; } };
    }
  });

  await collector.refresh([targets[0]]);
  fail = true;
  now = 1100;
  await collector.refresh();
  const observed = collector.targets([targets[0]])[0];

  assert.equal(observed.currentStage, 42);
  assert.equal(observed.stageReadbackStatus, "error");
  assert.equal(observed.stageReadbackError, "peer offline");
});

test("RNBO stage collector coalesces overlapping refreshes", async () => {
  let finish;
  let calls = 0;
  const collector = createRnboStageCollector({}, {
    autoStart: false,
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => { finish = () => resolve({ ok: true, async json() { return { VALUE: [7] }; } }); });
    }
  });

  const first = collector.refresh([targets[0]]);
  const second = collector.refresh();
  assert.equal(first, second);
  finish();
  await first;
  assert.equal(calls, 1);
});

test("RNBO current stage URL prefers advertised OSCQuery endpoints", () => {
  assert.equal(rnboCurrentStageUrl({
    oscQueryUrl: "http://finch.local:5678",
    currentStagePath: "/rnbo/inst/9/messages/out/current_stage"
  }), "http://finch.local:5678/rnbo/inst/9/messages/out/current_stage");
});
