import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { markWebSocketUpgradeHandled } from "./upgrade-routing.mjs";

export function attachWebSocketEndpoint(server, options = {}) {
  const path = options.path;
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("WebSocket endpoint path is required");
  const protocol = options.protocol ?? "";
  const now = options.now ?? Date.now;
  const timers = options.timers ?? globalThis;
  const heartbeatIntervalMs = Math.max(250, Number(options.heartbeatIntervalMs) || 15_000);
  const heartbeatTimeoutMs = Math.max(heartbeatIntervalMs, Number(options.heartbeatTimeoutMs) || 45_000);
  const connections = new Map();
  const serverOptions = {
    noServer: true,
    maxPayload: Math.max(1024, Number(options.maxPayloadBytes) || 256 * 1024),
    maxBufferedChunks: Math.max(8, Number(options.maxBufferedChunks) || 64),
    maxFragments: Math.max(8, Number(options.maxFragments) || 64),
    perMessageDeflate: false
  };
  if (protocol) {
    serverOptions.handleProtocols = (protocols) => protocols.has(protocol) ? protocol : false;
  }
  const wss = new WebSocketServer(serverOptions);

  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== path) return;
    markWebSocketUpgradeHandled(request);
    if (protocol && options.requireProtocol !== false) {
      const requested = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
      if (!requested.includes(protocol)) {
        socket.write(`HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Protocol: ${protocol}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
  };
  server.on("upgrade", onUpgrade);
  wss.on("connection", (websocket, request) => addConnection(websocket, request));

  const heartbeatTimer = timers.setInterval(() => {
    const timestamp = now();
    for (const connection of connections.values()) {
      if (timestamp - connection.lastPongAt > heartbeatTimeoutMs) {
        connection.terminate();
      } else if (connection.websocket.readyState === WebSocket.OPEN) {
        connection.websocket.ping();
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer?.unref?.();

  return {
    close() {
      timers.clearInterval(heartbeatTimer);
      server.off("upgrade", onUpgrade);
      for (const connection of [...connections.values()]) connection.close(1001, "server shutdown");
      connections.clear();
      wss.close();
    },
    getConnectionCount() {
      return connections.size;
    },
    path,
    protocol,
    heartbeatIntervalMs,
    heartbeatTimeoutMs
  };

  function addConnection(websocket, request) {
    const connection = {
      id: crypto.randomUUID(),
      websocket,
      request,
      outbound: createOutboundQueue(websocket, options),
      lastPongAt: now(),
      closed: false,
      messageTail: Promise.resolve(),
      onMessage: null,
      onClose: null,
      sendJson(payload, queueOptions) {
        return connection.outbound.enqueue(JSON.stringify(payload), queueOptions);
      },
      close(code = 1000, reason = "") {
        if (connection.closed) return;
        removeConnection(connection);
        if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
          websocket.close(code, reason);
        }
      },
      terminate() {
        if (connection.closed) return;
        removeConnection(connection);
        websocket.terminate();
      }
    };
    connections.set(connection.id, connection);
    websocket.on("pong", () => { connection.lastPongAt = now(); });
    websocket.on("message", (data, isBinary) => {
      connection.lastPongAt = now();
      connection.messageTail = connection.messageTail
        .then(() => deliverMessage(connection, data, isBinary))
        .catch(() => connection.close(1007, "invalid message"));
    });
    websocket.on("close", () => removeConnection(connection));
    websocket.on("error", () => removeConnection(connection));
    options.onConnection?.(connection, request);
  }

  async function deliverMessage(connection, data, isBinary) {
    if (options.messageMode === "raw") {
      await connection.onMessage?.(data, isBinary);
      return;
    }
    if (isBinary) {
      connection.close(1003, "binary messages are not supported");
      return;
    }
    const payload = JSON.parse(data.toString("utf8"));
    await connection.onMessage?.(payload);
  }

  function removeConnection(connection) {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection.id);
    connection.onClose?.();
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
