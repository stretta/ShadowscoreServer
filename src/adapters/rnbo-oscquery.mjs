import dgram from "node:dgram";
import { encodeOscMessage } from "./osc.mjs";
import { rnboPlaybackCapabilities } from "../playback/target-capabilities.mjs";

const TRANSPORT_PARAM_CONTROLS = new Set(["Clock"]);
const TRANSPORT_INPORT_CONTROLS = new Set(["MaxSteps", "ClockInterval", "Tempo", "SetStage", "Stage"]);

export async function discoverRnboTargets(config, options = {}) {
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  if (!oscQuery.enabled) {
    return [];
  }

  try {
    const tree = await fetchOscQueryTree(oscQuery, options.fetchImpl ?? globalThis.fetch);
    return extractRnboTargets(tree, config);
  } catch (error) {
    if (rnbo.log !== false) {
      console.error(`[rnbo-oscquery] discovery failed: ${messageForError(error)}`);
    }
    return [];
  }
}

export async function discoverRnboDevices(config, options = {}) {
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  if (!oscQuery.enabled) {
    return [];
  }

  try {
    const tree = await fetchOscQueryTree(oscQuery, options.fetchImpl ?? globalThis.fetch);
    return extractRnboDevices(tree, config);
  } catch (error) {
    if (rnbo.log !== false) {
      console.error(`[rnbo-oscquery] device discovery failed: ${messageForError(error)}`);
    }
    return [];
  }
}

export async function discoverRnboControlTargets(config, options = {}) {
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  if (!oscQuery.enabled) {
    return [];
  }

  try {
    const tree = await fetchOscQueryTree(oscQuery, options.fetchImpl ?? globalThis.fetch);
    return extractRnboControlTargets(tree, config);
  } catch (error) {
    if (rnbo.log !== false) {
      console.error(`[rnbo-oscquery] control target discovery failed: ${messageForError(error)}`);
    }
    return [];
  }
}

export async function writeRnboTransportControls(config, target, controls, options = {}) {
  const writes = rnboTransportControlWrites(target, controls);
  const writer = options.writer ?? sendOscInportMessage;

  for (const write of writes) {
    await writer(write);
  }

  return writes;
}

export const writeRnboTransportParams = writeRnboTransportControls;

export function rnboTransportControlWrites(target, controls) {
  if (!target || typeof target !== "object") {
    throw new Error("RNBO target is required");
  }

  const instanceId = target.instanceId ?? readInstanceId(target.address ?? target.messagePath ?? "");
  if (!instanceId) {
    throw new Error(`RNBO target '${target.id ?? ""}' does not include an instance id`);
  }

  const host = target.host;
  const port = Number(target.oscPort ?? target.port);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`RNBO target '${target.id ?? ""}' is missing host or port`);
  }

  const entries = Object.entries(controls ?? {});
  if (entries.length === 0) {
    throw new Error("controls must include at least one RNBO transport control");
  }

  return entries.map(([name, value]) => {
    const controlName = normalizeTransportControlName(name);
    const controlRoot = TRANSPORT_PARAM_CONTROLS.has(controlName) ? "params" : "messages/in";
    return {
      host,
      port,
      path: `/rnbo/inst/${instanceId}/${controlRoot}/${controlName}`,
      value: finiteNumber(value, name)
    };
  });
}

export const rnboTransportParamWrites = rnboTransportControlWrites;

export function configuredRnboTargets(config) {
  const rnbo = config.rnbo ?? {};
  const targets = Array.isArray(rnbo.targets) && rnbo.targets.length > 0
    ? rnbo.targets
    : [];
  return targets.map((target, index) => normalizeConfiguredTarget(target, rnbo, index));
}

export async function fetchOscQueryTree(oscQuery, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for RNBOOSCQuery discovery");
  }

  const timeoutMs = clampTimeout(oscQuery.timeoutMs);
  const response = await fetchImpl(oscQuery.url ?? "http://127.0.0.1:5678/", {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`RNBOOSCQuery returned HTTP ${response.status}`);
  }
  return response.json();
}

