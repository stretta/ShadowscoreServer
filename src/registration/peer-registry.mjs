import os from "node:os";
import net from "node:net";
import { legacyRnboPlaybackCapabilities, rnboPlaybackCapabilities } from "../playback/target-capabilities.mjs";

export function createPeerRegistry(config, options = {}) {
  const units = new Map();
  const targetHostOverrides = new Set();
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
      return Array.from(units.values()).map((unit) => structuredClone(annotateUnit(unit)));
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
    oscTargets() {
      return this.snapshot().flatMap((unit) =>
        (unit.oscTargets ?? []).map((target) => ({
          ...target,
          hardwareUnitId: unit.id,
          hardwareUnitName: unit.advertisedName || unit.id,
          available: unit.available && target.available !== false,
          unitStatus: unit.status
        }))
      );
    },
    rnboDevices() {
      return this.snapshot().flatMap((unit) => unit.rnboDevices ?? []);
    },
    useObservedHost(unitId, targetId) {
      const id = stringField(unitId);
      const existing = units.get(id);
      if (!existing) {
        throw new Error(`unknown hardware unit '${id}'`);
      }
      if (!existing.remoteAddress) {
        throw new Error(`hardware unit '${id}' has no observed remote address`);
      }
      const target = existing.targets.find((entry) => targetMatches(entry, targetId));
      if (!target) {
        throw new Error(`unknown RNBO target '${targetId}' for hardware unit '${id}'`);
      }
      targetHostOverrides.add(targetOverrideKey(id, target));
      return structuredClone(annotateUnit(existing));
    },
    expireOffline,
    clear() {
      units.clear();
      targetHostOverrides.clear();
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
          targets: unit.targets.map((target) => ({ ...target, available: false })),
          oscTargets: (unit.oscTargets ?? []).map((target) => ({ ...target, available: false }))
        });
      }
    }
    return Array.from(units.values()).map((unit) => structuredClone(unit));
  }

  function annotateUnit(unit) {
    const targets = unit.targets.map((target) => annotateTarget(unit, target));
    const diagnostics = targets.flatMap((target) => target.diagnostics ?? []);
    return {
      ...unit,
      targets,
      diagnostics
    };
  }

  function annotateTarget(unit, target) {
    const override = targetHostOverrides.has(targetOverrideKey(unit.id, target));
    const effectiveTarget = override
      ? {
          ...target,
          host: unit.remoteAddress,
          advertisedHost: target.host,
          hostOverride: {
            source: "observed-remote-address",
            host: unit.remoteAddress
          }
        }
      : target;
    const diagnostics = targetDiagnostics(unit, effectiveTarget);
    return diagnostics.length > 0 ? { ...effectiveTarget, diagnostics } : effectiveTarget;
  }
}

