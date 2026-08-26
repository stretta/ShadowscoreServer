import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSPORT_START_MAX_OPERATION_ID,
  activateTransportStartRequest,
  armTransportStartRequest,
  cancelTransportStartRequest,
  coordinateTransactionalTransportStart,
  selectTransactionalTransportStartCohort,
  supportsTransactionalTransportStart,
  validateTransportStartAck
} from "../src/playback/transactional-transport-start.mjs";

test("transactional start requests use the fixed seven-integer client contract", () => {
  assert.deepEqual(armTransportStartRequest({
    operationId: 4001,
    startStage: 12,
    maxSteps: 1024,
    clockInterval: 120,
    expiryBeats: 2
  }), [1, 1, 4001, 12, 1024, 120, 2]);
  assert.deepEqual(activateTransportStartRequest(4001), [1, 2, 4001, 0, 0, 0, 0]);
  assert.deepEqual(cancelTransportStartRequest(4001), [1, 3, 4001, 0, 0, 0, 0]);
});

test("transactional start requests preserve exact RNBO operation identity and timing bounds", () => {
  assert.equal(armTransportStartRequest({
    operationId: TRANSPORT_START_MAX_OPERATION_ID,
    startStage: 1023,
    maxSteps: 1024,
    clockInterval: 120
  })[2], TRANSPORT_START_MAX_OPERATION_ID);
  assert.throws(() => activateTransportStartRequest(TRANSPORT_START_MAX_OPERATION_ID + 1), /operationId/);
  assert.throws(() => cancelTransportStartRequest(2.5), /operationId/);
  assert.throws(() => armTransportStartRequest({ operationId: 1, startStage: 16, maxSteps: 16, clockInterval: 120 }), /startStage/);
  assert.throws(() => armTransportStartRequest({ operationId: 1, startStage: 0, maxSteps: 16, clockInterval: 0 }), /clockInterval/);
});

test("transactional start acknowledgements require exact operation, event, version, and success", () => {
  assert.deepEqual(
    validateTransportStartAck([1, 1, 4001, 12, 0, 1], { operationId: 4001, expectedEvent: "armed" }),
    {
      ok: true,
      value: [1, 1, 4001, 12, 0, 1],
      protocolVersion: 1,
      event: "armed",
      eventCode: 1,
      operationId: 4001,
      expectedOperationId: 4001,
      stage: 12,
      detail: 0,
      success: true,
      status: "armed"
    }
  );
  assert.equal(validateTransportStartAck([1, 2, 4000, 12, 0, 1], { operationId: 4001 }).status, "stale-operation");
  assert.equal(validateTransportStartAck([1, 2, 4001, 12, 0, 1], { operationId: 4001, expectedEvent: "armed" }).status, "event-mismatch");
  assert.equal(validateTransportStartAck([1, 4, 4001, 12, 9, 0], { operationId: 4001 }).status, "rejected");
  assert.equal(validateTransportStartAck([2, 1, 4001, 12, 0, 1], { operationId: 4001 }).status, "version-mismatch");
  assert.equal(validateTransportStartAck([1, 1, 4001], { operationId: 4001 }).status, "malformed");
});

