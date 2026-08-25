import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { createParticipantRegistry } from "../src/playback/participant-registry.mjs";
import { compilePlaybackScore, createRealtimePlaybackParticipantAdapter } from "../src/playback/realtime-participant-adapter.mjs";
import { createInitialScore } from "../src/state/score-store.mjs";

test("realtime playback score compiler emits one transport-neutral block and clip contract", () => {
  const score = assignedScore();
  const compiled = compilePlaybackScore(score, "A", ["player-1", "player-2"]);

  assert.equal(compiled.schema, "shadowscore.playback-score.v1");
  assert.equal(compiled.block_id, "A");
  assert.deepEqual(compiled.voice_ids, ["player-1", "player-2"]);
  assert.equal(compiled.voices.length, 2);
  assert.equal(compiled.voices[0].voice_id, "player-1");
  assert.equal(compiled.voices[0].clip.clip_id, "a-player-1");
  assert.equal(compiled.voices[0].clip.notes.length, 2);
  assert.deepEqual(compiled.voices[0].player, { clipId: "a-player-1" });
  assert.equal(compiled.block.tempo, 120);
});

test("realtime playback adapter rejects missing capability, disconnect, and READY timeout", async () => {
  const score = assignedScore();
  const registry = createParticipantRegistry({ getAssignments: () => score.assignments });
  registry.connectRealtimeSession(registrySession());
  const sent = [];
  const adapter = createRealtimePlaybackParticipantAdapter({
    getScore: () => score,
    getParticipantRegistry: () => registry,
    prepareTimeoutMs: 250,
    unrefTimers: false
  });

  adapter.connectSession(adapterSession([], (message) => sent.push(message)));
  await assert.rejects(
    adapter.prepareBlock("A", "test", { operationId: "missing-capability" }),
    (error) => error.code === "PLAYBACK_CAPABILITY_REQUIRED"
  );

  adapter.connectSession(adapterSession(["score:prepare"], (message) => sent.push(message)));
  const disconnectedPreparation = adapter.prepareBlock("A", "test", { operationId: "disconnect" });
  const disconnected = assert.rejects(
    disconnectedPreparation,
    (error) => error.code === "PLAYBACK_PARTICIPANT_DISCONNECTED"
  );
  assert.equal(sent.at(-1).type, "playback.prepare");
  adapter.disconnectSession("connection-1");
  await disconnected;

  adapter.connectSession(adapterSession(["score:prepare"], (message) => sent.push(message), "connection-2"));
  const replacedPreparation = adapter.prepareBlock("A", "test", { operationId: "replaced" });
  const replaced = assert.rejects(
    replacedPreparation,
    (error) => error.code === "PLAYBACK_PARTICIPANT_REPLACED"
  );
  adapter.connectSession(adapterSession(["score:prepare"], (message) => sent.push(message), "connection-3"));
  await replaced;

  await assert.rejects(
    adapter.prepareBlock("A", "test", { operationId: "timeout" }),
    (error) => error.code === "PLAYBACK_READY_TIMEOUT"
  );
  assert.equal(adapter.snapshot().pending.length, 0);

  adapter.close();
  registry.close();
});

