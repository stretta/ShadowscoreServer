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
      participantRuntime: false,
      applyBlockUpdate: true,
      activatePreparedBlock: true,
      lifecycleEvents: true,
      deliveryStatus: true,
      operationQueueStatus: true,
      orchestratedOperations: true
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
  const preparedOperationId = calls[1].prepare.options.operationId;
  const activationOperationId = calls[3].activate.options.operationId;
  assert.match(preparedOperationId, /^[0-9a-f-]{36}$/);
  assert.match(activationOperationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.slice(1), [
    { prepare: { blockId: "B", reason: "lookahead", options: { requireReady: true, operationId: preparedOperationId } } },
    { apply: { blockId: "A", options: { activationMode: "now" } } },
    { activate: { blockId: "B", options: { boundary: "next-cycle", operationId: activationOperationId, preparedOperationId } } }
  ]);
  assert.deepEqual(coordinator.lifecycleEvents(), [{ type: "prepare_completed" }]);
  assert.equal(coordinator.deliveryStatus().summary.readyCount, 1);
  assert.deepEqual(coordinator.participantDeliveryStatus(), [{ targetId: "finch" }]);
  assert.deepEqual(coordinator.participantRuntimeStatus(), []);
  assert.deepEqual(coordinator.operationQueueStatus(), { inProgress: false, queued: false });
  assert.deepEqual(await coordinator.waitForIdle(), { inProgress: false, queued: false });
  assert.equal(coordinator.deliveryEvents, deliveryEvents);
});

test("disabled playback participant coordinator has safe diagnostics and rejects updates", async () => {
  const coordinator = createPlaybackParticipantCoordinator();
  assert.equal(coordinator.enabled, false);
  assert.deepEqual(coordinator.lifecycleEvents(), []);
  assert.deepEqual(coordinator.participantDeliveryStatus(), []);
  assert.deepEqual(coordinator.participantRuntimeStatus(), []);
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
      },
      snapshot() {
        return { adapter: "websocket-json", execution: [{ status: "advancing" }] };
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
  assert.equal(coordinator.descriptor().capabilities.participantRuntime, true);
  assert.deepEqual(coordinator.participantRuntimeStatus(), [{
    adapter: "websocket-json",
    execution: [{ status: "advancing" }]
  }]);
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

test("unified operations freeze the RNBO cohort while software adapters remain diagnostics-only", async () => {
  const calls = [];
  const primary = {
    enabled: true,
    async prepareBlock(blockId, reason, options) {
      calls.push({ kind: "prepare", blockId, reason, options });
      return { targets: [
        { target: { id: "finch" }, compiled: { ack: { status: "prepared" } } },
        { target: { id: "raven" }, compiled: { ack: { status: "prepared" } } }
      ] };
    },
    async activatePreparedBlock(blockId, options) {
      calls.push({ kind: "activate", blockId, options });
      return { state: "active", targets: {
        finch: { state: "active" },
        raven: { state: "active" }
      } };
    }
  };
  const software = {
    enabled: true,
    adapterId: "websocket-json",
    async prepareBlock() { throw new Error("diagnostics-only adapter was enrolled"); },
    snapshot() { return { adapter: "websocket-json" }; }
  };
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: primary,
    adapterId: "rnbo",
    participantAdapters: [software]
  });

  const prepared = await coordinator.prepareOperation("B", "lookahead", { operationId: "prepare-frozen" });
  assert.equal(prepared.state, "ready");
  assert.deepEqual(prepared.partitions.map(({ adapterId, enrolled, state, participantIds }) => ({ adapterId, enrolled, state, participantIds })), [
    { adapterId: "rnbo", enrolled: true, state: "ready", participantIds: ["finch", "raven"] },
    { adapterId: "websocket-json", enrolled: false, state: "excluded", participantIds: undefined }
  ]);

  const activated = await coordinator.activateOperation("B", {
    operationId: "activate-frozen",
    preparedOperationId: "prepare-frozen"
  });
  assert.equal(activated.state, "active");
  assert.deepEqual(calls.at(-1).options.targetIds, ["finch", "raven"]);
  assert.equal(coordinator.operationStatus("activate-frozen").state, "active");
});