export function extractRnboTargets(tree, config) {
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  const addressPattern = String(oscQuery.addressPattern ?? "shadowscore").toLowerCase();
  const entries = [];

  walkOscQueryTree(tree, "", (path, node) => {
    if (!isShadowScoreMessagePath(path, node, addressPattern)) {
      return;
    }
    const address = normalizeAddress(path);
    const instanceId = readInstanceId(address);
    const instanceNode = findInstanceNode(tree, instanceId);
    const outports = readMessageOutports(instanceNode);
    entries.push(withoutUndefined({
      id: instanceId ? `rnbo-inst-${instanceId}:shadowscore` : address,
      name: instanceId ? `ShadowScoreClient / shadowscore` : address,
      host: oscQuery.oscHost ?? rnbo.host,
      port: Number(oscQuery.oscPort ?? rnbo.port),
      address,
      instanceId,
      messagePath: address,
      ackPath: outports.shadowscore_ack,
      currentStagePath: outports.current_stage,
      currentStage: outports.current_stage_value,
      clientId: readClientId(node, instanceNode),
      capabilities: rnboPlaybackCapabilities(config, readTargetCapabilities(node, instanceNode)),
      source: "rnbooscquery",
      available: true
    }));
  });

  return dedupeTargets(entries);
}

export function extractRnboDevices(tree, config) {
  if (!tree?.CONTENTS?.rnbo) {
    return [];
  }

  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  const host = rnboDeviceHost(config);
  const oscQueryPort = urlPort(oscQuery.url, 5678);
  const graphEditorPort = Number(oscQuery.graphEditorPort ?? rnbo.graphEditorPort ?? 3000);
  const name = config.server?.advertisedName || config.server?.hostIdentity || host || "RNBO";
  const id = config.server?.hostIdentity || name;

  return [withoutUndefined({
    id,
    name,
    host,
    oscQueryUrl: host ? `http://${host}:${oscQueryPort}` : stripTrailingSlash(oscQuery.url),
    graphEditorUrl: host && Number.isFinite(graphEditorPort) ? `http://${host}:${graphEditorPort}` : undefined,
    source: "rnbooscquery",
    available: true,
    rnboVersion: tree.CONTENTS.rnbo.CONTENTS?.info?.CONTENTS?.version?.VALUE,
    runnerVersion: tree.CONTENTS.rnbo.CONTENTS?.info?.CONTENTS?.runner_version?.VALUE
  })];
}

export function extractRnboControlTargets(tree, config) {
  const instances = tree?.CONTENTS?.rnbo?.CONTENTS?.inst?.CONTENTS ?? {};
  const namesByInstance = rnboInstanceNames(tree);
  const entries = Object.entries(instances).map(([instanceId, node]) => controlTargetForInstance(instanceId, node, namesByInstance.get(String(instanceId)), config)).filter(Boolean);
  const countsByApp = entries.reduce((counts, target) => counts.set(target.app, (counts.get(target.app) ?? 0) + 1), new Map());
  return entries.map((target) => ({
    ...target,
    instance: countsByApp.get(target.app) === 1 ? "main" : target.instance
  }));
}

function controlTargetForInstance(instanceId, node, name, config) {
  const parameters = extractRnboParams(node);
  const inputPorts = extractRnboInputPorts(instanceId, node);
  if (parameters.length === 0 && inputPorts.length === 0) {
    return undefined;
  }
  const app = inferControlApp(name, parameters, inputPorts);
  if (!app) {
    return undefined;
  }
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  const instance = String(instanceId);
  const oscCapabilities = ["editor", "volume", "preset", `${app}-edit`];
  if (parameters.some(isTtidParameter) && !oscCapabilities.includes("ttid-edit")) {
    oscCapabilities.push("ttid-edit");
  }
  return withoutUndefined({
    id: `rnbo-inst-${instance}:${app}`,
    name: `${titleCase(app)} ${instance}`,
    label: `${titleCase(app)} ${instance}`,
    host: oscQuery.oscHost ?? rnbo.host,
    port: Number(oscQuery.oscPort ?? rnbo.port),
    address: `/rnbo/inst/${instance}`,
    baseAddress: `/rnbo/inst/${instance}`,
    instanceId: instance,
    app,
    instance,
    oscCapabilities,
    parameters,
    inputPorts,
    source: "rnbooscquery",
    available: true
  });
}

function extractRnboParams(instanceNode) {
  const contents = instanceNode?.CONTENTS?.params?.CONTENTS ?? instanceNode?.CONTENTS?.parameters?.CONTENTS ?? {};
  return Object.entries(contents).map(([name, node]) => normalizeRnboParam(name, node)).filter(Boolean).sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999));
}

function extractRnboInputPorts(instanceId, instanceNode) {
  const contents = instanceNode?.CONTENTS?.messages?.CONTENTS?.in?.CONTENTS ?? {};
  return Object.entries(contents)
    .map(([name, node]) => normalizeRnboInputPort(instanceId, name, node))
    .filter(Boolean)
    .sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999) || a.name.localeCompare(b.name));
}

