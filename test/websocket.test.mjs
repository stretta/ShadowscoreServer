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

test("collaboration can add arbitrary voices", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "voice.add",
    requestId: "req-add",
    voiceId: "player-12",
    assignment: { label: "Player 12" }
  });

  assert.equal(store.getScore().voices["player-12"].version, 0);
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack"]);
  assert.equal(client.messages[1].score.assignments["player-12"].label, "Player 12");
});

test("collaboration can remove voices", () => {
  const { hub, store } = createContext();
  store.addVoice("player-12");
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "voice.remove",
    requestId: "req-remove",
    voiceId: "player-12"
  });

  assert.equal(store.getScore().voices["player-12"], undefined);
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack"]);
});

test("collaboration can edit mesostructural blocks and macrostructure", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "mesostructure.block.replace",
    requestId: "req-block",
    blockId: "G",
    block: {
      duration: { beats: 16 },
      players: {
        "player-1": { clipId: "clip-a" }
      }
    }
  });
  client.onMessage({
    type: "macrostructure.update",
    requestId: "req-macro",
    macrostructure: {
      blocks: ["A", "G", "B"]
    }
  });

  assert.equal(store.getScore().mesostructure.G.duration.beats, 16);
  assert.deepEqual(store.getScore().macrostructure.blocks, ["A", "G", "B"]);
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack", "score.changed", "ack"]);
});

test("collaboration can remove mesostructural blocks", () => {
  const { hub, store } = createContext();
  store.replaceMesoBlock("G", { duration: { bars: 4 }, players: {} });
  store.updateMacrostructure({ blocks: ["A", "G"] });
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "mesostructure.block.remove",
    requestId: "req-remove",
    blockId: "G"
  });

  assert.equal(store.getScore().mesostructure.G, undefined);
  assert.deepEqual(store.getScore().macrostructure.blocks, ["A"]);
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack"]);
});

test("collaboration can update structure playhead", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "structure.playhead.update",
    requestId: "req-playhead",
    structureState: {
      activeBlockId: "C"
    }
  });
  client.onMessage({
    type: "macrostructure.advance",
    requestId: "req-advance"
  });

  assert.equal(store.getScore().structureState.activeBlockId, "D");
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack", "score.changed", "ack"]);
});

test("collaboration can manage clips", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "clip.add",
    requestId: "req-add",
    clipId: "bass-a",
    clip: {
      notes: [{ pitch: 48, start_time: 0, duration: 1, velocity: 100 }],
      playbackType: "one-shot"
    }
  });
  client.onMessage({
    type: "clip.rename",
    requestId: "req-rename",
    clipId: "bass-a",
    newClipId: "bass-main"
  });

  assert.equal(store.getScore().clips["bass-a"], undefined);
  assert.equal(store.getScore().clips["bass-main"].notes[0].pitch, 48);
  assert.equal(store.getScore().clips["bass-main"].playbackType, "one-shot");
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack", "score.changed", "ack"]);
});

test("collaboration can import legacy voice notes into clips", () => {
  const { hub, store } = createContext();
  const client = createClient("client-a");
  store.replaceVoiceNotes("player-1", [{ pitch: 60, start_time: 0, duration: 1, velocity: 100 }]);
  hub.addClient(client);
  client.messages.length = 0;

  client.onMessage({
    type: "admin.importLegacyVoiceNotes",
    requestId: "req-import",
    blockId: "A"
  });

  const score = store.getScore();
  assert.equal(score.clips["player-1-main"].notes[0].pitch, 60);
  assert.equal(score.mesostructure.A.players["player-1"].clipId, "player-1-main");
  assert.deepEqual(client.messages.map((message) => message.type), ["score.changed", "ack"]);
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
