import fs from "node:fs/promises";
import path from "node:path";
import {
  extractRnboControlTargets,
  extractRnboDevices,
  extractRnboTargets,
  fetchOscQueryTree
} from "../adapters/rnbo-oscquery.mjs";

export function createManualOscQueryDeviceRegistry(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const filePath = path.resolve(config.oscQuery?.manualDevicesPath ?? "data/oscquery-devices.json");
  const refreshIntervalMs = clampMs(config.oscQuery?.refreshIntervalMs, 5000, 250, 300000);
  let loaded = false;
  let devices = [];
  let refreshPromise;

  return {
    async list(options = {}) {
      await load();
      await refresh({ force: options.refresh === true });
      return devices.map(publicDevice);
    },
    async probe(document) {
      const candidate = normalizeDevice(document);
      return publicDevice(await queryDevice(candidate));
    },
    async save(document) {
      await load();
      const candidate = normalizeDevice(document);
      if (devices.some((device) => device.id === candidate.id)) {
        throw new Error(`OSCQuery device '${candidate.id}' already exists`);
      }
      const queried = await queryDevice(candidate);
      devices.push(queried);
      await persist();
      return publicDevice(queried);
    },
    async update(deviceId, document) {
      await load();
      const index = findIndex(deviceId);
      const existing = devices[index];
      const candidate = normalizeDevice({ ...existing, ...document, id: existing.id });
      const queried = await queryDevice(candidate);
      devices[index] = queried;
      await persist();
      return publicDevice(queried);
    },
    async remove(deviceId) {
      await load();
      const index = findIndex(deviceId);
      const [removed] = devices.splice(index, 1);
      await persist();
      return publicDevice(removed);
    },
    async refresh(deviceId) {
      await load();
      if (deviceId) {
        const index = findIndex(deviceId);
        devices[index] = await queryDevice(devices[index], { retainOnFailure: true });
        return publicDevice(devices[index]);
      }
      await refresh({ force: true });
      return devices.map(publicDevice);
    },
    async rnboTargets() {
      await load();
      await refresh();
      return devices.flatMap((device) => annotateTargets(device, device.rnboTargets));
    },
    async oscTargets() {
      await load();
      await refresh();
      return devices.flatMap((device) => annotateTargets(device, device.oscTargets));
    },
    async rnboDevices() {
      await load();
      await refresh();
      return devices.flatMap((device) => (device.rnboDevices ?? []).map((entry) => ({
        ...entry,
        id: `${device.id}:${entry.id}`,
        localId: entry.id,
        name: device.name,
        source: "manual-oscquery",
        hardwareUnitId: device.id,
        hardwareUnitName: device.name,
        available: device.status === "online",
        unitStatus: device.status
      })));
    }
  };

  async function load() {
    if (loaded) return;
    try {
      const document = JSON.parse(await fs.readFile(filePath, "utf8"));
      devices = Array.isArray(document.devices)
        ? document.devices.map((device) => ({ ...normalizeDevice(device), status: "unknown", lastError: "", lastSeenAt: "", lastCheckedAt: "", rnboTargets: [], oscTargets: [], rnboDevices: [] }))
        : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      devices = [];
    }
    loaded = true;
  }

  async function refresh(options = {}) {
    const timestamp = now();
    const stale = options.force || devices.some((device) => !device.checkedAtMs || timestamp - device.checkedAtMs >= refreshIntervalMs);
    if (!stale || devices.length === 0) return;
    if (!refreshPromise) {
      refreshPromise = Promise.all(devices.map((device) => queryDevice(device, { retainOnFailure: true })))
        .then((next) => { devices = next; })
        .finally(() => { refreshPromise = undefined; });
    }
    await refreshPromise;
  }

  async function queryDevice(device, queryOptions = {}) {
    const checkedAtMs = now();
    try {
      const tree = await fetchOscQueryTree({ url: device.oscQueryUrl, timeoutMs: device.timeoutMs }, fetchImpl);
      const deviceConfig = configForDevice(config, device);
      return {
        ...device,
        status: "online",
        lastError: "",
        lastSeenAt: new Date(checkedAtMs).toISOString(),
        lastCheckedAt: new Date(checkedAtMs).toISOString(),
        checkedAtMs,
        rnboTargets: extractRnboTargets(tree, deviceConfig),
        oscTargets: extractRnboControlTargets(tree, deviceConfig),
        rnboDevices: extractRnboDevices(tree, deviceConfig)
      };
    } catch (error) {
      if (!queryOptions.retainOnFailure) throw error;
      return {
        ...device,
        status: "offline",
        lastError: error?.message ?? String(error),
        lastCheckedAt: new Date(checkedAtMs).toISOString(),
        checkedAtMs
      };
    }
  }

  function findIndex(deviceId) {
    const id = stringField(deviceId);
    const index = devices.findIndex((device) => device.id === id);
    if (index === -1) throw new Error(`unknown OSCQuery device '${id}'`);
    return index;
  }

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify({ devices: devices.map(storedDevice) }, null, 2)}\n`);
  }
}

function normalizeDevice(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OSCQuery device body must be an object");
  }
  const endpoint = normalizeEndpoint(document.oscQueryUrl ?? document.url ?? document.host ?? document.hostname);
  const host = stringField(document.oscHost) || endpoint.hostname;
  const name = stringField(document.name ?? document.label) || host;
  const id = slug(document.id) || slug(name) || slug(host);
  if (!id) throw new Error("OSCQuery device id or hostname is required");
  const oscPort = portNumber(document.oscPort, 1234, "OSC port");
  const timeoutMs = clampMs(document.timeoutMs, 1000, 100, 10000);
  return { id, name, host, oscQueryUrl: endpoint.url, oscPort, timeoutMs };
}

function normalizeEndpoint(value) {
  const raw = stringField(value);
  if (!raw) throw new Error("OSCQuery hostname or URL is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("OSCQuery hostname or URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OSCQuery URL must use http or https");
  }
  if (!url.port) url.port = "5678";
  if (!url.pathname) url.pathname = "/";
  return { url: url.toString(), hostname: url.hostname };
}

function configForDevice(config, device) {
  return {
    ...config,
    server: { ...(config.server ?? {}), hostIdentity: device.id, advertisedName: device.name },
    rnbo: {
      ...(config.rnbo ?? {}),
      enabled: true,
      host: device.host,
      port: device.oscPort,
      oscQuery: {
        ...(config.rnbo?.oscQuery ?? {}),
        enabled: true,
        url: device.oscQueryUrl,
        oscHost: device.host,
        oscPort: device.oscPort
      }
    }
  };
}

function annotateTargets(device, targets = []) {
  return targets.map((target) => ({
    ...target,
    id: `${device.id}:${target.id}`,
    localId: target.id,
    source: "manual-oscquery",
    hardwareUnitId: device.id,
    hardwareUnitName: device.name,
    available: device.status === "online" && target.available !== false,
    unitStatus: device.status
  }));
}

function publicDevice(device) {
  const instances = new Map();
  for (const target of [...(device.oscTargets ?? []), ...(device.rnboTargets ?? [])]) {
    const key = String(target.instanceId ?? target.id);
    if (!instances.has(key)) instances.set(key, {
      id: key,
      name: target.name ?? target.label ?? key,
      app: target.app ?? (target.address?.includes("shadowscore") ? "shadowscore" : "rnbo")
    });
  }
  return {
    id: device.id,
    name: device.name,
    host: device.host,
    oscQueryUrl: device.oscQueryUrl,
    oscPort: device.oscPort,
    timeoutMs: device.timeoutMs,
    status: device.status ?? "unknown",
    source: "manual",
    lastSeenAt: device.lastSeenAt ?? "",
    lastCheckedAt: device.lastCheckedAt ?? "",
    lastError: device.lastError ?? "",
    instances: Array.from(instances.values())
  };
}

function storedDevice(device) {
  return {
    id: device.id,
    name: device.name,
    oscQueryUrl: device.oscQueryUrl,
    oscHost: device.host,
    oscPort: device.oscPort,
    timeoutMs: device.timeoutMs
  };
}

function portNumber(value, fallback, label) {
  const port = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return port;
}

function clampMs(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function slug(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