test("realtime playback adapter activates only the exact prepared slot and requires exact ACTIVE", async () => {
  const score = assignedScore();
  const registry = createParticipantRegistry({ getAssignments: () => score.assignments });
  registry.connectRealtimeSession(registrySession());
  const sent = [];
  const adapter = createRealtimePlaybackParticipantAdapter({
    getScore: () => score,
    getParticipantRegistry: () => registry,
    activationTimeoutMs: 250,
    unrefTimers: false
  });
  adapter.connectSession(adapterSession(["score:prepare", "score:activate"], (message) => sent.push(message)));

  await prepareAndReady(adapter, sent, "prepare-1");
  await assert.rejects(
    adapter.activatePreparedBlock("A", { operationId: "activate-wrong", preparedOperationId: "not-prepared" }),
    (error) => error.code === "PLAYBACK_ACTIVATION_NOT_READY"
  );

  const activation = adapter.activatePreparedBlock("A", {
    operationId: "activate-1",
    preparedOperationId: "prepare-1",
    boundary: "next-cycle"
  });
  const command = sent.at(-1);
  assert.equal(command.type, "playback.activate");
  await assert.rejects(
    adapter.prepareBlock("A", "test", { operationId: "prepare-conflict" }),
    (error) => error.code === "PLAYBACK_OPERATION_PENDING"
  );
  assert.throws(() => adapter.acceptActive({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: { ...activePayload(command), payload_hash: "wrong" }
  }), (error) => error.code === "PLAYBACK_ACTIVE_MISMATCH");
  adapter.acceptActive({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: activePayload(command)
  });
  assert.equal((await activation).acknowledgements[0].status, "active");
  assert.equal(adapter.snapshot().active[0].operationId, "activate-1");

  await prepareAndReady(adapter, sent, "prepare-2");
  const supersedingPreparation = adapter.prepareBlock("A", "test", { operationId: "prepare-3" });
  await assert.rejects(
    adapter.activatePreparedBlock("A", { operationId: "activate-stale", preparedOperationId: "prepare-2" }),
    (error) => error.code === "PLAYBACK_ACTIVATION_NOT_READY"
  );
  const supersedingCommand = sent.at(-1);
  adapter.acceptReady({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: readyPayload(supersedingCommand)
  });
  await supersedingPreparation;

  await assert.rejects(
    adapter.activatePreparedBlock("A", { operationId: "activate-timeout", preparedOperationId: "prepare-3" }),
    (error) => error.code === "PLAYBACK_ACTIVE_TIMEOUT"
  );
  assert.equal(adapter.snapshot().prepared.length, 0);
  assert.equal(adapter.snapshot().active.length, 0);

  await prepareAndReady(adapter, sent, "prepare-4");
  const replacedActivation = adapter.activatePreparedBlock("A", {
    operationId: "activate-replaced",
    preparedOperationId: "prepare-4"
  });
  const replaced = assert.rejects(
    replacedActivation,
    (error) => error.code === "PLAYBACK_PARTICIPANT_REPLACED"
  );
  adapter.connectSession(adapterSession(
    ["score:prepare", "score:activate"],
    (message) => sent.push(message),
    "connection-2"
  ));
  await replaced;
  assert.equal(adapter.snapshot().pendingActivations.length, 0);

  adapter.close();
  registry.close();
});

