export const OSC_ASSIGNMENTS_COLLECTION = "oscAssignments";
export const OSC_CLIPS_COLLECTION = "oscClips";
export const OSC_LAYERS_COLLECTION = "oscLayers";
export const OSC_SNAPSHOT_SCHEMA_VERSION = 1;

export function normalizeOscClip(document) {
  if (!isPlainObject(document)) {
    throw new Error("OSC clip must be an object");
  }
  const snapshot = normalizeOscSnapshot({
    schemaVersion: document.schemaVersion,
    app: document.app,
    params: document.params,
    inputPorts: document.inputPorts
  });
  rejectUnknownFields(document, new Set(["name", "schemaVersion", "app", "params", "inputPorts", "capture"]), "OSC clip");
  return {
    name: stringField(document.name),
    ...snapshot,
    capture: normalizeCapture(document.capture)
  };
}

const MOMENTARY_INPUT_PORTS = new Set([
  "get",
  "panic",
  "probe",
  "reset",
  "rtz",
  "setstage"
]);

export function normalizeOscSnapshot(document) {
  if (!isPlainObject(document)) {
    throw new Error("OSC snapshot must be an object");
  }
  const schemaVersion = document.schemaVersion ?? OSC_SNAPSHOT_SCHEMA_VERSION;
  if (schemaVersion !== OSC_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported OSC snapshot schema version '${schemaVersion}'`);
  }
  const app = cleanToken(document.app);
  if (!app) {
    throw new Error("OSC snapshot app must be a non-empty semantic identifier");
  }
  rejectUnknownFields(document, new Set(["schemaVersion", "app", "params", "inputPorts"]), "OSC snapshot");
  return {
    schemaVersion,
    app,
    params: normalizeParams(document.params ?? {}),
    inputPorts: normalizeInputPorts(document.inputPorts ?? {})
  };
}

export function snapshotControlDisposition({ kind, name, meta = {} } = {}) {
  const controlKind = kind === "inputPort" ? "inputPort" : kind === "param" ? "param" : "";
  const semanticName = stringField(name);
  if (!controlKind || !semanticName) {
    return { state: "excluded", reason: "invalid-control" };
  }
  if (meta?.snapshot === false || meta?.snapshot_state === false) {
    return { state: "excluded", reason: "metadata-excluded" };
  }
  if (controlKind === "inputPort" && isMomentaryInputPort(semanticName, meta)) {
    return { state: "excluded", reason: "momentary-control" };
  }
  if (controlKind === "param" && semanticName.toLowerCase() === "clock") {
    return { state: "clock", reason: "clock-last" };
  }
  if (meta?.snapshot_order === "late") {
    return { state: "late", reason: "metadata-late" };
  }
  return { state: "persistent", reason: "editor-owned" };
}

function normalizeParams(document) {
  if (!isPlainObject(document)) {
    throw new Error("OSC snapshot params must be an object");
  }
  return Object.fromEntries(Object.entries(document).map(([name, value]) => {
    const semanticName = normalizeControlName(name, "parameter");
    if (!Number.isFinite(value)) {
      throw new Error(`OSC snapshot parameter '${semanticName}' must be numeric`);
    }
    return [semanticName, Number(value)];
  }));
}

function normalizeInputPorts(document) {
  if (!isPlainObject(document)) {
    throw new Error("OSC snapshot inputPorts must be an object");
  }
  return Object.fromEntries(Object.entries(document).map(([name, values]) => {
    const semanticName = normalizeControlName(name, "input port");
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`OSC snapshot input port '${semanticName}' must be a numeric list`);
    }
    return [semanticName, values.map(Number)];
  }));
}

function normalizeCapture(document) {
  if (document === undefined) return {};
  if (!isPlainObject(document)) throw new Error("OSC clip capture must be an object");
  rejectUnknownFields(document, new Set(["deviceId", "targetId", "capturedAt"]), "OSC clip capture");
  return {
    deviceId: stringField(document.deviceId),
    targetId: stringField(document.targetId),
    capturedAt: stringField(document.capturedAt)
  };
}

function normalizeControlName(value, label) {
  const name = stringField(value);
  if (!name || name.startsWith("/") || name.includes("/")) {
    throw new Error(`OSC snapshot ${label} names must be semantic names, not OSC addresses`);
  }
  return name;
}

function isMomentaryInputPort(name, meta) {
  if (meta?.snapshot === true || meta?.snapshot_state === true) {
    return false;
  }
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return MOMENTARY_INPUT_PORTS.has(normalized)
    || normalized.endsWith("probe")
    || normalized.endsWith("panic")
    || normalized.endsWith("ack");
}

function rejectUnknownFields(document, allowed, label) {
  const unknown = Object.keys(document).filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new Error(`${label} contains unknown field '${unknown[0]}'`);
  }
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
