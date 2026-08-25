const PROTOCOL_VERSION = "shadowscore.collab.v1";

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
            ...revisionOptions(payload),
            replace: Boolean(payload.replace),
            sourceClientId: client.id
          }));
          break;
        case "mesostructure.block.replace":
          ack(client, requestId, store.replaceMesoBlock(requireString(payload.blockId ?? payload.id, "blockId"), payload.block ?? payload.document ?? {}, {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "mesostructure.block.remove":
          ack(client, requestId, store.removeMesoBlock(requireString(payload.blockId ?? payload.id, "blockId"), {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "mesostructure.ttid.update":
          ack(client, requestId, store.updateBlockTtid(
            requireString(payload.blockId, "blockId"),
            payload.ttid ?? payload.value,
            { ...revisionOptions(payload), sourceClientId: client.id }
          ));
          break;
        case "mesostructure.swing.update":
          ack(client, requestId, store.updateBlockSwing(
            requireString(payload.blockId, "blockId"),
            { swing: payload.swing, swingAmt: payload.swingAmt },
            { ...revisionOptions(payload), sourceClientId: client.id }
          ));
          break;
        case "mesostructure.scale.transform":
          ack(client, requestId, store.transformBlockScale(
            requireString(payload.blockId, "blockId"),
            payload.scale ?? {},
            { ...revisionOptions(payload), sourceClientId: client.id }
          ));
          break;
        case "osc.clip.add":
          ack(client, requestId, store.addOscClip(
            requireString(payload.clipId ?? payload.id, "clipId"),
            payload.clip ?? payload.document ?? {},
            {
              ...revisionOptions(payload),
              sourceClientId: client.id
            }
          ));
          break;
        case "osc.clip.replace":
          ack(client, requestId, store.replaceOscClip(
            requireString(payload.clipId ?? payload.id, "clipId"),
            payload.clip ?? payload.document ?? {},
            {
              ...revisionOptions(payload),
              sourceClientId: client.id
            }
          ));
          break;
        case "osc.clip.remove":
          ack(client, requestId, store.removeOscClip(
            requireString(payload.clipId ?? payload.id, "clipId"),
            { ...revisionOptions(payload), sourceClientId: client.id }
          ));
          break;
        case "mesostructure.oscLayer.assign":
          ack(client, requestId, store.assignOscLayer(
            requireString(payload.blockId, "blockId"),
            requireString(payload.roleId, "roleId"),
            requireString(payload.clipId ?? payload.layer?.clipId, "clipId"),
            { ...revisionOptions(payload), sourceClientId: client.id }
          ));
          break;
        case "mesostructure.oscLayer.remove":
          ack(client, requestId, store.removeOscLayer(
            requireString(payload.blockId, "blockId"),
            requireString(payload.roleId, "roleId"),
            {
              ...revisionOptions(payload),
              sourceClientId: client.id
            }
          ));
          break;
        case "macrostructure.update":
          ack(client, requestId, store.updateMacrostructure(payload.macrostructure ?? {}, {
            ...revisionOptions(payload),
            replace: Boolean(payload.replace),
            sourceClientId: client.id
          }));
          break;
        case "structure.playhead.update":
          ack(client, requestId, store.updateStructureState(payload.structureState ?? payload.playhead ?? {}, {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "macrostructure.advance":
          ack(client, requestId, store.advanceStructurePlayhead({
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "macrostructure.reset":
          ack(client, requestId, store.resetStructurePlayhead({
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "clip.add":
          ack(client, requestId, store.addClip(requireString(payload.clipId ?? payload.id, "clipId"), payload.clip ?? payload.document ?? {}, {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "clip.replace":
          ack(client, requestId, store.replaceClip(requireString(payload.clipId ?? payload.id, "clipId"), payload.clip ?? payload.document ?? {}, {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "clip.rename":
          ack(client, requestId, store.renameClip(requireString(payload.clipId ?? payload.oldClipId, "clipId"), requireString(payload.newClipId ?? payload.id, "newClipId"), {
            ...revisionOptions(payload),
            sourceClientId: client.id
          }));
          break;
        case "clip.remove":
          ack(client, requestId, store.removeClip(requireString(payload.clipId ?? payload.id, "clipId"), {
            ...revisionOptions(payload),
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
        case "osc.assignment.replace":
          ack(client, requestId, store.replaceOscAssignment(
            requireString(payload.roleId, "roleId"),
            payload.assignment ?? payload.document ?? {},
            {
              ...revisionOptions(payload),
              sourceClientId: client.id
            }
          ));
          break;
        case "osc.assignment.remove":
          ack(client, requestId, store.removeOscAssignment(
            requireString(payload.roleId, "roleId"),
            {
              ...revisionOptions(payload),
              sourceClientId: client.id
            }
          ));
          break;
        case "admin.reset":
          ack(client, requestId, store.reset({
            assignments: Boolean(payload.assignments),
            oscAssignments: Boolean(payload.oscAssignments),
            context: Boolean(payload.context),
            structure: Boolean(payload.structure),
            sourceClientId: client.id,
            voices: Boolean(payload.voices)
          }));
          break;
        case "admin.importLegacyVoiceNotes":
          ack(client, requestId, store.importLegacyVoiceNotes({
            blockId: payload.blockId,
            suffix: payload.suffix,
            overwriteClips: Boolean(payload.overwriteClips),
            includeEmpty: Boolean(payload.includeEmpty),
            expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
            sourceClientId: client.id
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

function revisionOptions(payload) {
  return {
    expectedVersion: optionalInteger(payload.expectedVersion, "expectedVersion"),
    expectedScoreRevision: optionalInteger(payload.expectedScoreRevision, "expectedScoreRevision"),
    expectedStructureRevision: optionalInteger(payload.expectedStructureRevision, "expectedStructureRevision")
  };
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
