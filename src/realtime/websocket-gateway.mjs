import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { markWebSocketUpgradeHandled } from "./upgrade-routing.mjs";

export const REALTIME_PROTOCOL = "shadowscore.realtime.v2";

export function attachRealtimeGateway(server, broker, options = {}) {
  const path = options.path ?? "/realtime";
  const now = options.now ?? Date.now;
  const timers = options.timers ?? globalThis;
  const heartbeatIntervalMs = Math.max(250, Number(options.heartbeatIntervalMs) || 15_000);
  const heartbeatTimeoutMs = Math.max(heartbeatIntervalMs, Number(options.heartbeatTimeoutMs) || 45_000);
  const helloTimeoutMs = Math.max(250, Number(options.helloTimeoutMs) || 5_000);
  const sessions = new Map();
  const sessionsByClientId = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(1024, Number(options.maxPayloadBytes) || 256 * 1024),
    maxBufferedChunks: Math.max(8, Number(options.maxBufferedChunks) || 64),
    maxFragments: Math.max(8, Number(options.maxFragments) || 64),
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false;
    }
  });

  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== path) return;
    markWebSocketUpgradeHandled(request);
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!protocols.includes(REALTIME_PROTOCOL)) {
      socket.write(`HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Protocol: ${REALTIME_PROTOCOL}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  };
  server.on("upgrade", onUpgrade);
  wss.on("connection", (websocket) => addSession(websocket));

  const heartbeatTimer = timers.setInterval(() => {
    const timestamp = now();
    for (const session of sessions.values()) {
      if (timestamp - session.lastPongAt > heartbeatTimeoutMs) {
        session.websocket.terminate();
      } else if (session.websocket.readyState === WebSocket.OPEN) {
        session.websocket.ping();
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer?.unref?.();

  return {
    close() {
      timers.clearInterval(heartbeatTimer);
      server.off("upgrade", onUpgrade);
      for (const session of sessions.values()) closeSession(session, 1001, "server shutdown");
      sessions.clear();
      sessionsByClientId.clear();
      wss.close();
    },
    getSessionCount() {
      return sessions.size;
    },
    path,
    protocol: REALTIME_PROTOCOL
  };

  function addSession(websocket) {
    const connectionId = crypto.randomUUID();
    const session = {
      connectionId,
      clientId: null,
      role: null,
      websocket,
      outbound: createOutboundQueue(websocket, options),
      subscriptions: new Map(),
      requestCache: new Map(),
      lastPongAt: now(),
      initialized: false,
      closed: false,
      messageTail: Promise.resolve()
    };
    sessions.set(connectionId, session);
    session.helloTimer = timers.setTimeout(() => {
      if (!session.initialized) closeSession(session, 1008, "hello timeout");
    }, helloTimeoutMs);
    session.helloTimer?.unref?.();

    websocket.on("pong", () => { session.lastPongAt = now(); });
    websocket.on("message", (data, isBinary) => {
      session.lastPongAt = now();
      session.messageTail = session.messageTail
        .then(() => handleMessage(session, data, isBinary))
        .catch((error) => sendError(session, null, error));
    });
    websocket.on("close", () => removeSession(session));
    websocket.on("error", () => removeSession(session));

    send(session, {
      type: "hello.required",
      connection_id: connectionId,
      payload: {
        protocol: REALTIME_PROTOCOL,
        hello_timeout_ms: helloTimeoutMs,
        available_topics: broker.topics("observer")
      }
    });
  }

  async function handleMessage(session, data, isBinary) {
    if (isBinary) {
      closeSession(session, 1003, "binary messages are not supported");
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      throw protocolError("invalid_json", "message must be valid JSON");
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw protocolError("invalid_message", "message must be a JSON object");
    }
    try {
      if (!session.initialized) {
        await acceptHello(session, message);
        return;
      }
      await executeRequest(session, message);
    } catch (error) {
      sendError(session, optionalRequestId(message.request_id), error);
    }
  }

  async function acceptHello(session, message) {
    if (message.protocol !== REALTIME_PROTOCOL || message.type !== "hello") {
      throw protocolError("hello_required", `first message must be a '${REALTIME_PROTOCOL}' hello`);
    }
    if (message.role !== undefined && message.role !== "observer") {
      throw protocolError("role_forbidden", `role '${message.role}' is not available`);
    }
    const requestedClientId = optionalClientId(message.client_id);
    session.clientId = requestedClientId || `client-${crypto.randomUUID()}`;
    session.role = "observer";
    const previous = sessionsByClientId.get(session.clientId);
    if (previous && previous !== session) closeSession(previous, 4001, "replaced by newer connection");
    sessionsByClientId.set(session.clientId, session);
    session.initialized = true;
    timers.clearTimeout(session.helloTimer);

    const requestedTopics = normalizeTopics(message.topics ?? []);
    const acceptedTopics = validateTopics(requestedTopics, session.role);
    send(session, {
      type: "welcome",
      request_id: optionalRequestId(message.request_id),
      payload: {
        connection_id: session.connectionId,
        session_id: session.connectionId,
        client_id: session.clientId,
        role: session.role,
        capabilities: ["topics:read"],
        heartbeat_interval_ms: heartbeatIntervalMs,
        heartbeat_timeout_ms: heartbeatTimeoutMs,
        topics: acceptedTopics
      }
    });
    await subscribeTopics(session, acceptedTopics);
  }

  async function executeRequest(session, message) {
    if (message.protocol !== undefined && message.protocol !== REALTIME_PROTOCOL) {
      throw protocolError("protocol_mismatch", `expected protocol '${REALTIME_PROTOCOL}'`);
    }
    const requestId = requiredRequestId(message.request_id);
    const fingerprint = JSON.stringify(message);
    const cached = session.requestCache.get(requestId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw protocolError("request_id_reused", `request_id '${requestId}' was reused with different content`);
      }
      session.outbound.enqueue(cached.serialized, { critical: true });
      return;
    }

    try {
      let payload;
      switch (message.type) {
        case "subscribe": {
          const topics = validateTopics(normalizeTopics(message.topics), session.role);
          await subscribeTopics(session, topics);
          payload = { subscribed: [...session.subscriptions.keys()] };
          break;
        }
        case "unsubscribe": {
          const topics = normalizeTopics(message.topics);
          for (const topic of topics) unsubscribeTopic(session, topic);
          payload = { subscribed: [...session.subscriptions.keys()] };
          break;
        }
        case "ping":
          payload = { pong: true };
          break;
        default:
          throw protocolError("read_only_gateway", `message type '${message.type}' is not available on the read-only gateway`);
      }
      cacheAndSend(session, requestId, fingerprint, envelopeFor(session, { type: "result", request_id: requestId, payload }));
    } catch (error) {
      cacheAndSend(session, requestId, fingerprint, envelopeFor(session, {
        type: "error",
        request_id: requestId,
        payload: errorPayload(error)
      }));
    }
  }

  async function subscribeTopics(session, topics) {
    for (const topic of topics) {
      if (session.subscriptions.has(topic)) continue;
      const state = { ready: false, buffered: [], unsubscribe: null };
      state.unsubscribe = broker.subscribe(topic, session.role, (message) => {
        if (!state.ready) {
          state.buffered.push(message);
          return;
        }
        sendTopicMessage(session, message);
      });
      session.subscriptions.set(topic, state);
      try {
        const snapshot = await broker.current(topic, session.role);
        sendTopicMessage(session, snapshot);
        state.ready = true;
        for (const message of state.buffered) {
          if (message.sequence > snapshot.sequence) sendTopicMessage(session, message);
        }
        state.buffered.length = 0;
      } catch (error) {
        unsubscribeTopic(session, topic);
        throw error;
      }
    }
  }

  function sendTopicMessage(session, message) {
    send(session, {
      type: message.eventType === "snapshot" ? "snapshot" : "event",
      topic: message.topic,
      sequence: message.sequence,
      payload: {
        topic_version: message.topicVersion,
        event_type: message.eventType,
        value: message.payload
      }
    }, { replaceKey: `${message.topic}:latest` });
  }

  function validateTopics(topics, role) {
    const allowed = new Set(broker.topics(role).map((entry) => entry.name));
    for (const topic of topics) {
      if (!allowed.has(topic)) throw protocolError("unknown_topic", `unknown or unavailable realtime topic '${topic}'`);
    }
    return topics;
  }

  function unsubscribeTopic(session, topic) {
    const state = session.subscriptions.get(topic);
    if (!state) return;
    state.unsubscribe?.();
    session.subscriptions.delete(topic);
  }

  function send(session, fields, queueOptions = {}) {
    return session.outbound.enqueue(JSON.stringify(envelopeFor(session, fields)), queueOptions);
  }

  function sendError(session, requestId, error) {
    if (session.closed) return;
    send(session, { type: "error", request_id: requestId, payload: errorPayload(error) }, { critical: true });
  }

  function cacheAndSend(session, requestId, fingerprint, envelope) {
    const serialized = JSON.stringify(envelope);
    session.requestCache.set(requestId, { fingerprint, serialized });
    while (session.requestCache.size > 128) session.requestCache.delete(session.requestCache.keys().next().value);
    session.outbound.enqueue(serialized, { critical: true });
  }

  function envelopeFor(session, fields) {
    return {
      protocol: REALTIME_PROTOCOL,
      type: fields.type,
      topic: fields.topic ?? null,
      request_id: fields.request_id ?? null,
      client_id: session.clientId,
      connection_id: session.connectionId,
      sequence: fields.sequence ?? null,
      observed_at: new Date(now()).toISOString(),
      payload: fields.payload ?? {}
    };
  }

  function removeSession(session) {
    if (session.closed) return;
    session.closed = true;
    timers.clearTimeout(session.helloTimer);
    for (const topic of [...session.subscriptions.keys()]) unsubscribeTopic(session, topic);
    sessions.delete(session.connectionId);
    if (sessionsByClientId.get(session.clientId) === session) sessionsByClientId.delete(session.clientId);
  }

  function closeSession(session, code, reason) {
    if (session.closed) return;
    removeSession(session);
    if (session.websocket.readyState === WebSocket.OPEN || session.websocket.readyState === WebSocket.CONNECTING) {
      session.websocket.close(code, reason);
    }
  }
}

export function createOutboundQueue(websocket, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxOutboundBytes) || 1024 * 1024);
  const maxMessages = Math.max(4, Number(options.maxOutboundMessages) || 64);
  const queue = [];
  let queueBytes = 0;
  let inFlightBytes = 0;
  let sending = false;
  let closed = false;

  return {
    enqueue(serialized, itemOptions = {}) {
      if (closed || websocket.readyState !== WebSocket.OPEN) return false;
      const bytes = Buffer.byteLength(serialized);
      const replaceKey = itemOptions.replaceKey;
      if (replaceKey) {
        const existing = queue.findIndex((item) => item.replaceKey === replaceKey);
        if (existing >= 0) {
          queueBytes -= queue[existing].bytes;
          queue.splice(existing, 1);
        }
      }
      while ((queue.length >= maxMessages || totalBytes() + bytes > maxBytes) && dropOldestReplaceable()) {}
      if (queue.length >= maxMessages || totalBytes() + bytes > maxBytes) {
        closed = true;
        websocket.close(1009, "outbound queue exceeded");
        return false;
      }
      queue.push({ serialized, bytes, replaceKey, critical: itemOptions.critical === true });
      queueBytes += bytes;
      pump();
      return true;
    },
    snapshot() {
      return { messages: queue.length, bytes: queueBytes, inFlightBytes, sending, closed };
    }
  };

  function totalBytes() {
    return queueBytes + inFlightBytes + Math.max(0, Number(websocket.bufferedAmount) || 0);
  }

  function dropOldestReplaceable() {
    const index = queue.findIndex((item) => item.replaceKey && !item.critical);
    if (index < 0) return false;
    queueBytes -= queue[index].bytes;
    queue.splice(index, 1);
    return true;
  }

  function pump() {
    if (sending || !queue.length || closed) return;
    const item = queue.shift();
    queueBytes -= item.bytes;
    inFlightBytes = item.bytes;
    sending = true;
    websocket.send(item.serialized, (error) => {
      sending = false;
      inFlightBytes = 0;
      if (error) {
        closed = true;
        websocket.close(1011, "outbound send failed");
        return;
      }
      pump();
    });
  }
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) throw protocolError("invalid_topics", "topics must be an array");
  return [...new Set(value.map((topic) => {
    if (typeof topic !== "string" || !topic.trim()) throw protocolError("invalid_topics", "topic names must be non-empty strings");
    return topic.trim();
  }))];
}

function optionalClientId(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw protocolError("invalid_client_id", "client_id must contain 1-128 safe identifier characters");
  }
  return value;
}

function optionalRequestId(value) {
  return value === undefined || value === null ? null : String(value);
}

function requiredRequestId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw protocolError("invalid_request_id", "request_id must be a non-empty string of at most 128 characters");
  }
  return value;
}

function errorPayload(error) {
  return {
    code: error?.code ?? "internal_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
