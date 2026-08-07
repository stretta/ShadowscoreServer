import fs from "node:fs/promises";
import path from "node:path";
import { refreshRegistration } from "../registration-agent.mjs";
import { createOscQueryBonjourDiscovery } from "./bonjour-discovery.mjs";

export async function createCoordinatorManager(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const discovery = options.discovery ?? createOscQueryBonjourDiscovery({
    onError: (error) => console.error(`[coordinator] Bonjour discovery failed: ${messageForError(error)}`)
  });
  const register = options.register ?? ((sessionHostUrl, unitId) =>
    refreshRegistration(config, sessionHostUrl, unitId, { fetchImpl }));
  const statePath = path.resolve(config.coordinator?.statePath ?? "data/coordinator.json");
  const intervalMs = clampMs(config.registration?.heartbeatIntervalMs, 10000, 1000, 3600000);
  const probeTimeoutMs = clampMs(config.coordinator?.probeTimeoutMs, 1500, 100, 10000);
  const localId = stringField(config.server?.hostIdentity);
  const localName = stringField(config.server?.advertisedName) || localId;
  let state = await loadState();
  let timer;
  let closed = false;
  let registrationPending;
  let lastRegistrationAt = "";
  let lastRegistrationError = "";

  discovery.start();
  discovery.refresh();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  if (state.mode === "remote") void registerNow().catch(() => {});

  return {
    async snapshot(options = {}) {
      if (options.refresh) discovery.refresh();
      const candidates = await probeCandidates(discovery.snapshot());
      return {
        local: {
          id: localId,
          name: localName,
          url: localCoordinatorUrl(config, localId)
        },
        selection: structuredClone(state),
        registration: {
          active: state.mode === "remote",
          lastRegistrationAt,
          lastError: lastRegistrationError
        },
        candidates
      };
    },
    async select(document) {
      state = normalizeSelection(document, config, localId);
      await persistState(statePath, state);
      if (state.mode === "remote") await registerNow().catch(() => {});
      else {
        lastRegistrationAt = "";
        lastRegistrationError = "";
      }
      return this.snapshot({ refresh: true });
    },
    async claim() {
      state = localSelection(config, localId);
      await persistState(statePath, state);
      lastRegistrationAt = "";
      lastRegistrationError = "";
      discovery.refresh();
      const candidates = await probeCandidates(discovery.snapshot());
      const coordinatorUrl = state.coordinatorUrl;
      const results = await Promise.all(candidates
        .filter((candidate) => candidate.id !== localId && candidate.shadowscoreAvailable)
        .map(async (candidate) => {
          try {
            const response = await fetchWithTimeout(`${candidate.shadowscoreUrl}/coordinator/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "remote", coordinatorId: localId, coordinatorUrl })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            return { id: candidate.id, ok: true };
          } catch (error) {
            return { id: candidate.id, ok: false, error: messageForError(error) };
          }
        }));
      return { ...(await this.snapshot()), claimed: true, results };
    },
    refresh() {
      discovery.refresh();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      discovery.close();
    }
  };

  async function tick() {
    if (closed) return;
    discovery.refresh();
    if (state.mode === "remote") await registerNow().catch(() => {});
  }

  async function registerNow() {
    if (registrationPending) return registrationPending;
    registrationPending = register(state.coordinatorUrl, localId)
      .then(() => {
        lastRegistrationAt = new Date(now()).toISOString();
        lastRegistrationError = "";
      })
      .catch((error) => {
        lastRegistrationError = messageForError(error);
        throw error;
      })
      .finally(() => { registrationPending = undefined; });
    return registrationPending;
  }

  async function probeCandidates(candidates) {
    return Promise.all(candidates.map(async (candidate) => {
      try {
        const response = await fetchWithTimeout(`${candidate.shadowscoreUrl}/healthz`);
        return { ...candidate, shadowscoreAvailable: response.ok };
      } catch {
        return { ...candidate, shadowscoreAvailable: false };
      }
    }));
  }

  async function fetchWithTimeout(url, init = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
    return fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(probeTimeoutMs) });
  }

  async function loadState() {
    try {
      return normalizeSelection(JSON.parse(await fs.readFile(statePath, "utf8")), config, localId);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`[coordinator] could not load ${statePath}: ${messageForError(error)}`);
      const configuredUrl = stringField(config.registration?.sessionHostUrl);
      return configuredUrl
        ? normalizeSelection({ mode: "remote", coordinatorUrl: configuredUrl }, config, localId)
        : localSelection(config, localId);
    }
  }
}

function normalizeSelection(document, config, localId) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("coordinator selection must be an object");
  }
  const mode = stringField(document.mode).toLowerCase();
  if (mode === "local") return localSelection(config, localId);
  if (mode !== "remote") throw new Error("coordinator mode must be local or remote");
  const coordinatorUrl = normalizeHttpUrl(document.coordinatorUrl);
  const coordinatorId = stringField(document.coordinatorId) || hostnameId(coordinatorUrl);
  if (!coordinatorId) throw new Error("remote coordinator id is required");
  if (coordinatorId === localId) throw new Error("use local mode when this tree is the coordinator");
  return { mode: "remote", coordinatorId, coordinatorUrl };
}

function localSelection(config, localId) {
  return {
    mode: "local",
    coordinatorId: localId,
    coordinatorUrl: localCoordinatorUrl(config, localId)
  };
}

function localCoordinatorUrl(config, localId) {
  const configured = stringField(config.http?.publicUrl);
  if (configured) return normalizeHttpUrl(configured);
  return `http://${localId}.local:${Number(config.http?.port ?? 8790)}`;
}

function normalizeHttpUrl(value) {
  let url;
  try {
    url = new URL(stringField(value));
  } catch {
    throw new Error("coordinator URL must be a valid http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("coordinator URL must use http or https");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function hostnameId(url) {
  try {
    return new URL(url).hostname.replace(/\.local$/i, "").toLowerCase();
  } catch {
    return "";
  }
}

async function persistState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function clampMs(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
