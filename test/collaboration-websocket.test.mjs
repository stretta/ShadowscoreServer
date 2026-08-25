import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { attachWebSocketCollaboration } from "../src/collaboration/websocket.mjs";
import { defaultConfig } from "../src/config.mjs";
import { attachUnknownWebSocketFallback } from "../src/realtime/upgrade-routing.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("collaboration v1 preserves initial ordering and mutations over fragmented standards frames", async (t) => {
  const context = await createServer();
  t.after(() => context.close());
  const clientA = new WebSocket(context.url("/collab?clientId=client-a"));
  const clientB = new WebSocket(context.url("/collab?clientId=client-b"));
  t.after(() => clientA.close());
  t.after(() => clientB.close());
  const inboxA = createInbox(clientA);
  const inboxB = createInbox(clientB);
  await Promise.all([onceOpen(clientA), onceOpen(clientB)]);

  assert.deepEqual(await initialTypes(inboxA), ["welcome", "snapshot", "presence.list"]);
  assert.deepEqual(await initialTypes(inboxB), ["welcome", "snapshot", "presence.list"]);

  clientA.send(JSON.stringify({ type: "ping", requestId: "ping-1" }));
  assert.equal((await inboxA.next((message) => message.type === "pong")).requestId, "ping-1");

  const mutation = JSON.stringify({
    type: "voice.notes.replace",
    requestId: "fragmented-1",
    voiceId: "player-1",
    expectedVoiceVersion: 0,
    notes: [{ pitch: 72 }]
  });
  const split = Math.floor(mutation.length / 2);
  clientA.send(mutation.slice(0, split), { fin: false });
  clientA.send(mutation.slice(split), { fin: true });

  const changedA = await inboxA.next((message) => message.type === "score.changed");
  const ack = await inboxA.next((message) => message.type === "ack");
  const changedB = await inboxB.next((message) => message.type === "score.changed");
  assert.equal(changedA.event.sourceClientId, "client-a");
  assert.equal(changedB.event.sourceClientId, "client-a");
  assert.equal(ack.requestId, "fragmented-1");
  assert.equal(context.store.getScore().voices["player-1"].notes[0].pitch, 72);
});

test("collaboration v1 keeps presence and deterministically replaces duplicate client IDs", async (t) => {
  const context = await createServer();
  t.after(() => context.close());
  const first = new WebSocket(context.url("/collab?clientId=stable-editor"));
  const observer = new WebSocket(context.url("/collab?clientId=observer"));
  t.after(() => first.close());
  t.after(() => observer.close());
  const firstInbox = createInbox(first);
  const observerInbox = createInbox(observer);
  await Promise.all([onceOpen(first), onceOpen(observer)]);
  await Promise.all([initialTypes(firstInbox), initialTypes(observerInbox)]);

  first.send(JSON.stringify({ type: "presence.update", presence: { name: "Ari", voiceId: "player-1", editing: true } }));
  const presence = await observerInbox.next((message) => message.type === "presence.updated");
  assert.equal(presence.client.clientId, "stable-editor");
  assert.equal(presence.client.assignee, "Ari");

  const firstClosed = onceClose(first);
  const replacement = new WebSocket(context.url("/collab?clientId=stable-editor"));
  t.after(() => replacement.close());
  const replacementInbox = createInbox(replacement);
  await onceOpen(replacement);
  assert.equal((await firstClosed).code, 4001);
  assert.deepEqual(await initialTypes(replacementInbox), ["welcome", "snapshot", "presence.list"]);
  assert.equal(context.collaboration.getClientCount(), 2);
  assert.equal(context.collaboration.getConnectionCount(), 2);
});

test("collaboration v1 applies shared payload, JSON, and heartbeat limits", async (t) => {
  const context = await createServer({
    maxPayloadBytes: 1024,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 250
  });
  t.after(() => context.close());

  const oversized = new WebSocket(context.url("/collab?clientId=oversized"));
  t.after(() => oversized.close());
  await onceOpen(oversized);
  const oversizedClose = onceClose(oversized);
  oversized.send("x".repeat(2048));
  assert.equal((await oversizedClose).code, 1009);

  const malformed = new WebSocket(context.url("/collab?clientId=malformed"));
  t.after(() => malformed.close());
  await onceOpen(malformed);
  const malformedClose = onceClose(malformed);
  malformed.send("{");
  assert.equal((await malformedClose).code, 1007);

  const silent = new WebSocket(context.url("/collab?clientId=silent"), { autoPong: false });
  t.after(() => silent.close());
  await onceOpen(silent);
  const silentClose = onceClose(silent);
  assert.equal((await silentClose).code, 1006);
});

async function createServer(options = {}) {
  const store = createScoreStore(createInitialScore(defaultConfig));
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const collaboration = attachWebSocketCollaboration(server, store, defaultConfig, options);
  const detachFallback = attachUnknownWebSocketFallback(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    collaboration,
    store,
    url: (path) => `ws://127.0.0.1:${address.port}${path}`,
    close() {
      detachFallback();
      collaboration.close();
      server.close();
      server.closeAllConnections?.();
    }
  };
}

async function initialTypes(inbox) {
  return [
    (await inbox.next(() => true)).type,
    (await inbox.next(() => true)).type,
    (await inbox.next(() => true)).type
  ];
}

function createInbox(websocket) {
  const messages = [];
  const waiters = [];
  websocket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  return {
    next(predicate, timeoutMs = 2000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: null };
        const timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          reject(new Error("timed out waiting for collaboration message"));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push(waiter);
      });
    }
  };
}

function onceOpen(websocket) {
  if (websocket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });
}

function onceClose(websocket) {
  return new Promise((resolve) => websocket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}
