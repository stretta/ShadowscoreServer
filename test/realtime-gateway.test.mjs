import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { attachWebSocketCollaboration } from "../src/collaboration/websocket.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createEventPublisher, createLoadedPublisher } from "../src/realtime/publisher.mjs";
import { createRealtimeTopicBroker } from "../src/realtime/topic-broker.mjs";
import { attachUnknownWebSocketFallback } from "../src/realtime/upgrade-routing.mjs";
import { attachRealtimeGateway, createOutboundQueue, REALTIME_PROTOCOL } from "../src/realtime/websocket-gateway.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("realtime topic broker sequences shared upstream events and enforces roles", async () => {
  const events = new EventEmitter();
  const publisher = createEventPublisher({
    loadSnapshot: () => ({ revision: 1 }),
    events,
    sourceEvent: "change",
    mapEvent: (payload) => ({ event: "changed", payload })
  });
  const broker = createRealtimeTopicBroker({
    score: { publisher, version: 1, roles: ["observer"] }
  });
  const one = [];
  const two = [];
  const unsubscribeOne = broker.subscribe("score", "observer", (message) => one.push(message));
  const unsubscribeTwo = broker.subscribe("score", "observer", (message) => two.push(message));

  assert.equal(events.listenerCount("change"), 1);
  assert.deepEqual(await broker.current("score", "observer"), {
    topic: "score", topicVersion: 1, sequence: 0, eventType: "snapshot", payload: { revision: 1 }
  });
  events.emit("change", { revision: 2 });
  assert.equal(one[0].sequence, 1);
  assert.deepEqual(two, one);
  assert.throws(() => broker.subscribe("score", "playback", () => {}), /cannot subscribe/);

  unsubscribeOne();
  unsubscribeTwo();
  assert.equal(events.listenerCount("change"), 0);
  broker.close();
});

test("realtime gateway negotiates v2, correlates requests, and streams read-only topics", async (t) => {
  const context = await createGatewayServer();
  t.after(() => context.close());
  const client = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  t.after(() => client.close());
  const inbox = createInbox(client);

  await onceOpen(client);
  const required = await inbox.next((message) => message.type === "hello.required");
  assert.equal(required.protocol, REALTIME_PROTOCOL);
  assert.deepEqual(required.payload.available_topics.map((topic) => topic.name), ["score", "transport"]);

  client.send(JSON.stringify({
    protocol: REALTIME_PROTOCOL,
    type: "hello",
    request_id: "hello-1",
    client_id: "m4l-test",
    role: "observer",
    topics: ["score"]
  }));
  const welcome = await inbox.next((message) => message.type === "welcome");
  assert.equal(welcome.client_id, "m4l-test");
  assert.deepEqual(welcome.payload.capabilities, ["topics:read"]);
  const snapshot = await inbox.next((message) => message.type === "snapshot" && message.topic === "score");
  assert.equal(snapshot.sequence, 0);
  assert.equal(snapshot.payload.value.revision, 1);

  context.scoreEvents.emit("change", { revision: 2 });
  const changed = await inbox.next((message) => message.type === "event" && message.topic === "score");
  assert.equal(changed.sequence, 1);
  assert.equal(changed.payload.event_type, "changed");

  const subscribe = {
    protocol: REALTIME_PROTOCOL,
    type: "subscribe",
    request_id: "subscribe-1",
    topics: ["transport"]
  };
  client.send(JSON.stringify(subscribe));
  const transport = await inbox.next((message) => message.type === "snapshot" && message.topic === "transport");
  assert.equal(transport.payload.value.rolling, false);
  const result = await inbox.next((message) => message.type === "result" && message.request_id === "subscribe-1");
  assert.deepEqual(result.payload.subscribed, ["score", "transport"]);

  client.send(JSON.stringify(subscribe));
  const replay = await inbox.next((message) => message.type === "result" && message.request_id === "subscribe-1");
  assert.deepEqual(replay, result);

  client.send(JSON.stringify({ ...subscribe, topics: ["score"] }));
  const reused = await inbox.next((message) => message.type === "error" && message.request_id === "subscribe-1");
  assert.equal(reused.payload.code, "request_id_reused");

  client.send(JSON.stringify({ type: "transport.play", request_id: "write-1" }));
  const denied = await inbox.next((message) => message.type === "error" && message.request_id === "write-1");
  assert.equal(denied.payload.code, "read_only_gateway");
});

test("realtime gateway replaces duplicate stable client identities", async (t) => {
  const context = await createGatewayServer();
  t.after(() => context.close());
  const first = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  const second = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  t.after(() => first.close());
  t.after(() => second.close());
  const firstInbox = createInbox(first);
  const secondInbox = createInbox(second);
  await Promise.all([onceOpen(first), onceOpen(second)]);
  await Promise.all([
    firstInbox.next((message) => message.type === "hello.required"),
    secondInbox.next((message) => message.type === "hello.required")
  ]);

  first.send(JSON.stringify({ protocol: REALTIME_PROTOCOL, type: "hello", client_id: "stable", topics: [] }));
  await firstInbox.next((message) => message.type === "welcome");
  const firstClosed = onceClose(first);
  second.send(JSON.stringify({ protocol: REALTIME_PROTOCOL, type: "hello", client_id: "stable", topics: [] }));
  await secondInbox.next((message) => message.type === "welcome");
  const closed = await firstClosed;
  assert.equal(closed.code, 4001);
  assert.equal(context.gateway.getSessionCount(), 1);
});

