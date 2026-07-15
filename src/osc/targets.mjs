export function buildOscTargets(rnboTargets = [], filters = {}) {
  const normalized = rnboTargets.map((target, index) => normalizeOscTarget(target, index));
  const counts = new Map();
  for (const target of normalized) {
    counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
  }
  return normalized
    .map((target) => counts.get(target.id) > 1
      ? { ...target, status: "ambiguous", sendable: false, diagnostics: [...target.diagnostics, ambiguousDiagnostic(target.id)] }
      : target)
    .filter((target) => matchesFilters(target, filters));
}

export function findOscTarget(rnboTargets, targetId) {
  const id = stringField(targetId);
  return buildOscTargets(rnboTargets).find((target) => target.id === id || target.rnboTargetId === id);
}

function normalizeOscTarget(target, index) {
  const unitId = stringField(target.hardwareUnitId ?? target.deviceId) || "local";
  const localId = stringField(target.localId ?? target.id) || `target-${index + 1}`;
  const app = explicitApp(target) || inferApp(target) || "rnbo";
  const instance = explicitInstance(target) || inferInstance(target, app, localId) || "main";
  const host = stringField(target.host);
  const port = nullableNumber(target.oscPort ?? target.port);
  const address = normalizeAddress(target.oscAddress ?? target.address ?? target.messagePath);
  const diagnostics = Array.isArray(target.diagnostics) ? target.diagnostics : [];
  const stale = diagnostics.some((diagnostic) => diagnostic.type === "target-host-mismatch");
  const online = target.available !== false && target.unitStatus !== "offline";
  const status = !online ? "offline" : stale ? "stale" : "online";
  const capabilities = oscCapabilities(target, app);

  return withoutUndefined({
    id: stableOscTargetId(target, unitId, app, instance, localId),
    unitId,
    deviceId: stringField(target.deviceId) || unitId,
    label: stringField(target.label ?? target.name) || `${titleCase(app)} ${instance}`,
    app,
    instance,
    kind: stringField(target.kind) || "rnbo",
    status,
    sendable: status === "online" && Boolean(host) && Number.isFinite(port),
    host,
    port,
    baseAddress: target.baseAddress ?? baseAddressFromRnboTarget(target),
    oscQueryUrl: stringField(target.oscQueryUrl) || undefined,
    address,
    parameters: normalizeParameters(target.parameters),
    inputPorts: normalizeInputPorts(target.inputPorts),
    rnboTargetId: target.id,
    localTargetId: localId,
    source: target.source,
    capabilities,
    diagnostics
  });
}

function normalizeParameters(parameters) {
  if (!Array.isArray(parameters)) {
    return [];
  }
  return parameters.map((parameter) => ({
    name: semanticParameterName(parameter.name),
    address: normalizeAddress(parameter.address),
    type: stringField(parameter.type) || undefined,
    value: parameter.value,
    min: parameter.min,
    max: parameter.max,
    values: parameter.values,
    unit: stringField(parameter.unit) || undefined,
    displayName: stringField(parameter.displayName) || semanticParameterName(parameter.name),
    index: parameter.index,
    normalized: parameter.normalized,
    meta: parameter.meta
  })).filter((parameter) => parameter.name && parameter.address);
}

function semanticParameterName(value) {
  const name = stringField(value);
  return /^clock_1_$/i.test(name) ? "Clock" : name;
}

function normalizeInputPorts(inputPorts) {
  if (!Array.isArray(inputPorts)) {
    return [];
  }
  return inputPorts.map((inputPort) => ({
    name: semanticInputPortName(inputPort.name),
    address: normalizeAddress(inputPort.address),
    type: stringField(inputPort.type) || undefined,
    value: inputPort.value,
    displayName: stringField(inputPort.displayName) || semanticInputPortName(inputPort.name),
    index: inputPort.index,
    meta: inputPort.meta
  })).filter((inputPort) => inputPort.name && inputPort.address);
}

function semanticInputPortName(value) {
  const name = stringField(value);
  return /^4ow$/i.test(name) ? "4row" : name;
}

function stableOscTargetId(target, unitId, app, instance, localId) {
  const configured = stringField(target.oscTargetId ?? target.oscId);
  if (configured) {
    return configured;
  }
  if (app && instance) {
    return `${unitId}:${app}:${instance}`;
  }
  return `${unitId}:${localId}`;
}

function explicitApp(target) {
  return cleanToken(target.app ?? target.instrument ?? target.metadata?.app ?? target.osc?.app);
}

function explicitInstance(target) {
  return cleanToken(target.instance ?? target.instanceName ?? target.metadata?.instance ?? target.osc?.instance);
}

function inferApp(target) {
  const text = [
    target.name,
    target.label,
    target.id,
    target.localId,
    target.patch,
    target.patcherName,
    target.address,
    target.messagePath
  ].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("poland")) {
    return "poland";
  }
  if (text.includes("plate")) {
    return "plate";
  }
  if (text.includes("element")) {
    return "element";
  }
  if (text.includes("shadowscore")) {
    return "shadowscore";
  }
  return "";
}

function inferInstance(target, app, localId) {
  const raw = stringField(target.instanceId);
  if (raw && app !== "shadowscore") {
    return raw;
  }
  if (localId && !/^target-\d+$/.test(localId) && !localId.includes(":")) {
    return cleanToken(localId);
  }
  return "main";
}

function oscCapabilities(target, app) {
  const values = new Set(["osc", "rnbo", "volume"]);
  if (app) {
    values.add(`${app}-edit`);
  }
  if (Array.isArray(target.parameters) && target.parameters.some((parameter) => stringField(parameter?.meta?.editor).toLowerCase() === "ttid")) {
    values.add("ttid-edit");
  }
  const configured = target.oscCapabilities ?? target.controlCapabilities ?? target.metadata?.oscCapabilities;
  if (Array.isArray(configured)) {
    for (const capability of configured) {
      const value = cleanToken(capability);
      if (value) {
        values.add(value);
      }
    }
  } else if (configured && typeof configured === "object") {
    for (const [capability, enabled] of Object.entries(configured)) {
      if (enabled) {
        const value = cleanToken(capability);
        if (value) {
          values.add(value);
        }
      }
    }
  }
  return Array.from(values).sort();
}

function baseAddressFromRnboTarget(target) {
  const address = normalizeAddress(target.address ?? target.messagePath);
  const match = address.match(/^(\/rnbo\/inst\/[^/]+)/);
  return match ? match[1] : "";
}

function matchesFilters(target, filters) {
  const app = cleanToken(filters.app);
  if (app && target.app !== app) {
    return false;
  }
  const capability = cleanToken(filters.capability);
  if (capability && !target.capabilities.includes(capability)) {
    return false;
  }
  const status = cleanToken(filters.status);
  if (status && target.status !== status) {
    return false;
  }
  return true;
}

function ambiguousDiagnostic(targetId) {
  return {
    type: "ambiguous-osc-target",
    severity: "error",
    targetId,
    message: `OSC target '${targetId}' resolves to multiple live targets.`
  };
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleCase(value) {
  const text = stringField(value);
  if (text.toLowerCase() === "ttid") {
    return "TTID";
  }
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "OSC";
}

function normalizeAddress(value) {
  const address = stringField(value).replace(/\/+/g, "/");
  return address ? (address.startsWith("/") ? address : `/${address}`) : "";
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