test("unified activation rolls back already-active partitions when a later adapter fails", async () => {
  const rolledBack = [];
  const primary = {
    enabled: true,
    async prepareBlock() {
      return { targets: [{ target: { id: "finch" }, compiled: { ack: { status: "prepared" } } }] };
    },
    async activatePreparedBlock() {
      return { state: "active", targets: { finch: { state: "active" } } };
    },
    async rollbackBlock(blockId, options) {
      rolledBack.push({ blockId, operationId: options.operationId });
      return { stopped: true };
    }
  };
  const software = {
    enabled: true,
    adapterId: "websocket-json",
    async prepareBlock() {
      return { participatingParticipantIds: ["realtime:laptop"], acknowledgements: [{ status: "ready" }] };
    },
    async activatePreparedBlock() {
      throw Object.assign(new Error("software ACTIVE timeout"), { code: "PLAYBACK_ACTIVE_TIMEOUT" });
    },
    snapshot() { return { adapter: "websocket-json" }; }
  };
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: primary,
    adapterId: "rnbo",
    participantAdapters: [software],
    enrolledParticipantAdapters: ["websocket-json"]
  });

  await coordinator.prepareOperation("A", "test", { operationId: "prepare-all" });
  await assert.rejects(
    coordinator.activateOperation("A", { operationId: "activate-all", preparedOperationId: "prepare-all" }),
    (error) => error.code === "PLAYBACK_ACTIVE_TIMEOUT" && error.operation.rollback[0].ok === true
  );
  assert.deepEqual(rolledBack, [{ blockId: "A", operationId: "activate-all" }]);
  assert.equal(coordinator.operationStatus("activate-all").state, "failed");
});

test("unified operations reject missing READY and ACTIVE evidence", async () => {
  const missingReady = createPlaybackParticipantCoordinator({
    adapter: { enabled: true, async prepareBlock() { return {}; } },
    adapterId: "rnbo"
  });
  await assert.rejects(
    missingReady.prepareOperation("A", "test", { operationId: "missing-ready" }),
    (error) => error.code === "PLAYBACK_PREPARE_INCOMPLETE"
  );

  const missingActive = createPlaybackParticipantCoordinator({
    adapter: {
      enabled: true,
      async prepareBlock() {
        return { targets: [{ target: { id: "finch" }, compiled: { ack: { status: "prepared" } } }] };
      },
      async activatePreparedBlock() { return {}; }
    },
    adapterId: "rnbo"
  });
  await missingActive.prepareOperation("A", "test", { operationId: "ready" });
  await assert.rejects(
    missingActive.activateOperation("A", { operationId: "missing-active", preparedOperationId: "ready" }),
    (error) => error.code === "PLAYBACK_ACTIVATION_INCOMPLETE"
  );
});

test("unified preparation accepts the RNBO single-target compiled result", async () => {
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: {
      enabled: true,
      async prepareBlock() {
        return { targetId: "finch", ack: { ok: true, status: "prepared" } };
      }
    },
    adapterId: "rnbo"
  });

  const prepared = await coordinator.prepareOperation("A", "test", { operationId: "single-target" });
  assert.equal(prepared.state, "ready");
  assert.deepEqual(prepared.partitions[0].participantIds, ["finch"]);
});

test("unified preparation accepts an explicit RNBO no-op target list", async () => {
  const coordinator = createPlaybackParticipantCoordinator({
    adapter: {
      enabled: true,
      async prepareBlock() {
        return { targets: [], partial: true, scope: "staged-only" };
      }
    },
    adapterId: "rnbo"
  });

  const prepared = await coordinator.prepareOperation("A", "transport-start", { operationId: "already-ready" });
  assert.equal(prepared.state, "ready");
  assert.equal(prepared.partitions[0].state, "empty");
  assert.deepEqual(prepared.partitions[0].participantIds, []);
});
