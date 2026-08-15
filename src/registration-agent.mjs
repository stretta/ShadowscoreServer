#!/usr/bin/env node
import os from "node:os";
import { configuredRnboTargets, discoverRnboControlTargets, discoverRnboDevices, discoverRnboTargets } from "./adapters/rnbo-oscquery.mjs";
import { loadConfig } from "./config.mjs";
import { createOscQueryBonjourDiscovery } from "./coordinator/bonjour-discovery.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadConfig();
  await runRegistrationAgent(config, { once: process.argv.includes("--once") }).catch((error) => {
    console.error(`[registration-agent] ${messageForError(error)}`);
    process.exit(1);
  });
}

export async function runRegistrationAgent(config, options = {}) {
  const unitId = config.server?.hostIdentity || os.hostname();
  const intervalMs = clampMs(config.registration?.heartbeatIntervalMs, 10000, 1000, 3600000);
  const discoveryEnabled = config.registration?.discovery?.enabled !== false;
  const discovery = options.discovery ?? (discoveryEnabled
    ? createOscQueryBonjourDiscovery({
        onError: (error) => console.error(`[registration-agent] coordinator discovery failed: ${messageForError(error)}`)
      })
    : undefined);

  discovery?.start();
  discovery?.refresh();

  const refresh = async () => {
    const sessionHostUrl = await resolveSessionHostUrl(config, {
      discovery,
      fetchImpl: options.fetchImpl,
      wait: options.wait
    });
    await refreshRegistration(config, sessionHostUrl, unitId, options);
  };

  if (options.once) {
    try {
      return await refresh();
    } finally {
      discovery?.close();
    }
  }

  await refresh().catch((error) => {
    console.error(`[registration-agent] refresh failed: ${messageForError(error)}`);
  });

  setInterval(() => {
    void refresh().catch((error) => {
      console.error(`[registration-agent] refresh failed: ${messageForError(error)}`);
    });
  }, intervalMs);
}

