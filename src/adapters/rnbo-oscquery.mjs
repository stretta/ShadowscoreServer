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
    entries.push({
      id: instanceId ? `rnbo-inst-${instanceId}:shadowscore` : address,
      name: instanceId ? `ShadowScoreClient / shadowscore` : address,
      host: oscQuery.oscHost ?? rnbo.host,
      port: Number(oscQuery.oscPort ?? rnbo.port),
      address,
      instanceId,
      messagePath: address,
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
    voiceId: target.voiceId,
    clientId: target.clientId,
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