test("transactional fleet start waits for every ARMED client and a safe activation window", async () => {
  const events = [];
  const targets = [cohortTarget("wren"), cohortTarget("raven")];
  const acknowledgements = new Map(targets.map(({ target }) => [target.id, []]));
  let now = 0;
  const result = await coordinateTransactionalTransportStart({
    targets,
    operationId: 4101,
    sendRequest: async (target, request) => {
      events.push(`${request[1] === 1 ? "arm" : request[1] === 2 ? "activate" : "cancel"}:${target.id}`);
      acknowledgements.set(target.id, request[1] === 1
        ? [1, 1, 4101, 20, 0, 1]
        : [1, 2, 4101, 20, 0, 1]);
      return { targetId: target.id, request };
    },
    readAcknowledgement: async (target) => acknowledgements.get(target.id),
    awaitActivationWindow: async () => {
      events.push("activation-window");
      return { available: true, delayMs: 25 };
    },
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.active.acknowledgements.map(({ stage }) => stage), [20, 20]);
  assert.deepEqual(events, [
    "arm:wren",
    "arm:raven",
    "activation-window",
    "activate:wren",
    "activate:raven"
  ]);
});

test("transactional fleet start cancels the entire cohort on a first-stage mismatch", async () => {
  const targets = [cohortTarget("wren"), cohortTarget("finch")];
  const acknowledgements = new Map();
  const commands = [];
  await assert.rejects(() => coordinateTransactionalTransportStart({
    targets,
    operationId: 4102,
    sendRequest: async (target, request) => {
      commands.push([target.id, request[1]]);
      acknowledgements.set(target.id, request[1] === 1
        ? [1, 1, 4102, 20, 0, 1]
        : request[1] === 2
          ? [1, 2, 4102, target.id === "finch" ? 21 : 20, 0, 1]
          : [1, 3, 4102, 0, 0, 1]);
      return { targetId: target.id };
    },
    readAcknowledgement: async (target) => acknowledgements.get(target.id),
    awaitActivationWindow: async () => ({ available: true, delayMs: 0 })
  }), (error) => {
    assert.equal(error.code, "TRANSPORT_START_STAGE_MISMATCH");
    assert.deepEqual(error.rollback.map(({ targetId, ok }) => ({ targetId, ok })), [
      { targetId: "wren", ok: true },
      { targetId: "finch", ok: true }
    ]);
    return true;
  });
  assert.deepEqual(commands.slice(-2), [["wren", 3], ["finch", 3]]);
});

test("transactional fleet start times out stale acknowledgements and cancels every target", async () => {
  const targets = [cohortTarget("wren"), cohortTarget("raven")];
  const commands = [];
  let now = 0;
  await assert.rejects(() => coordinateTransactionalTransportStart({
    targets,
    operationId: 4104,
    sendRequest: async (target, request) => {
      commands.push([target.id, request[1]]);
      return { targetId: target.id };
    },
    readAcknowledgement: async () => [1, 1, 3999, 20, 0, 1],
    awaitActivationWindow: async () => ({ available: true }),
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
    timeoutMs: 20,
    pollIntervalMs: 10
  }), (error) => {
    assert.equal(error.code, "TRANSPORT_START_ACK_TIMEOUT");
    assert.equal(error.cause.attemptCount, 3);
    return true;
  });
  assert.deepEqual(commands, [
    ["wren", 1],
    ["raven", 1],
    ["wren", 3],
    ["raven", 3]
  ]);
});

test("transactional fleet start rejects partial live capability cohorts before sending", async () => {
  const supported = cohortTarget("wren");
  const unsupported = cohortTarget("legacy");
  unsupported.target.transportStartAckPath = undefined;
  assert.equal(supportsTransactionalTransportStart(supported.target), true);
  assert.equal(supportsTransactionalTransportStart(unsupported.target), false);
  let sends = 0;
  await assert.rejects(() => coordinateTransactionalTransportStart({
    targets: [supported, unsupported],
    operationId: 4103,
    sendRequest: async () => { sends += 1; },
    readAcknowledgement: async () => [],
    awaitActivationWindow: async () => ({ available: true })
  }), /does not expose transactional transport start/);
  assert.equal(sends, 0);
});

test("transactional cohort selection keeps a mixed fleet on the legacy path", () => {
  const transactional = cohortTarget("wren").target;
  transactional.clockPhaseResetPath = "/rnbo/wren/messages/in/clock_phase_reset";
  transactional.clockPhaseAckPath = "/rnbo/wren/messages/out/clock_phase_ack";
  const legacy = cohortTarget("raven").target;
  legacy.capabilities.transactionalTransportStart = false;
  legacy.clockPhaseResetPath = "/rnbo/raven/messages/in/clock_phase_reset";
  legacy.clockPhaseAckPath = "/rnbo/raven/messages/out/clock_phase_ack";
  assert.deepEqual(
    selectTransactionalTransportStartCohort([transactional, legacy], ["wren", "raven"], { requirePhaseReset: true }),
    []
  );
  assert.deepEqual(
    selectTransactionalTransportStartCohort([transactional], ["wren"], { requirePhaseReset: true }).map(({ id }) => id),
    ["wren"]
  );
});

function cohortTarget(id) {
  return {
    target: {
      id,
      available: true,
      capabilities: { transactionalTransportStart: true },
      transportStartPath: `/rnbo/${id}/messages/in/TransportStart`,
      transportStartAckPath: `/rnbo/${id}/messages/out/transport_start_ack`
    },
    startStage: 20,
    maxSteps: 44,
    clockInterval: 480
  };
}