function normalizeRnboParam(name, node) {
  const address = normalizeAddress(node?.FULL_PATH);
  if (!address || address.includes("/normalized") || address.includes("/meta") || address.includes("/index")) {
    return undefined;
  }
  const range = Array.isArray(node.RANGE) ? node.RANGE : [];
  const meta = parseMetadata(node.CONTENTS);
  return withoutUndefined({
    name,
    address,
    type: node.TYPE,
    value: node.VALUE,
    range,
    min: firstFinite(range.map((entry) => entry.MIN)),
    max: firstFinite(range.map((entry) => entry.MAX)),
    values: firstArray(range.map((entry) => entry.VALS)),
    unit: stringField(meta?.unit ?? meta?.units ?? node.CONTENTS?.unit?.VALUE) || undefined,
    displayName: stringField(meta?.display_name ?? node.CONTENTS?.display_name?.VALUE) || name,
    index: optionalFiniteNumber(node.CONTENTS?.index?.VALUE),
    normalized: optionalFiniteNumber(node.CONTENTS?.normalized?.VALUE),
    meta
  });
}

function normalizeRnboInputPort(instanceId, name, node) {
  const address = normalizeAddress(node?.FULL_PATH) || joinAddress(`/rnbo/inst/${instanceId}/messages/in`, name);
  if (!address || address.includes("/meta")) {
    return undefined;
  }
  const meta = parseMetadata(node?.CONTENTS);
  return withoutUndefined({
    name,
    address,
    type: stringField(node?.TYPE) || undefined,
    value: node?.VALUE,
    displayName: stringField(meta?.display_name ?? node?.CONTENTS?.display_name?.VALUE) || name,
    index: optionalFiniteNumber(node?.CONTENTS?.index?.VALUE),
    meta
  });
}

function rnboInstanceNames(tree) {
  const names = new Map();
  const properties = tree?.CONTENTS?.rnbo?.CONTENTS?.jack?.CONTENTS?.info?.CONTENTS?.ports?.CONTENTS?.properties?.CONTENTS ?? {};
  for (const [portName, node] of Object.entries(properties)) {
    const metadata = parseJsonObject(node?.VALUE);
    const instanceId = metadata?.["rnbo-instance-id"];
    if (instanceId === undefined || instanceId === null) {
      continue;
    }
    const name = String(portName).split(":")[0] || "";
    if (name) {
      names.set(String(instanceId), name);
    }
  }
  return names;
}

function inferControlApp(name, parameters, inputPorts = []) {
  const loweredName = stringField(name).toLowerCase();
  if (loweredName.startsWith("poland")) {
    return "poland";
  }
  if (loweredName.startsWith("ttid")) {
    return "ttid";
  }
  if (loweredName.startsWith("plate")) {
    return "plate";
  }
  if (loweredName.startsWith("listsequencer") || loweredName.startsWith("list sequencer")) {
    return "listsequencer";
  }
  if (loweredName.startsWith("analogsequencer") || loweredName.startsWith("analog sequencer")) {
    return "analogsequencer";
  }
  const parameterNames = new Set(parameters.map((param) => param.name));
  const loweredParameterNames = new Set(parameters.map((param) => stringField(param.name).toLowerCase()));
  const loweredInputPortNames = new Set(inputPorts.map((inputPort) => stringField(inputPort.name).toLowerCase()));
  if (parameters.some(isTtidParameter)) {
    return "ttid";
  }
  if (parameterNames.has("VolA") && parameterNames.has("VolB") && parameterNames.has("WaveA") && parameterNames.has("WaveB")) {
    return "poland";
  }
  if (hasAtLeastParameters(loweredParameterNames, ["decay", "predelay", "damping", "damp", "diffusion", "diff", "size", "mix", "wet", "dry"], 2)) {
    return "plate";
  }
  if (hasAtLeastParameters(loweredInputPortNames, ["steps", "primaryrotation", "secondaryrotation", "velocity", "duration"], 3)) {
    return "listsequencer";
  }
  if (hasNumberedStageParameters(loweredParameterNames, "stagevalue") && hasNumberedStageParameters(loweredParameterNames, "stagestep")) {
    return "analogsequencer";
  }
  return "";
}

function isTtidParameter(param) {
  return stringField(param?.meta?.editor).toLowerCase() === "ttid";
}

