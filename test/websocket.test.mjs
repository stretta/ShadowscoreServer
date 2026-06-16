import assert from "node:assert/strict";
import test from "node:test";
import { createCollaborationHub, parseFrame } from "../src/collaboration/websocket.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("collaboration clients receive welcome, snapshot, and score changes", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  hub.addClient(client);

  assert.deepEqual(client.messages.map((message) => message.type), ["welcome", "snapshot", "presence.list"]);
  client.messages.length = 0;

  client.onMessage({
    type: "voice.notes.replace",
    requestId: "req-1",
    voiceId: "player-1",
    expectedVoiceVersion: 0,
    notes: [{ pitch: 60 }]
  });

  assert.equal(store.getScore().voices["player-1"].notes[0].pitch, 60);
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack"]);
  assert.equal(client.messages[0].event.sourceClientId, "client-a");
  assert.equal(client.messages[1].requestId, "req-1");
});

test("collaboration rejects stale same-voice edits", () => {
  const { hub, store } = createContext();
  const clientA = createClient("client-a");
  const clientB = createClient("client-b");
  hub.addClient(clientA);
  hub.addClient(clientB);
  clientA.messages.length = 0;
  clientB.messages.length = 0;

  clientA.onMessage({
    type: "voice.notes.replace",
    requestId: "req-a",
    voiceId: "player-1",
    expectedVoiceVersion: 0,
    notes: [{ pitch: 60 }]
  });
  clientB.onMessage({
    type: "voice.notes.replace",
    requestId: "req-b",
    voiceId: "player-1",
    expectedVoiceVersion: 0,
    notes: [{ pitch: 61 }]
  });

  const error = clientB.messages.at(-1);
  assert.equal(error.type, "error");
  assert.match(error.error, /stale voice 'player-1' version 0; current version is 1/);
  assert.equal(store.getScore().voices["player-1"].notes[0].pitch, 60);
});

test("collaboration broadcasts presence updates", () => {
  const { hub } = createContext();
  const clientA = createClient("client-a");
  const clientB = createClient("client-b");
  hub.addClient(clientA);
  hub.addClient(clientB);
  clientA.messages.length = 0;
  clientB.messages.length = 0;

  clientA.onMessage({
    type: "presence.update",
    presence: {
      voiceId: "player-1",
      name: "Ari",
      editing: true
    }
  });

  assert.equal(clientA.messages[0].type, "presence.updated");
  assert.equal(clientB.messages[0].type, "presence.updated");
  assert.equal(clientB.messages[0].client.assignee, "Ari");
  assert.equal(clientB.messages[0].clients.length, 1);
});

test("websocket parser decodes masked client text frames", () => {
  const frame = maskedTextFrame(JSON.stringify({ type: "ping" }));
  const parsed = parseFrame(frame);

  assert.equal(parsed.bytes, frame.length);
  assert.equal(parsed.opcode, 0x1);
  assert.deepEqual(JSON.parse(parsed.payload.toString("utf8")), { type: "ping" });
});

function createContext() {
  const store = createScoreStore(createInitialScore(defaultConfig));
  return {
    hub: createCollaborationHub(store, defaultConfig),
    store
  };
}

function createClient(id) {
  const messages = [];
  return {
    id,
    messages,
    sendJson(message) {
      messages.push(message);
    },
    close() {}
  };
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}
