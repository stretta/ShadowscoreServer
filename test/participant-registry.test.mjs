import assert from "node:assert/strict";
import test from "node:test";
import { createParticipantRegistry } from "../src/playback/participant-registry.mjs";

test("participant registry projects RNBO targets and resolves existing assignment identities", async () => {
  let currentTime = Date.parse("2026-08-25T18:00:00.000Z");
  const assignments = {
    "player-1": { deviceId: "wren", rnboTargetId: "wren:source", locked: false },
    "player-2": { deviceId: "heron", locked: false },
    "player-3": { deviceId: "raven", rnboTargetId: "raven:missing", locked: true },
    "player-4": {}
  };
  const registry = createParticipantRegistry({
    now: () => currentTime,
    getAssignments: () => assignments
  });

  registry.replaceRnboTargets([
    target("wren:source", "wren"),
    target("heron:a", "heron"),
    target("heron:b", "heron"),
    target("finch:source", "finch", false)
  ]);
  const snapshot = registry.snapshot();

  assert.deepEqual(snapshot.participants.map((entry) => entry.participant_id), [
    "finch:source", "heron:a", "heron:b", "wren:source"
  ]);
  assert.equal(snapshot.participants.find((entry) => entry.participant_id === "wren:source").adapter, "rnbo-osc");
  assert.equal(snapshot.participants.find((entry) => entry.participant_id === "finch:source").status, "offline");
  assert.equal(snapshot.assignments["player-1"].status, "resolved");
  assert.equal(snapshot.assignments["player-1"].matched_by, "exact");
  assert.equal(snapshot.assignments["player-2"].status, "ambiguous");
  assert.deepEqual(snapshot.assignments["player-2"].candidate_participant_ids, ["heron:a", "heron:b"]);
  assert.equal(snapshot.assignments["player-3"].status, "locked-missing");
  assert.equal(snapshot.assignments["player-4"].status, "unassigned");

  currentTime += 6_000;
  registry.replaceRnboTargets([target("heron:a", "heron"), target("heron:b", "heron")]);
  assert.equal(registry.snapshot().assignments["player-1"].status, "offline");
  assert.equal(registry.snapshot().participants.find((entry) => entry.participant_id === "wren:source").available, false);
  registry.replaceRnboTargets([
    target("wren:new-source", "wren"),
    target("heron:a", "heron"),
    target("heron:b", "heron")
  ]);
  assert.equal(registry.snapshot().assignments["player-1"].status, "resolved");
  assert.equal(registry.snapshot().assignments["player-1"].participant_id, "wren:new-source");
  assert.equal(registry.snapshot().assignments["player-1"].matched_by, "stable-device");
  assert.throws(() => registry.replaceRnboTargets([
    target("duplicate", "one"), target("duplicate", "two")
  ]), /duplicate participant identity/);
  registry.close();
});

test("participant registry replaces realtime endpoints without an old disconnect evicting the new session", () => {
  let currentTime = Date.parse("2026-08-25T18:00:00.000Z");
  const events = [];
  const registry = createParticipantRegistry({ now: () => currentTime });
  const unsubscribe = registry.subscribe((message) => events.push(message));

  registry.connectRealtimeSession(session("laptop", "connection-1"));
  currentTime += 1_000;
  registry.connectRealtimeSession(session("laptop", "connection-2"));
  assert.equal(registry.disconnectRealtimeSession("connection-1"), false);
  assert.equal(registry.snapshot().participants[0].endpoint.connection_id, "connection-2");
  assert.equal(registry.snapshot().participants[0].stable_device_id, "ableton-laptop");
  assert.deepEqual(registry.snapshot().participants[0].capabilities, {
    protocol_version: 1,
    declared: ["score:prepare"],
    granted: ["topics:read", "participant:register"]
  });
  assert.equal(registry.snapshot().participants[0].available, true);
  assert.equal(events.at(-1).event, "participant.endpoint_replaced");

  currentTime += 1_000;
  assert.equal(registry.disconnectRealtimeSession("connection-2"), true);
  assert.equal(registry.snapshot().participants[0].status, "offline");
  assert.equal(events.at(-1).event, "participant.offline");

  currentTime += 1_000;
  registry.connectRealtimeSession(session("laptop", "connection-3"));
  assert.equal(registry.resolveAssignment({ clientId: "laptop" }).status, "resolved");
  assert.equal(events.at(-1).event, "participant.reconnected");
  unsubscribe();
  assert.equal(registry.subscriberCount(), 0);
  registry.close();
});

test("participant registry refreshes its RNBO source only while observed", async () => {
  let intervalCallback;
  let cleared = false;
  let loads = 0;
  const registry = createParticipantRegistry({
    loadRnboTargets: async () => {
      loads += 1;
      return [target("wren:source", "wren")];
    },
    timers: {
      setInterval(callback) {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval() { cleared = true; }
    }
  });

  const unsubscribe = registry.subscribe(() => {});
  await registry.current();
  assert.equal(loads, 1);
  await intervalCallback();
  assert.equal(loads, 2);
  unsubscribe();
  assert.equal(cleared, true);
  registry.close();
});

function target(id, hardwareUnitId, available = true) {
  return {
    id,
    hardwareUnitId,
    hardwareUnitName: hardwareUnitId,
    host: `${hardwareUnitId}.local`,
    port: 9000,
    address: `/rnbo/${id}`,
    available,
    capabilities: { stagedScoreActivation: true }
  };
}

function session(clientId, connectionId) {
  return {
    clientId,
    connectionId,
    protocol: "shadowscore.realtime.v2",
    role: "playback",
    capabilities: ["topics:read", "participant:register"],
    declaredCapabilities: ["score:prepare"],
    participantProtocolVersion: 1,
    stableDeviceId: "ableton-laptop",
    displayName: "Ableton Live",
    runtime: { name: "Shadowscore M4L", version: "0.1.0", platform: "max" },
    topics: ["participants"]
  };
}