function hasAtLeastParameters(parameterNames, candidates, threshold) {
  return candidates.filter((candidate) => parameterNames.has(candidate)).length >= threshold;
}

function hasNumberedStageParameters(parameterNames, suffix) {
  return [...parameterNames].filter((name) => new RegExp(`^(?:\\d{1,2}${suffix}|${suffix}[_ -]?\\d{1,2})$`).test(name)).length >= 2;
}

function walkOscQueryTree(node, path, visit) {
  if (!node || typeof node !== "object") {
    return;
  }

  const nodePath = normalizeAddress(node.FULL_PATH ?? path);
  if (nodePath) {
    visit(nodePath, node);
  }

  const contents = node.CONTENTS;
  if (!contents || typeof contents !== "object") {
    return;
  }

  for (const [name, child] of Object.entries(contents)) {
    const childPath = child?.FULL_PATH ?? joinAddress(nodePath, name);
    walkOscQueryTree(child, childPath, visit);
  }
}

function findInstanceNode(tree, instanceId) {
  if (!instanceId) {
    return null;
  }
  return tree?.CONTENTS?.rnbo?.CONTENTS?.inst?.CONTENTS?.[instanceId] ?? null;
}

function readMessageOutports(instanceNode) {
  const contents = instanceNode?.CONTENTS?.messages?.CONTENTS?.out?.CONTENTS ?? {};
  return {
    shadowscore_ack: normalizeAddress(contents.shadowscore_ack?.FULL_PATH),
    current_stage: normalizeAddress(contents.current_stage?.FULL_PATH),
    current_stage_value: firstListNumber(contents.current_stage?.VALUE)
  };
}

function readClientId(inportNode, instanceNode) {
  const candidates = [
    firstListNumber(inportNode?.VALUE),
    firstListNumber(instanceNode?.CONTENTS?.messages?.CONTENTS?.out?.CONTENTS?.shadowscore_ack?.VALUE)
  ];
  const clientId = candidates.find((value) => Number.isInteger(value) && value > 0);
  return clientId === undefined ? undefined : String(clientId);
}

