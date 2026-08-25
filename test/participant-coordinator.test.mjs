import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPlaybackParticipantCoordinator } from "../src/playback/participant-coordinator.mjs";

test("playback participant coordinator exposes transport-neutral read capabilities", async () => {
  const deliveryEvents = new EventEmitter();
  const calls = [];
  const adapter = {
    enabled: true,
    transferEvents: deliveryEvents,
    async playbackUpdates(blockId, options) {
      calls.push({ blockId, options });
      return { blockId, state: "prepared", targets: {} };
    },
    async prepareBlock(blockId, reason, options) {
      calls.push({ prepare: { blockId, reason, options } });
      return { blockId, prepared: true };
    },
    async applyBlockUpdate(blockId, options) {
      calls.push({ apply: { blockId, options } });
      return { blockId, state: "active" };
    },
    async activatePreparedBlock(blockId, options) {
      calls.push({ activate: { blockId, options } });
      return { blockId, state: "active", fastPath: true };
    },
    schedulePreparedActivations(options) {
      return [{ targetId: options.targetId, transactionId: 42 }];
    },
    async confirmPreparedActivations(requests, options) {
      return requests.map((request) => ({ ...request, tempo: options.tempo }));
    },
    lifecycleEvents() { return [{ type: "prepare_completed" }]; },
    transferStatus() { return { summary: { readyCount: 1 } }; },
    sendStatus() { return [{ targetId: "finch" }]; },
    sendQueueStatus() { return { inProgress: false, queued: false }; },
    async waitForIdle() { return { inProgress: false, queued: false }; }
  };
  const coordinator = createPlaybackParticipantCoordinator({ adapter, adapterId: "rnbo" });

  assert.equal(coordinator.enabled, true);
  assert.deepEqual(coordinator.descriptor(), {
    adapterId: "rnbo",
    enabled: true,
    capabilities: {
      playbackUpdates: true,
      prepareBlock: true,
      prepareParticipants: false,
      activateParticipants: false,
      applyBlockUpdate: true,
      activatePreparedBlock: true,
      lifecycleEvents: true,
      deliveryStatus: true,
      operationQueueStatus: true
    }
  });
  assert.deepEqual(await coordinator.playbackUpdates("A", { targets: ["cached"] }), {
    blockId: "A",
    state: "prepared",
    targets: {}
  });
  assert.deepEqual(calls, [{ blockId: "A", options: { targets: ["cached"] } }]);
  assert.deepEqual(await coordinator.prepareBlock("B", "lookahead", { requireReady: true }), {
    blockId: "B",
    prepared: true
  });
  assert.deepEqual(await coordinator.applyBlockUpdate("A", { activationMode: "now" }), {
    blockId: "A",
    state: "active"
  });
  assert.equal((await coordinator.activatePreparedBlock("B", { boundary: "next-cycle" })).fastPath, true);
  const schedule = coordinator.schedulePreparedActivations({ targetId: "finch" });
  assert.deepEqual(schedule, [{ targetId: "finch", transactionId: 42 }]);
  assert.deepEqual(await coordinator.confirmPreparedActivations(schedule, { tempo: 120 }), [{
    targetId: "finch",
    transactionId: 42,
    tempo: 120
  }]);
  assert.deepEqual(calls.slice(1), [
    { prepare: { blockId: "B", reason: "lookahead", options: { requireReady: true } } },
    { apply: { blockId: "A", options: { activationMode: "now" } } },
    { activate: { blockId: "B", options: { boundary: "next-cycle" } } }
  ]);
  assert.deepEqual(coordinator.lifecycleEvents(), [{ type: "prepare_completed" }]);
  assert.equal(coordinator.deliveryStatus().summary.readyCount, 1);
  assert.deepEqual(coordinator.participantDeliveryStatus(), [{ targetId: "finch" }]);
  assert.deepEqual(coordinator.operationQueueStatus(), { inProgress: false, queued: false });
  assert.deepEqual(await coordinator.waitForIdle(), { inProgress: false, queued: false });
  assert.equal(coordinator.deliveryEvents, deliveryEvents);
});

test("disabled playback participant coordinator has safe diagnostics and rejects updates", async () => {
  const coordinator = createPlaybackParticipantCoordinator();
  assert.equal(coordinator.enabled, false);
  assert.deepEqual(coordinator.lifecycleEvents(), []);
  assert.deepEqual(coordinator.participantDeliveryStatus(), []);
  assert.deepEqual(coordinator.operationQueueStatus(), {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  });
  assert.equal(coordinator.deliveryStatus().summary.targetCount, 0);
  await assert.rejects(coordinator.playbackUpdates("A"), /cannot playbackUpdates/);
  await assert.rejects(coordinator.prepareBlock("A"), /cannot prepareBlock/);
  await assert.rejects(coordinator.applyBlockUpdate("A"), /cannot applyBlockUpdate/);
});

test("playback participant coordinator falls back to prepared apply activation", async () => {
  let received;
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: {
      enabled: true,
      async applyBlockUpdate(blockId, options) {
        received = { blockId, options };
        return { state: "active" };
      }
    }
  });

  assert.equal((await coordinator.activatePreparedBlock("B", { authorize: true })).state, "active");
  assert.deepEqual(received, {
    blockId: "B",
    options: {
      activationMode: "continue",
      boundary: "next-cycle",
      reusePrepared: true,
      authorize: true
    }
  });
});

test("playback participant coordinator assigns one operation id across participant adapters", async () => {
  const calls = [];
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: { enabled: true },
    participantAdapters: [{
      enabled: true,
      async prepareBlock(blockId, reason, options) {
        calls.push({ blockId, reason, options });
        return { participating: true, operationId: options.operationId };
      },
      async activatePreparedBlock(blockId, options) {
        calls.push({ activateBlockId: blockId, activateOptions: options });
        return { participating: true, operationId: options.operationId };
      }
    }]
  });

  assert.equal(coordinator.descriptor().capabilities.prepareParticipants, true);
  const result = await coordinator.prepareParticipants("B", "lookahead", {
    operationId: "operation-7",
    participantIds: ["realtime:laptop"]
  });
  assert.deepEqual(result, {
    operationId: "operation-7",
    blockId: "B",
    results: [{ participating: true, operationId: "operation-7" }]
  });
  assert.deepEqual(calls, [{
    blockId: "B",
    reason: "lookahead",
    options: {
      operationId: "operation-7",
      participantIds: ["realtime:laptop"]
    }
  }]);

  assert.equal(coordinator.descriptor().capabilities.activateParticipants, true);
  const activation = await coordinator.activateParticipants("B", {
    operationId: "activation-7",
    preparedOperationId: "operation-7",
    boundary: "next-cycle"
  });
  assert.deepEqual(activation, {
    operationId: "activation-7",
    preparedOperationId: "operation-7",
    blockId: "B",
    results: [{ participating: true, operationId: "activation-7" }]
  });
  assert.deepEqual(calls.at(-1), {
    activateBlockId: "B",
    activateOptions: {
      operationId: "activation-7",
      preparedOperationId: "operation-7",
      boundary: "next-cycle"
    }
  });
});
