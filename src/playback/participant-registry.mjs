const REALTIME_PREFIX = "realtime:";

export function createParticipantRegistry(options = {}) {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? globalThis;
  const refreshIntervalMs = Math.max(250, Number(options.refreshIntervalMs) || 1_000);
  const loadRnboTargets = options.loadRnboTargets;
  const getAssignments = options.getAssignments ?? (() => ({}));
  const participants = new Map();
  const sessions = new Map();
  const subscribers = new Set();
  let refreshTimer;
  let refreshPending;
  let closed = false;

  return {
    async current() {
      await refreshRnboTargets();
      return snapshot();
    },
    subscribe(observer) {
      subscribers.add(observer);
      if (subscribers.size === 1 && typeof loadRnboTargets === "function") {
        refreshTimer = timers.setInterval(() => void refreshRnboTargets().catch(() => {}), refreshIntervalMs);
        refreshTimer?.unref?.();
      }
      return () => {
        subscribers.delete(observer);
        if (!subscribers.size) stopRefreshTimer();
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
    snapshot,
    refreshRnboTargets,
    replaceRnboTargets,
    connectRealtimeSession,
    disconnectRealtimeSession,
    resolveAssignment,
    resolveAssignments,
    close() {
      closed = true;
      stopRefreshTimer();
      subscribers.clear();
      sessions.clear();
      participants.clear();
    }
  };

  async function refreshRnboTargets() {
    if (closed || typeof loadRnboTargets !== "function") return snapshot();
    if (refreshPending) return refreshPending;
    refreshPending = Promise.resolve()
      .then(loadRnboTargets)
      .then((targets) => {
        replaceRnboTargets(targets);
        return snapshot();
      })
      .finally(() => { refreshPending = null; });
    return refreshPending;
  }

  function replaceRnboTargets(targets = []) {
    const observedAt = isoNow();
    const incoming = new Map();
    for (const target of Array.isArray(targets) ? targets : []) {
      const descriptor = rnboDescriptor(target, observedAt, participants.get(targetId(target)));
      if (!descriptor) continue;
      if (incoming.has(descriptor.participant_id)) {
        throw new Error(`duplicate participant identity '${descriptor.participant_id}'`);
      }
      incoming.set(descriptor.participant_id, descriptor);
    }

    for (const [participantId, existing] of participants) {
      if (existing.kind !== "rnbo" || incoming.has(participantId)) continue;
      if (existing.status !== "offline" || existing.available) {
        setParticipant({ ...existing, status: "offline", available: false }, "participant.offline");
      }
    }
    for (const descriptor of incoming.values()) {
      const existing = participants.get(descriptor.participant_id);
      if (!existing) {
        setParticipant(descriptor, "participant.added");
      } else if (!sameDescriptor(existing, descriptor)) {
        setParticipant(descriptor, descriptor.available ? "participant.updated" : "participant.offline");
      }
    }
    return snapshot();
  }

  function connectRealtimeSession(session = {}) {
    const clientId = requiredIdentifier(session.clientId ?? session.client_id, "client_id");
    const connectionId = requiredIdentifier(session.connectionId ?? session.connection_id, "connection_id");
    const participantId = `${REALTIME_PREFIX}${clientId}`;
    const existing = participants.get(participantId);
    const observedAt = isoNow();
    const descriptor = {
      participant_id: participantId,
      stable_device_id: requiredIdentifier(session.stableDeviceId ?? session.stable_device_id ?? clientId, "stable_device_id"),
      kind: "software",
      adapter: "websocket-json",
      status: "online",
      available: true,
      capabilities: {
        protocol_version: Number(session.participantProtocolVersion ?? session.participant_protocol_version) || 1,
        declared: structuredClone(session.declaredCapabilities ?? session.declared_capabilities ?? []),
        granted: structuredClone(session.capabilities ?? [])
      },
      endpoint: {
        protocol: String(session.protocol ?? ""),
        connection_id: connectionId,
        role: String(session.role ?? "observer"),
        topics: [...(session.topics ?? [])],
        display_name: String(session.displayName ?? session.display_name ?? ""),
        runtime: structuredClone(session.runtime ?? {})
      },
      last_seen_at: observedAt,
      expires_at: null
    };
    sessions.set(connectionId, participantId);
    setParticipant(descriptor, existing?.available && existing.endpoint?.connection_id !== connectionId
      ? "participant.endpoint_replaced"
      : existing ? "participant.reconnected" : "participant.added");
    return structuredClone(descriptor);
  }

  function disconnectRealtimeSession(connectionIdValue) {
    const connectionId = String(connectionIdValue ?? "").trim();
    const participantId = sessions.get(connectionId);
    if (!participantId) return false;
    sessions.delete(connectionId);
    const existing = participants.get(participantId);
    if (!existing || existing.endpoint?.connection_id !== connectionId) return false;
    setParticipant({
      ...existing,
      status: "offline",
      available: false,
      endpoint: { ...existing.endpoint, connection_id: null },
      last_seen_at: isoNow()
    }, "participant.offline");
    return true;
  }

  function resolveAssignments(assignments = getAssignments()) {
    return Object.fromEntries(Object.entries(assignments ?? {}).map(([voiceId, assignment]) => [
      voiceId,
      resolveAssignment(assignment, voiceId)
    ]));
  }

  function resolveAssignment(assignment = {}, voiceId = "") {
    const locked = assignment?.locked === true;
    const rnboTargetId = String(assignment?.rnboTargetId ?? "").trim();
    const clientId = String(assignment?.clientId ?? "").trim();
    const deviceId = String(assignment?.deviceId ?? "").trim();
    const exactIds = [rnboTargetId, clientId ? `${REALTIME_PREFIX}${clientId}` : ""].filter(Boolean);
    let offlineExact = null;
    for (const participantId of exactIds) {
      const participant = participants.get(participantId);
      if (participant?.available || (participant && locked)) {
        return resolutionFor(voiceId, assignment, [participant], "exact");
      }
      offlineExact ??= participant ?? null;
    }
    if (locked && exactIds.length) {
      return resolution(voiceId, assignment, "locked-missing", null, exactIds);
    }
    if (!deviceId) {
      if (offlineExact) return resolutionFor(voiceId, assignment, [offlineExact], "exact");
      return exactIds.length
        ? resolution(voiceId, assignment, "missing", null, exactIds)
        : resolution(voiceId, assignment, "unassigned", null, []);
    }
    const allCandidates = [...participants.values()].filter((participant) =>
      participant.stable_device_id === deviceId
    );
    const onlineCandidates = allCandidates.filter((participant) => participant.available);
    const candidates = onlineCandidates.length ? onlineCandidates : allCandidates;
    if (!candidates.length) return resolution(voiceId, assignment, locked ? "locked-missing" : "missing", null, []);
    if (candidates.length > 1) return resolution(voiceId, assignment, "ambiguous", null, candidates.map((entry) => entry.participant_id));
    return resolutionFor(voiceId, assignment, candidates, "stable-device");
  }

  function resolutionFor(voiceId, assignment, candidates, matchedBy) {
    const participant = candidates[0];
    return {
      ...resolution(
        voiceId,
        assignment,
        participant.available ? "resolved" : "offline",
        participant.participant_id,
        candidates.map((entry) => entry.participant_id)
      ),
      matched_by: matchedBy
    };
  }

  function snapshot() {
    return {
      observed_at: isoNow(),
      participants: [...participants.values()]
        .sort((left, right) => left.participant_id.localeCompare(right.participant_id))
        .map((participant) => structuredClone(participant)),
      assignments: resolveAssignments()
    };
  }

  function setParticipant(descriptor, event) {
    participants.set(descriptor.participant_id, descriptor);
    publish(event, descriptor.participant_id);
  }

  function publish(event, participantId) {
    if (!subscribers.size) return;
    const payload = {
      event: {
        type: event,
        participant_id: participantId,
        observed_at: isoNow()
      },
      ...snapshot()
    };
    for (const observer of subscribers) observer({ event, payload });
  }

  function stopRefreshTimer() {
    if (refreshTimer !== undefined) timers.clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }
}

function rnboDescriptor(target, observedAt, existing) {
  const id = targetId(target);
  if (!id) return null;
  const available = target.available !== false;
  const endpoint = structuredClone(target);
  delete endpoint.capabilities;
  return {
    participant_id: id,
    stable_device_id: String(target.hardwareUnitId ?? target.deviceId ?? "").trim(),
    kind: "rnbo",
    adapter: "rnbo-osc",
    status: available ? "online" : "offline",
    available,
    capabilities: structuredClone(target.capabilities ?? {}),
    endpoint,
    last_seen_at: sameEndpoint(existing, endpoint) && existing?.available === available
      ? existing.last_seen_at
      : String(target.lastSeenAt ?? observedAt),
    expires_at: target.expiresAt ?? null
  };
}

function resolution(voiceId, assignment, status, participantId, candidates) {
  return {
    voice_id: String(voiceId ?? ""),
    status,
    participant_id: participantId,
    candidate_participant_ids: [...candidates].sort(),
    locked: assignment?.locked === true
  };
}

function targetId(target) {
  return String(target?.id ?? target?.rnboTargetId ?? target?.address ?? "").trim();
}

function sameDescriptor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEndpoint(existing, endpoint) {
  return existing?.kind === "rnbo" && JSON.stringify(existing.endpoint) === JSON.stringify(endpoint);
}

function requiredIdentifier(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
