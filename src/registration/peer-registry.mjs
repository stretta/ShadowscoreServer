import os from "node:os";

export function createPeerRegistry(config, options = {}) {
  const units = new Map();
  const now = options.now ?? (() => Date.now());
  const heartbeatTtlMs = clampMs(config.registration?.heartbeatTtlMs, 30000, 5000, 3600000);

  return {
    heartbeatTtlMs,
    register(document, metadata = {}) {
      const unit = normalizeUnit(document, config, metadata, now());
      units.set(unit.id, unit);
      return structuredClone(unit);
    },
    heartbeat(unitId, metadata = {}) {
      const id = stringField(unitId);
      const existing = units.get(id);
      if (!existing) {
        throw new Error(`unknown hardware unit '${id}'`);
      }
      const timestamp = now();
      const unit = {
        ...existing,
        status: "online",
        available: true,
        remoteAddress: metadata.remoteAddress ?? existing.remoteAddress,
        lastSeenAt: new Date(timestamp).toISOString(),
        expiresAt: new Date(timestamp + heartbeatTtlMs).toISOString()
      };
      units.set(id, unit);
      return structuredClone(unit);
    },
    snapshot() {
      expireOffline(now());
      return Array.from(units.values()).map((unit) => structuredClone(unit));
    },
    targets() {
      return this.snapshot().flatMap((unit) =>
        unit.targets.map((target) => ({
          ...target,
          hardwareUnitId: unit.id,
          hardwareUnitName: unit.advertisedName || unit.id,
          available: unit.available && target.available !== false,
          unitStatus: unit.status
        }))
      );
    },
    expireOffline,
    clear() {
      units.clear();
    }
  };

  function expireOffline(timestamp) {
    for (const [id, unit] of units.entries()) {
      const expires = Date.parse(unit.expiresAt);
      if (Number.isFinite(expires) && expires <= timestamp && unit.status !== "offline") {
        units.set(id, {
          ...unit,
          status: "offline",
          available: false,
          targets: unit.targets.map((target) => ({ ...target, available: false }))
        });
      }
    }
    return Array.from(units.values()).map((unit) => structuredClone(unit));
  }
}

export function createLocalHardwareUnit(config, targets = []) {
  const id = config.server?.hostIdentity || os.hostname();
  return {
    id,
    role: config.server?.role ?? "host",
    advertisedName: config.server?.advertisedName || id,
    hostIdentity: config.server?.hostIdentity || id,
    status: "online",
    available: true,
    local: true,
    registeredAt: null,
    lastSeenAt: null,
    expiresAt: null,
    targets: targets.map((target) => ({
      ...target,
      hardwareUnitId: id,
      hardwareUnitName: config.server?.advertisedName || id,
      available: target.available !== false,
      unitStatus: "online"
    }))
  };
}

function normalizeUnit(document, config, metadata, timestamp) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("registration body must be an object");
  }

  const id = stringField(document.id ?? document.hardwareUnitId ?? document.hostIdentity);
  if (!id) {
    throw new Error("registration body must include id, hardwareUnitId, or hostIdentity");
  }

  const registeredAt = new Date(timestamp).toISOString();
  const ttlMs = clampMs(document.heartbeatTtlMs ?? config.registration?.heartbeatTtlMs, 30000, 5000, 3600000);
  const advertisedName = stringField(document.advertisedName ?? document.name) || id;
  const hostIdentity = stringField(document.hostIdentity) || id;

  return {
    id,
    role: stringField(document.role) || "peer",
    advertisedName,
    hostIdentity,
    sessionHostUrl: stringField(document.sessionHostUrl),
    status: "online",
    available: true,
    local: false,
    remoteAddress: metadata.remoteAddress ?? "",
    registeredAt,
    lastSeenAt: registeredAt,
    expiresAt: new Date(timestamp + ttlMs).toISOString(),
    heartbeatTtlMs: ttlMs,
    targets: normalizeTargets(document.targets, id, advertisedName)
  };
}

function normalizeTargets(targets, hardwareUnitId, hardwareUnitName) {
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets.map((target, index) => {
    const address = stringField(target.address ?? target.messagePath);
    const rawId = stringField(target.id) || `target-${index + 1}`;
    const id = rawId.startsWith(`${hardwareUnitId}:`) ? rawId : `${hardwareUnitId}:${rawId}`;
    return {
      id,
      localId: rawId,
      name: stringField(target.name) || address || id,
      host: stringField(target.host),
      port: nullableNumberField(target.port),
      address,
      instanceId: stringField(target.instanceId),
      messagePath: stringField(target.messagePath) || address,
      voiceId: stringField(target.voiceId) || undefined,
      clientId: target.clientId === undefined ? undefined : nullableStringField(target.clientId),
      source: stringField(target.source) || "registration",
      hardwareUnitId,
      hardwareUnitName,
      available: target.available !== false
    };
  });
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nullableStringField(value) {
  const stringValue = stringField(value);
  return stringValue ? stringValue : null;
}

function nullableNumberField(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("target port must be a finite number");
  }
  return number;
}

function clampMs(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}
