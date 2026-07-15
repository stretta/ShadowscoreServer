import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { runAutomaticOscOnboarding } from "../src/osc/onboarding.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("automatic OSC onboarding is disabled by default without reading live targets", async () => {
  let loaded = false;
  const result = await runAutomaticOscOnboarding({
    store: createScoreStore(createInitialScore(defaultConfig)),
    config: defaultConfig,
    loadTargets: async () => { loaded = true; return []; },
    captureTarget: async () => { throw new Error("should not capture"); }
  });
  assert.deepEqual(result, { enabled: false, onboarded: [], skipped: [] });
  assert.equal(loaded, false);
});

test("automatic OSC onboarding requires a unique stable identity and reuses score resources", async () => {
  const config = mergeConfig(defaultConfig, { osc: { onboarding: { automatic: { enabled: true, roles: [
    { roleId: "list-a", label: "List A", app: "listsequencer", deviceId: "heron" }
  ] } } } });
  const store = createScoreStore(createInitialScore(config));
  let gateTime = 0.4;
  const options = {
    store,
    config,
    loadTargets: async () => [target("list-main")],
    captureTarget: async (target) => captured(target, gateTime)
  };

  const first = await runAutomaticOscOnboarding(options);
  assert.equal(first.onboarded[0].clipId, "a-list-a");
  assert.equal(store.getScore().mesostructure.A.oscLayers["list-a"].clipId, "a-list-a");
  gateTime = 0.8;
  const second = await runAutomaticOscOnboarding(options);
  assert.equal(second.onboarded.length, 1);
  assert.equal(Object.keys(store.getScore().oscAssignments).length, 1);
  assert.equal(Object.keys(store.getScore().oscClips).length, 1);
  assert.equal(store.getScore().oscClips["a-list-a"].params.GateTime, 0.8);

  const ambiguous = await runAutomaticOscOnboarding({ ...options, loadTargets: async () => [target("list-main"), target("list-other")] });
  assert.equal(ambiguous.onboarded.length, 0);
  assert.equal(ambiguous.skipped[0].status, "ambiguous");
  assert.deepEqual(ambiguous.skipped[0].targetIds, ["list-main", "list-other"]);
});

test("automatic OSC onboarding reports capture failures without mutating the score", async () => {
  const config = mergeConfig(defaultConfig, { osc: { onboarding: { automatic: { enabled: true, roles: [
    { roleId: "list-a", app: "listsequencer", deviceId: "heron" }
  ] } } } });
  const store = createScoreStore(createInitialScore(config));
  const before = store.getScore().version;
  const result = await runAutomaticOscOnboarding({
    store,
    config,
    loadTargets: async () => [target("list-main")],
    captureTarget: async () => { throw new Error("readback incomplete"); }
  });
  assert.equal(result.skipped[0].status, "capture-failed");
  assert.match(result.skipped[0].message, /readback incomplete/);
  assert.equal(store.getScore().version, before);
  assert.deepEqual(store.getScore().oscAssignments, {});
  assert.deepEqual(store.getScore().oscClips, {});
});

test("automatic OSC onboarding reports discovery failures instead of breaking registration workflows", async () => {
  const config = mergeConfig(defaultConfig, { osc: { onboarding: { automatic: { enabled: true, roles: [
    { roleId: "list-a", app: "listsequencer", deviceId: "heron" }
  ] } } } });
  const result = await runAutomaticOscOnboarding({
    store: createScoreStore(createInitialScore(config)),
    config,
    loadTargets: async () => { throw new Error("registry unavailable"); },
    captureTarget: async () => { throw new Error("should not capture"); }
  });
  assert.equal(result.enabled, true);
  assert.equal(result.skipped[0].status, "discovery-failed");
  assert.match(result.skipped[0].message, /registry unavailable/);
});

function target(id) {
  return { id, label: "List Sequencer", app: "listsequencer", deviceId: "heron", unitId: "heron", status: "online", sendable: true };
}

function captured(target, gateTime) {
  return {
    complete: true,
    diagnostics: [],
    clip: {
      name: "List A",
      schemaVersion: 1,
      app: "listsequencer",
      params: { GateTime: gateTime },
      inputPorts: {},
      capture: { deviceId: target.deviceId, targetId: target.id, capturedAt: "2026-07-15T12:00:00.000Z", complete: true, diagnostics: [] }
    }
  };
}