export function createLocalHardwareUnit(config, targets = [], rnboDevices = [], oscTargets = []) {
  const id = config.server?.hostIdentity || os.hostname();
  const normalizedRnboDevices = normalizeRnboDevices(rnboDevices, id, config.server?.advertisedName || id);
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
      capabilities: target.capabilities ?? rnboPlaybackCapabilities(config),
      hardwareUnitId: id,
      hardwareUnitName: config.server?.advertisedName || id,
      available: target.available !== false,
      unitStatus: "online"
    })),
    oscTargets: oscTargets.map((target) => ({
      ...target,
      hardwareUnitId: id,
      hardwareUnitName: config.server?.advertisedName || id,
      available: target.available !== false,
      unitStatus: "online"
    })),
    rnboDevices: normalizedRnboDevices.map((device) => ({
      ...device,
      hardwareUnitId: id,
      hardwareUnitName: config.server?.advertisedName || id,
      available: device.available !== false,
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
    rnboDevices: normalizeRnboDevices(document.rnboDevices, id, advertisedName),
    oscTargets: normalizeOscTargets(document.oscTargets, id, advertisedName),
    targets: normalizeTargets(document.targets, id, advertisedName, config)
  };
}

function normalizeRnboDevices(devices, hardwareUnitId, hardwareUnitName) {
  if (!Array.isArray(devices)) {
    return [];
  }
  return devices.map((device, index) => {
    const rawId = stringField(device.id) || `rnbo-device-${index + 1}`;
    const id = rawId.startsWith(`${hardwareUnitId}:`) ? rawId : `${hardwareUnitId}:${rawId}`;
    return {
      id,
      localId: rawId,
      name: stringField(device.name) || hardwareUnitName || rawId,
      host: stringField(device.host),
      oscQueryUrl: stringField(device.oscQueryUrl),
      graphEditorUrl: stringField(device.graphEditorUrl),
      rnboVersion: stringField(device.rnboVersion) || undefined,
      runnerVersion: stringField(device.runnerVersion) || undefined,
      source: stringField(device.source) || "registration",
      hardwareUnitId,
      hardwareUnitName,
      available: device.available !== false
    };
  });
}

function normalizeTargets(targets, hardwareUnitId, hardwareUnitName, config) {
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
      ackPath: stringField(target.ackPath) || undefined,
      currentStagePath: stringField(target.currentStagePath) || undefined,
      oscQueryUrl: stringField(target.oscQueryUrl) || undefined,
      app: stringField(target.app ?? target.instrument) || undefined,
      instance: stringField(target.instance ?? target.instanceName) || undefined,
      oscTargetId: stringField(target.oscTargetId ?? target.oscId) || undefined,
      oscCapabilities: target.oscCapabilities ?? target.controlCapabilities,
      label: stringField(target.label) || undefined,
      kind: stringField(target.kind) || undefined,
      baseAddress: stringField(target.baseAddress) || undefined,
      voiceId: stringField(target.voiceId) || undefined,
      clientId: target.clientId === undefined ? undefined : nullableStringField(target.clientId),
      capabilities: target.capabilities
        ? rnboPlaybackCapabilities(config, target.capabilities)
        : legacyRnboPlaybackCapabilities(config),
      source: stringField(target.source) || "registration",
      hardwareUnitId,
      hardwareUnitName,
      available: target.available !== false
    };
  });
}

function normalizeOscTargets(targets, hardwareUnitId, hardwareUnitName) {
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets.map((target, index) => {
    const address = stringField(target.address ?? target.baseAddress);
    const rawId = stringField(target.id) || `osc-target-${index + 1}`;
    const id = rawId.startsWith(`${hardwareUnitId}:`) ? rawId : `${hardwareUnitId}:${rawId}`;
    return {
      id,
      localId: rawId,
      name: stringField(target.name) || address || id,
      label: stringField(target.label) || stringField(target.name) || id,
      host: stringField(target.host),
      port: nullableNumberField(target.port),
      address,
      baseAddress: stringField(target.baseAddress) || address,
      oscQueryUrl: stringField(target.oscQueryUrl) || undefined,
      instanceId: stringField(target.instanceId),
      app: stringField(target.app ?? target.instrument) || undefined,
      instance: stringField(target.instance ?? target.instanceName) || undefined,
      oscTargetId: stringField(target.oscTargetId ?? target.oscId) || undefined,
      oscCapabilities: target.oscCapabilities ?? target.controlCapabilities,
      parameters: Array.isArray(target.parameters) ? target.parameters : [],
      inputPorts: Array.isArray(target.inputPorts) ? target.inputPorts : [],
      kind: stringField(target.kind) || "rnbo",
      source: stringField(target.source) || "registration",
      hardwareUnitId,
      hardwareUnitName,
      available: target.available !== false
    };
  });
}

function targetDiagnostics(unit, target) {
  if (target.hostOverride) {
    return [];
  }
  const advertisedHost = stringField(target.advertisedHost ?? target.host);
  const observedHost = stringField(unit.remoteAddress);
  if (!observedHost || !advertisedHost || advertisedHost === observedHost || !isIpAddress(advertisedHost)) {
    return [];
  }
  return [
    {
      type: "target-host-mismatch",
      severity: "warning",
      unitId: unit.id,
      targetId: target.id,
      advertisedHost,
      observedHost,
      repairable: true,
      message: `${unit.advertisedName || unit.id} registered from ${observedHost} but advertises RNBO at ${advertisedHost}.`
    }
  ];
}

function targetMatches(target, targetId) {
  const id = stringField(targetId);
  return target.id === id || target.localId === id;
}

function targetOverrideKey(unitId, target) {
  return `${unitId}:${target.localId || target.id}`;
}

function isIpAddress(value) {
  return net.isIP(value) !== 0;
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
