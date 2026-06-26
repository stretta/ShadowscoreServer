import dgram from "node:dgram";
import { encodeOscMessage } from "./osc.mjs";
import { rnboPlaybackCapabilities } from "../playback/target-capabilities.mjs";

const TRANSPORT_PARAMS = new Set(["Clock"]);
const TRANSPORT_INPORTS = new Set(["MaxSteps", "ClockInterval", "Tempo", "SetStage", "Stage"]);

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

export async function writeRnboTransportParams(config, target, params, options = {}) {
  const writes = rnboTransportParamWrites(target, params);
  const writer = options.writer ?? sendOscInportMessage;

  for (const write of writes) {
    await writer(write);
  }

  return writes;
}

export function rnboTransportParamWrites(target, params) {
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

  const entries = Object.entries(params ?? {});
  if (entries.length === 0) {
    throw new Error("params must include at least one transport parameter");
  }

  return entries.map(([name, value]) => {
    const controlName = normalizeTransportControlName(name);
    const controlRoot = TRANSPORT_PARAMS.has(controlName) ? "params" : "messages/in";
    return {
      host,
      port,
      path: `/rnbo/inst/${instanceId}/${controlRoot}/${controlName}`,
      value: finiteNumber(value, name)
    };
  });
}

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
    entries.push({
      id: instanceId ? `rnbo-inst-${instanceId}:shadowscore` : address,
      name: instanceId ? `ShadowScoreClient / shadowscore` : address,
      host: oscQuery.oscHost ?? rnbo.host,
      port: Number(oscQuery.oscPort ?? rnbo.port),
      address,
      instanceId,
      messagePath: address,
      ackPath: outports.shadowscore_ack,
      currentStagePath: outports.current_stage,
      clientId: readClientId(node, instanceNode),
      capabilities: rnboPlaybackCapabilities(config, node?.CONTENTS?.capabilities?.VALUE),
      source: "rnbooscquery",
      available: true
    });
  });

  return dedupeTargets(entries);
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
    current_stage: normalizeAddress(contents.current_stage?.FULL_PATH)
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
  if (!TRANSPORT_PARAMS.has(controlName) && !TRANSPORT_INPORTS.has(controlName)) {
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
  return {
    id: target.id ?? (instanceId ? `rnbo-inst-${instanceId}:shadowscore` : `configured-${index + 1}`),
    name: target.name ?? (instanceId ? `ShadowScoreClient / shadowscore` : address),
    host: target.host ?? rnbo.host,
    port: Number(target.port ?? rnbo.port),
    address,
    instanceId,
    messagePath: address,
    ackPath: target.ackPath,
    currentStagePath: target.currentStagePath,
    voiceId: target.voiceId,
    clientId: target.clientId,
    capabilities: rnboPlaybackCapabilities({ rnbo }, target.capabilities),
    source: "config",
    available: true
  };
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 1000;
  }
  return Math.min(10000, Math.max(100, Math.round(number)));
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
