import crypto from "node:crypto";
import { attachWebSocketEndpoint } from "./websocket-endpoint.mjs";

export { createOutboundQueue } from "./websocket-endpoint.mjs";

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
  const endpoint = attachWebSocketEndpoint(server, {
    ...options,
    path,
    protocol: REALTIME_PROTOCOL,
    requireProtocol: true,
    messageMode: "raw",
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    onConnection: addSession
  });

  return {
    close() {
      for (const session of sessions.values()) closeSession(session, 1001, "server shutdown");
      sessions.clear();
      sessionsByClientId.clear();
      endpoint.close();
    },
    getSessionCount() {
      return sessions.size;
    },
    path,
    protocol: REALTIME_PROTOCOL
  };

  function addSession(connection) {
    const connectionId = connection.id;
    const session = {
      connectionId,
      clientId: null,
      role: null,
      connection,
      outbound: connection.outbound,
      subscriptions: new Map(),
      requestCache: new Map(),
      initialized: false,
      closed: false
    };
    sessions.set(connectionId, session);
    session.helloTimer = timers.setTimeout(() => {
      if (!session.initialized) closeSession(session, 1008, "hello timeout");
    }, helloTimeoutMs);
    session.helloTimer?.unref?.();

    connection.onMessage = (data, isBinary) => handleMessage(session, data, isBinary);
    connection.onClose = () => removeSession(session);

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
    session.connection.close(code, reason);
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
