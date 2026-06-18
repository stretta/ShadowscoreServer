import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL_VERSION = "shadowscore.collab.v1";

export function attachWebSocketCollaboration(server, store, config, options = {}) {
  const hub = options.hub ?? createCollaborationHub(store, config);
  const path = options.path ?? "/collab";

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      const key = validateWebSocketRequest(request);
      const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n"));
      hub.addClient(createSocketClient(socket, url));
    } catch (error) {
      socket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\n${messageForError(error)}`);
      socket.destroy();
    }
  });

  return hub;
}

export function createCollaborationHub(store, config = {}) {
  const clients = new Map();

  const onStoreChange = (event) => {
    broadcast({
      type: "score.changed",
      event
    });
  };
  store.events.on("change", onStoreChange);

  function addClient(client) {
    clients.set(client.id, client);
    client.onMessage = (payload) => handleMessage(client, payload);
    client.onClose = () => removeClient(client.id);
    client.sendJson({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      clientId: client.id,
      ensembleId: config.ensemble?.id
    });
    sendSnapshot(client);
    sendPresence(client);
  }

  function removeClient(clientId) {
    const client = clients.get(clientId);
    if (!client) {
      return;
    }
    clients.delete(clientId);
    if (client.presence) {
      broadcastPresence("presence.left", client);
    }
  }

  function handleMessage(client, payload) {
    const requestId = payload?.requestId;
    try {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("message must be a JSON object");
      }

      switch (payload.type) {
        case "ping":
          client.sendJson({ type: "pong", requestId });
          break;
        case "get.score":
          sendSnapshot(client, requestId);
          break;
        case "presence.update":
          client.presence = normalizePresence(payload.presence ?? payload, client.id);
          broadcastPresence("presence.updated", client);
          break;
        case "context.update":
          ack(client, requestId, store.updateContext(payload.context ?? {}, {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            replace: Boolean(payload.replace),
            sourceClientId: client.id
          }));
          break;
        case "voice.add":
          ack(client, requestId, store.addVoice(requireString(payload.voiceId ?? payload.id, "voiceId"), payload.assignment ?? {}, {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            sourceClientId: client.id
          }));
          break;
        case "voice.remove":
          ack(client, requestId, store.removeVoice(requireString(payload.voiceId, "voiceId"), {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            sourceClientId: client.id
          }));
          break;
        case "voice.notes.replace":
          ack(client, requestId, store.replaceVoiceNotes(requireString(payload.voiceId, "voiceId"), notesDocumentFor(payload), {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            expectedVoiceVersion: optionalInteger(payload.expectedVoiceVersion, "expectedVoiceVersion"),
            sourceClientId: client.id
          }));
          break;
        case "voice.assignment.replace":
          ack(client, requestId, store.replaceVoiceAssignment(requireString(payload.voiceId, "voiceId"), payload.assignment ?? {}, {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            sourceClientId: client.id
          }));
          break;
        case "voice.assignment.clear":
          ack(client, requestId, store.clearVoiceAssignment(requireString(payload.voiceId, "voiceId"), {
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            sourceClientId: client.id
          }));
          break;
        case "admin.reset":
          ack(client, requestId, store.reset({
            assignments: Boolean(payload.assignments),
            context: Boolean(payload.context),
            sourceClientId: client.id,
            voices: Boolean(payload.voices)
          }));
          break;
        default:
          throw new Error(`unknown collaboration message type '${payload.type}'`);
      }
    } catch (error) {
      client.sendJson({
        type: "error",
        ok: false,
        requestId,
        error: messageForError(error)
      });
    }
  }

  function sendSnapshot(client, requestId) {
    client.sendJson({
      type: "snapshot",
      requestId,
      score: store.getScore()
    });
  }

  function sendPresence(client, requestId) {
    client.sendJson({
      type: "presence.list",
      requestId,
      clients: [...clients.values()].filter((peer) => peer.presence).map(presenceForClient)
    });
  }

  function broadcastPresence(type, client) {
    broadcast({
      type,
      client: presenceForClient(client),
      clients: [...clients.values()].filter((peer) => peer.presence).map(presenceForClient)
    });
  }

  function broadcast(payload) {
    for (const client of clients.values()) {
      client.sendJson(payload);
    }
  }

  function close() {
    store.events.off("change", onStoreChange);
    for (const client of clients.values()) {
      client.close?.();
    }
    clients.clear();
  }

  return {
    addClient,
    close,
    getClientCount() {
      return clients.size;
    },
    handleMessage
  };
}

function createSocketClient(socket, url) {
  const client = {
    id: url.searchParams.get("clientId") || crypto.randomUUID(),
    socket,
    buffer: Buffer.alloc(0),
    onClose: undefined,
    onMessage: undefined,
    sendJson(payload) {
      if (!socket.destroyed) {
        socket.write(encodeFrame(Buffer.from(JSON.stringify(payload)), 0x1));
      }
    },
    close() {
      if (!socket.destroyed) {
        socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      }
    }
  };

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    try {
      drainFrames(client);
    } catch {
      client.close();
    }
  });
  socket.on("close", () => client.onClose?.());
  socket.on("error", () => client.onClose?.());

  return client;
}

function drainFrames(client) {
  while (client.buffer.length) {
    const parsed = parseFrame(client.buffer);
    if (!parsed) {
      return;
    }
    client.buffer = client.buffer.subarray(parsed.bytes);

    if (parsed.opcode === 0x8) {
      client.close();
      return;
    }
    if (parsed.opcode === 0x9) {
      client.socket.write(encodeFrame(parsed.payload, 0xa));
      continue;
    }
    if (parsed.opcode !== 0x1) {
      continue;
    }
    client.onMessage?.(JSON.parse(parsed.payload.toString("utf8")));
  }
}

function validateWebSocketRequest(request) {
  if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    throw new Error("missing websocket upgrade header");
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    throw new Error("invalid sec-websocket-key");
  }
  return key;
}

export function parseFrame(buffer) {
  if (buffer.length < 2) {
    return undefined;
  }
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) === 0x80;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (!fin) {
    throw new Error("fragmented websocket frames are not supported");
  }
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("websocket frame is too large");
    }
    length = Number(bigLength);
    offset += 8;
  }

  if (!masked) {
    throw new Error("client websocket frames must be masked");
  }
  if (buffer.length < offset + 4 + length) {
    return undefined;
  }

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[offset + index] ^ mask[index % 4];
  }
  return {
    bytes: offset + length,
    opcode,
    payload
  };
}

export function encodeFrame(payload, opcode = 0x1) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function ack(client, requestId, score) {
  client.sendJson({
    type: "ack",
    ok: true,
    requestId,
    score
  });
}

function notesDocumentFor(payload) {
  if (Object.hasOwn(payload, "notes")) {
    return payload.notes;
  }
  if (Object.hasOwn(payload, "document")) {
    return payload.document;
  }
  throw new Error("voice.notes.replace requires notes or document");
}

function normalizePresence(presence, clientId) {
  return {
    clientId,
    voiceId: optionalString(presence.voiceId),
    assignee: optionalString(presence.assignee ?? presence.name),
    deviceId: optionalString(presence.deviceId),
    editing: Boolean(presence.editing)
  };
}

function presenceForClient(client) {
  return {
    ...client.presence,
    clientId: client.id
  };
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function optionalInteger(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