test("realtime playback adapter distinguishes execution progress and reconciles reconnects explicitly", async () => {
  const score = assignedScore();
  const registry = createParticipantRegistry({ getAssignments: () => score.assignments });
  registry.connectRealtimeSession(registrySession());
  const sent = [];
  let currentTime = 1_000;
  const adapter = createRealtimePlaybackParticipantAdapter({
    getScore: () => score,
    getParticipantRegistry: () => registry,
    witnessFreshnessMs: 250,
    reconciliationTimeoutMs: 1_000,
    now: () => currentTime,
    unrefTimers: false
  });
  const capabilities = ["score:prepare", "score:activate", "execution:witness"];
  adapter.connectSession(adapterSession(capabilities, (message) => sent.push(message)));

  await prepareAndReady(adapter, sent, "prepare-witness");
  const activation = adapter.activatePreparedBlock("A", {
    operationId: "activate-witness",
    preparedOperationId: "prepare-witness"
  });
  const activate = sent.at(-1);
  adapter.acceptActive({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: activePayload(activate)
  });
  await activation;

  assert.throws(() => adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: { ...activePayload(activate), payload_hash: "wrong", execution: executionPayload(1, 8) }
  }), (error) => error.code === "PLAYBACK_EXECUTION_MISMATCH");
  const observed = adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: { ...activePayload(activate), execution: executionPayload(1, 8) }
  });
  assert.equal(observed.status, "observed");
  currentTime += 100;
  const advancing = adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: { ...activePayload(activate), execution: executionPayload(2, 8.5) }
  });
  assert.equal(advancing.status, "advancing");
  assert.equal(adapter.snapshot().execution[0].fresh, true);
  assert.throws(() => adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: { ...activePayload(activate), execution: executionPayload(2, 9) }
  }), (error) => error.code === "PLAYBACK_EXECUTION_STALE");
  currentTime += 300;
  assert.equal(adapter.snapshot().execution[0].status, "stale");

  adapter.disconnectSession("connection-1");
  assert.equal(adapter.snapshot().active.length, 0);
  assert.equal(adapter.snapshot().execution.length, 0);
  assert.equal(adapter.snapshot().reconciliation.length, 1);

  adapter.connectSession(adapterSession(capabilities, (message) => sent.push(message), "connection-2"));
  assert.equal(adapter.requestReconciliation("realtime:laptop", "connection-2").requested, true);
  const reconcile = sent.at(-1);
  assert.equal(reconcile.type, "playback.reconcile");
  assert.throws(() => adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-2",
    payload: { ...activePayload(activate), execution: executionPayload(1, 9) }
  }), (error) => error.code === "PLAYBACK_EXECUTION_NOT_EXPECTED");
  assert.throws(() => adapter.acceptReconciled({
    participantId: "realtime:laptop",
    connectionId: "connection-2",
    payload: { ...reconcile.payload, state: "active", payload_hash: "wrong", execution: executionPayload(1, 9) }
  }), (error) => error.code === "PLAYBACK_RECONCILIATION_MISMATCH");
  const reconciled = adapter.acceptReconciled({
    participantId: "realtime:laptop",
    connectionId: "connection-2",
    payload: { ...reconcile.payload, state: "active", execution: executionPayload(1, 9) }
  });
  assert.equal(reconciled.state, "active");
  assert.equal(reconciled.execution.status, "observed");
  assert.equal(adapter.snapshot().active[0].reconciled, true);
  assert.equal(adapter.snapshot().reconciliation.length, 0);

  const resumed = adapter.acceptExecution({
    participantId: "realtime:laptop",
    connectionId: "connection-2",
    payload: { ...activePayload(activate), execution: executionPayload(2, 9.25) }
  });
  assert.equal(resumed.status, "advancing");

  adapter.disconnectSession("connection-2");
  adapter.connectSession(adapterSession(["score:prepare", "score:activate"], (message) => sent.push(message), "connection-3"));
  assert.equal(adapter.requestReconciliation("realtime:laptop", "connection-3").reason, "capability-required");
  assert.equal(adapter.snapshot().active.length, 0);
  currentTime += 1_001;
  assert.equal(adapter.requestReconciliation("realtime:laptop", "connection-3"), null);
  assert.equal(adapter.snapshot().reconciliation.length, 0);

  adapter.close();
  registry.close();
});

function assignedScore() {
  const score = createInitialScore(defaultConfig);
  score.assignments["player-1"] = { clientId: "laptop", deviceId: "ableton-laptop", locked: false };
  return score;
}

function registrySession() {
  return {
    clientId: "laptop",
    connectionId: "connection-1",
    protocol: "shadowscore.realtime.v2",
    role: "playback",
    capabilities: ["topics:read", "participant:register", "playback:ready"],
    declaredCapabilities: ["score:prepare"],
    participantProtocolVersion: 1,
    stableDeviceId: "ableton-laptop",
    topics: []
  };
}

function adapterSession(capabilities, send, connectionId = "connection-1") {
  return {
    participantId: "realtime:laptop",
    connectionId,
    clientId: "laptop",
    declaredCapabilities: capabilities,
    send
  };
}

async function prepareAndReady(adapter, sent, operationId) {
  const preparation = adapter.prepareBlock("A", "test", { operationId });
  const command = sent.at(-1);
  assert.equal(command.type, "playback.prepare");
  adapter.acceptReady({
    participantId: "realtime:laptop",
    connectionId: "connection-1",
    payload: readyPayload(command)
  });
  return preparation;
}

function readyPayload(command) {
  return {
    operation_id: command.payload.operation_id,
    block_id: command.payload.block_id,
    score_revision: command.payload.score_revision,
    payload_hash: command.payload.payload_hash
  };
}

function activePayload(command) {
  return {
    operation_id: command.payload.operation_id,
    prepared_operation_id: command.payload.prepared_operation_id,
    block_id: command.payload.block_id,
    score_revision: command.payload.score_revision,
    payload_hash: command.payload.payload_hash
  };
}

function executionPayload(sequence, beat, playing = true) {
  return { sequence, playing, position: { absolute_beat: beat } };
}