test("realtime and collaboration WebSockets coexist and unknown upgrades retain 404", async (t) => {
  const context = await createGatewayServer({ collaboration: true });
  t.after(() => context.close());
  const realtime = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  const collaboration = connect(context.url("/collab"));
  t.after(() => realtime.close());
  t.after(() => collaboration.close());
  const realtimeInbox = createInbox(realtime);
  const collaborationInbox = createInbox(collaboration);
  await Promise.all([onceOpen(realtime), onceOpen(collaboration)]);
  assert.equal((await realtimeInbox.next((message) => message.type === "hello.required")).protocol, REALTIME_PROTOCOL);
  assert.deepEqual((await collaborationInbox.next(() => true)).type, "welcome");

  const unknownStatus = await unexpectedStatus(connect(context.url("/unknown")));
  assert.equal(unknownStatus, 404);
});

test("realtime gateway rejects missing protocols and oversized messages", async (t) => {
  const context = await createGatewayServer({ maxPayloadBytes: 1024 });
  t.after(() => context.close());
  assert.equal(await unexpectedStatus(connect(context.url("/realtime"))), 426);

  const client = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  t.after(() => client.close());
  await onceOpen(client);
  const closed = onceClose(client);
  client.send("x".repeat(2048));
  assert.equal((await closed).code, 1009);
});

test("realtime gateway evicts a client that does not answer heartbeat pings", async (t) => {
  const context = await createGatewayServer({ heartbeatIntervalMs: 250, heartbeatTimeoutMs: 250 });
  t.after(() => context.close());
  const client = new WebSocket(context.url("/realtime"), REALTIME_PROTOCOL, { autoPong: false });
  t.after(() => client.close());
  const inbox = createInbox(client);
  await onceOpen(client);
  await inbox.next((message) => message.type === "hello.required");
  client.send(JSON.stringify({ protocol: REALTIME_PROTOCOL, type: "hello", client_id: "silent", topics: [] }));
  await inbox.next((message) => message.type === "welcome");
  assert.equal((await onceClose(client)).code, 1006);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.gateway.getSessionCount(), 0);
});

test("realtime gateway closes connections that miss the hello deadline", async (t) => {
  const context = await createGatewayServer({ helloTimeoutMs: 250 });
  t.after(() => context.close());
  const client = connect(context.url("/realtime"), REALTIME_PROTOCOL);
  t.after(() => client.close());
  const inbox = createInbox(client);
  await onceOpen(client);
  await inbox.next((message) => message.type === "hello.required");
  const closed = await onceClose(client);
  assert.equal(closed.code, 1008);
  assert.equal(closed.reason, "hello timeout");
});

test("outbound queue coalesces snapshots and closes instead of growing without bound", () => {
  const callbacks = [];
  const closes = [];
  const websocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(_message, callback) { callbacks.push(callback); },
    close(code, reason) { closes.push({ code, reason }); }
  };
  const queue = createOutboundQueue(websocket, { maxOutboundBytes: 1024, maxOutboundMessages: 4 });

  queue.enqueue("a".repeat(300), { replaceKey: "score" });
  queue.enqueue("b".repeat(300), { replaceKey: "score" });
  queue.enqueue("c".repeat(300), { replaceKey: "score" });
  assert.equal(queue.snapshot().messages, 1);
  queue.enqueue("d".repeat(300), { critical: true });
  queue.enqueue("e".repeat(300), { critical: true });
  queue.enqueue("f".repeat(300), { critical: true });
  assert.deepEqual(closes, [{ code: 1009, reason: "outbound queue exceeded" }]);
  callbacks[0]();
});

async function createGatewayServer(options = {}) {
  const scoreEvents = new EventEmitter();
  const scorePublisher = createEventPublisher({
    loadSnapshot: () => ({ revision: 1 }),
    events: scoreEvents,
    sourceEvent: "change",
    mapEvent: (payload) => ({ event: "changed", payload })
  });
  const transportPublisher = createLoadedPublisher(() => ({ rolling: false }), { intervalMs: 500 });
  const broker = createRealtimeTopicBroker({
    score: { publisher: scorePublisher, roles: ["observer"] },
    transport: { publisher: transportPublisher, roles: ["observer"] }
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const gateway = attachRealtimeGateway(server, broker, options);
  let collaboration;
  if (options.collaboration) {
    const store = createScoreStore(createInitialScore(defaultConfig));
    collaboration = attachWebSocketCollaboration(server, store, defaultConfig);
  }
  const detachFallback = attachUnknownWebSocketFallback(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    gateway,
    scoreEvents,
    url: (path) => `ws://127.0.0.1:${address.port}${path}`,
    close() {
      detachFallback();
      collaboration?.close();
      gateway.close();
      broker.close();
      scorePublisher.close();
      transportPublisher.close();
      server.close();
      server.closeAllConnections?.();
    }
  };
}

function connect(url, protocol) {
  return protocol ? new WebSocket(url, protocol) : new WebSocket(url);
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
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          reject(new Error("timed out waiting for WebSocket message"));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
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

function unexpectedStatus(websocket) {
  return new Promise((resolve, reject) => {
    websocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    websocket.once("open", () => reject(new Error("WebSocket unexpectedly opened")));
    websocket.once("error", () => {});
  });
}