function readTargetCapabilities(inportNode, instanceNode) {
  const candidates = [
    inportNode?.CONTENTS?.capabilities?.VALUE,
    inportNode?.CONTENTS?.capabilities?.CONTENTS?.value?.VALUE,
    instanceNode?.CONTENTS?.messages?.CONTENTS?.out?.CONTENTS?.capabilities?.VALUE,
    instanceNode?.CONTENTS?.messages?.CONTENTS?.out?.CONTENTS?.capabilities?.CONTENTS?.value?.VALUE
  ];
  for (const candidate of candidates) {
    const parsed = parseCapabilityValue(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function parseCapabilityValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1) {
    return parseCapabilityValue(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstListNumber(value) {
  if (Array.isArray(value) && typeof value[0] === "number") {
    return Math.round(value[0]);
  }
  return undefined;
}

function isShadowScoreMessagePath(path, node, addressPattern) {
  const normalized = normalizeAddress(path).toLowerCase();
  if (!normalized.endsWith(`/${addressPattern}`)) {
    return false;
  }
  if (normalized.includes("/messages/in/")) {
    return true;
  }
  return node?.TYPE === "m" && normalized.endsWith(`/${addressPattern}`);
}

function normalizeAddress(path) {
  if (!path) {
    return "";
  }
  const normalized = String(path).replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function joinAddress(base, name) {
  const cleanedBase = normalizeAddress(base).replace(/\/$/, "");
  return normalizeAddress(`${cleanedBase}/${name}`);
}

function readInstanceId(address) {
  const match = address.match(/\/rnbo\/inst\/([^/]+)/);
  return match ? match[1] : "";
}

async function sendOscInportMessage(write) {
  const socket = dgram.createSocket("udp4");
  try {
    const packet = encodeOscMessage(write.path, [write.value]);
    await new Promise((resolve, reject) => {
      socket.send(packet, write.port, write.host, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } finally {
    socket.close();
  }
}

function normalizeTransportControlName(name) {
  const controlName = String(name ?? "");
  if (!TRANSPORT_PARAM_CONTROLS.has(controlName) && !TRANSPORT_INPORT_CONTROLS.has(controlName)) {
    throw new Error(`unsupported RNBO transport control '${controlName}'`);
  }
  return controlName;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}

function dedupeTargets(targets) {
  const seen = new Set();
  const unique = [];
  for (const target of targets) {
    const key = `${target.host}:${target.port}:${target.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(target);
    }
  }
  return unique;
}

function normalizeConfiguredTarget(target, rnbo, index) {
  const address = target.address ?? rnbo.address;
  const instanceId = readInstanceId(address);
  return withoutUndefined({
    id: target.id ?? (instanceId ? `rnbo-inst-${instanceId}:shadowscore` : `configured-${index + 1}`),
    name: target.name ?? (instanceId ? `ShadowScoreClient / shadowscore` : address),
    host: target.host ?? rnbo.host,
    port: Number(target.port ?? rnbo.port),
    address,
    instanceId,
    messagePath: address,
    app: stringField(target.app ?? target.instrument) || undefined,
    instance: stringField(target.instance ?? target.instanceName) || undefined,
    oscTargetId: stringField(target.oscTargetId ?? target.oscId) || undefined,
    oscCapabilities: target.oscCapabilities ?? target.controlCapabilities,
    label: stringField(target.label) || undefined,
    kind: stringField(target.kind) || undefined,
    baseAddress: stringField(target.baseAddress) || undefined,
    ackPath: target.ackPath,
    currentStagePath: target.currentStagePath,
    currentStage: optionalFiniteNumber(target.currentStage),
    voiceId: target.voiceId,
    clientId: target.clientId,
    capabilities: rnboPlaybackCapabilities({ rnbo }, target.capabilities),
    source: "config",
    available: true
  });
}

function rnboDeviceHost(config) {
  const rnbo = config.rnbo ?? {};
  const oscQuery = rnbo.oscQuery ?? {};
  const configured = stringField(oscQuery.oscHost)
    || stringField(rnbo.registrationHost)
    || stringField(rnbo.host);
  if (!configured || configured === "127.0.0.1" || configured === "localhost" || configured === "::1") {
    const identity = stringField(config.server?.hostIdentity || config.server?.advertisedName);
    return identity ? `${identity}.local` : configured;
  }
  return configured;
}

function urlPort(value, fallback) {
  try {
    const url = new URL(value);
    return Number(url.port || fallback);
  } catch {
    return fallback;
  }
}

function stripTrailingSlash(value) {
  return stringField(value).replace(/\/+$/, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 1000;
  }
  return Math.min(10000, Math.max(100, Math.round(number)));
}

function optionalFiniteNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstFinite(values) {
  return values.map(optionalFiniteNumber).find((value) => value !== undefined);
}

function firstArray(values) {
  return values.find((value) => Array.isArray(value));
}

function parseMetadata(contents) {
  const metadata = {};
  const applyTag = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const text = value.trim();
    if (!text) {
      return;
    }
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
    if (!tags.includes(text)) {
      tags.push(text);
    }
    metadata.tags = tags;

    for (const separator of [":", "="]) {
      if (!text.includes(separator)) {
        continue;
      }
      const [key, ...rest] = text.split(separator);
      const raw = rest.join(separator).trim();
      const cleanKey = key.trim();
      if (!cleanKey || !raw || metadata[cleanKey] !== undefined) {
        return;
      }
      metadata[cleanKey] = parseScalar(raw);
      return;
    }

    if (["ttid", "step16", "step 16", "pitch_display", "scope", "scope_display", "time_domain_scope"].includes(text.toLowerCase()) && metadata.editor === undefined) {
      metadata.editor = text;
    }
  };

  const rawMeta = contents?.meta?.VALUE;
  if (typeof rawMeta === "string" && rawMeta.trim()) {
    try {
      const parsed = JSON.parse(rawMeta.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(metadata, parsed);
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          applyTag(item);
        }
      } else {
        applyTag(String(parsed));
      }
    } catch {
      applyTag(rawMeta);
    }
  }

  if (contents && typeof contents === "object") {
    for (const [name, node] of Object.entries(contents)) {
      if (name === "meta" || !node || typeof node !== "object" || !("VALUE" in node)) {
        continue;
      }
      const value = node.VALUE;
      if (!["editor", "display_name", "unit", "units", "ui_role", "display_as", "edit_as", "display_precision", "edit_step", "bool", "is_bool", "boolean", "label"].includes(name)) {
        continue;
      }
      if (["string", "number", "boolean"].includes(typeof value) && String(value).trim()) {
        metadata[name] = value;
      }
    }
  }

  return Object.keys(metadata).length ? metadata : undefined;
}

function parseScalar(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function titleCase(value) {
  const text = stringField(value);
  if (text.toLowerCase() === "ttid") {
    return "TTID";
  }
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "RNBO";
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
