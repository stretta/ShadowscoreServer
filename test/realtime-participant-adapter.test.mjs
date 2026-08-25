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