export async function resolveSessionHostUrl(config, options = {}) {
  if (config.registration?.discovery?.enabled === false) {
    const configuredUrl = stripTrailingSlash(config.registration?.sessionHostUrl);
    if (!configuredUrl) {
      throw new Error("config.registration.sessionHostUrl is required when coordinator discovery is disabled");
    }
    return configuredUrl;
  }

  const discovery = options.discovery;
  if (!discovery) {
    throw new Error("coordinator discovery is enabled but unavailable");
  }

  const timeoutMs = clampMs(config.registration?.discovery?.timeoutMs, 5000, 0, 60000);
  const pollIntervalMs = clampMs(config.registration?.discovery?.pollIntervalMs, 200, 10, 5000);
  const deadline = Date.now() + timeoutMs;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastCandidateIds = [];

  while (true) {
    discovery.refresh();
    const candidates = discovery.snapshot();
    lastCandidateIds = candidates.map((candidate) => candidate.id).filter(Boolean);
    const authorities = await probeCoordinatorAuthorities(candidates, config, options.fetchImpl);
    if (authorities.length === 1) {
      return authorities[0].url;
    }
    if (authorities.length > 1) {
      throw new Error(`multiple coordinators discovered: ${authorities.map((authority) => authority.id).join(", ")}`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }

  const detail = lastCandidateIds.length > 0
    ? `; advertised birds: ${lastCandidateIds.join(", ")}`
    : "; no OSCQuery advertisements received";
  throw new Error(`no self-declared Shadowscore coordinator discovered${detail}`);
}

async function probeCoordinatorAuthorities(candidates, config, fetchImpl = globalThis.fetch) {
  const results = await Promise.all(candidates.map(async (candidate) => {
    for (const url of candidateCoordinatorUrls(candidate)) {
      try {
        const response = await fetchWithTimeout(`${url}/coordinator`, fetchImpl, config.registration?.discovery?.probeTimeoutMs);
        if (!response.ok) continue;
        const document = await response.json().catch(() => ({}));
        const localId = stringField(document.local?.id) || stringField(candidate.id);
        const selection = document.selection;
        if (selection?.mode === "local" && stringField(selection.coordinatorId) === localId) {
          return { id: localId, url };
        }
      } catch {
        // RNBO-only birds and temporarily unavailable hosts are not coordinators.
      }
    }
    return null;
  }));
  return results.filter(Boolean);
}

function candidateCoordinatorUrls(candidate) {
  const urls = [];
  const address = stringField(candidate?.address);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    urls.push(`http://${address}:8790`);
  }
  const advertisedUrl = stripTrailingSlash(candidate?.shadowscoreUrl);
  if (advertisedUrl && !urls.includes(advertisedUrl)) urls.push(advertisedUrl);
  return urls;
}

async function fetchWithTimeout(url, fetchImpl, timeoutValue) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const timeoutMs = clampMs(timeoutValue, 1500, 100, 10000);
  return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export async function refreshRegistration(config, sessionHostUrl, unitId, options = {}) {
  const targets = await readLocalTargets(config, unitId, options);
  const oscTargets = await readLocalOscTargets(config, unitId, options);
  const rnboDevices = await readLocalRnboDevices(config, unitId, options);
  if (targets.length > 0 || oscTargets.length > 0 || rnboDevices.length > 0) {
    return register(config, sessionHostUrl, unitId, { ...options, targets, oscTargets, rnboDevices });
  }
  return heartbeat(sessionHostUrl, unitId, options);
}

async function register(config, sessionHostUrl, unitId, options = {}) {
  const targets = options.targets ?? await readLocalTargets(config, unitId, options);
  const oscTargets = options.oscTargets ?? await readLocalOscTargets(config, unitId, options);
  const rnboDevices = options.rnboDevices ?? await readLocalRnboDevices(config, unitId, options);
  const body = {
    id: unitId,
    role: "peer",
    advertisedName: config.server?.advertisedName || unitId,
    hostIdentity: config.server?.hostIdentity || unitId,
    sessionHostUrl,
    heartbeatTtlMs: config.registration?.heartbeatTtlMs,
    rnboDevices,
    oscTargets,
    targets
  };
  const response = await postJson(`${sessionHostUrl}/hardware/register`, body, options.fetchImpl);
  console.log(`[registration-agent] registered ${unitId} with ${targets.length} target(s)`);
  return response;
}

export async function readLocalOscTargets(config, unitId = config.server?.hostIdentity || os.hostname(), options = {}) {
  const targets = await discoverRnboControlTargets(config, { fetchImpl: options.fetchImpl });
  const registrationHost = registrationTargetHost(config, unitId);
  return targets.map((target) => {
    const host = isLoopbackHost(target.host) ? registrationHost : target.host;
    return {
      ...target,
      host,
      hardwareUnitId: unitId,
      hardwareUnitName: config.server?.advertisedName || unitId
    };
  });
}

async function heartbeat(sessionHostUrl, unitId, options = {}) {
  await postJson(`${sessionHostUrl}/hardware/units/${encodeURIComponent(unitId)}/heartbeat`, {}, options.fetchImpl);
  console.log(`[registration-agent] heartbeat ${unitId}`);
}

export async function readLocalTargets(config, unitId = config.server?.hostIdentity || os.hostname(), options = {}) {
  const discovered = await discoverRnboTargets(config, { fetchImpl: options.fetchImpl });
  const targets = discovered.length > 0 ? discovered : configuredRnboTargets(config);
  const registrationHost = registrationTargetHost(config, unitId);
  return targets.map((target) => {
    const host = isLoopbackHost(target.host) ? registrationHost : target.host;
    return {
      ...target,
      host,
      hardwareUnitId: unitId,
      hardwareUnitName: config.server?.advertisedName || unitId
    };
  });
}

export async function readLocalRnboDevices(config, unitId = config.server?.hostIdentity || os.hostname(), options = {}) {
  const devices = await discoverRnboDevices(config, { fetchImpl: options.fetchImpl });
  const registrationHost = registrationTargetHost(config, unitId);
  return devices.map((device) => {
    const host = isLoopbackHost(device.host) ? registrationHost : device.host;
    return {
      ...device,
      id: device.id || unitId,
      host,
      graphEditorUrl: device.graphEditorUrl || (host ? `http://${host}:3000` : ""),
      oscQueryUrl: device.oscQueryUrl || (host ? `http://${host}:5678` : ""),
      hardwareUnitId: unitId,
      hardwareUnitName: config.server?.advertisedName || unitId
    };
  });
}

async function postJson(url, body, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`${url}: ${messageForError(error)}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function registrationTargetHost(config, unitId) {
  return stringField(config.rnbo?.oscQuery?.oscHost)
    || stringField(config.rnbo?.registrationHost)
    || `${unitId}.local`;
}

function isLoopbackHost(host) {
  const value = stringField(host).toLowerCase();
  return !value || value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function clampMs(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
