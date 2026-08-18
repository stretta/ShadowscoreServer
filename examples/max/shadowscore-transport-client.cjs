/* Node for Max adapter for the authoritative ShadowScore transport object. */
const maxApi = require("max-api");
const http = require("node:http");
const https = require("node:https");

let baseUrl = "http://wren.local:8790";
let objectId = "transport";
let observerRequest = null;

maxApi.addHandler("host", (value) => {
  baseUrl = normalizeBaseUrl(value);
  maxApi.outlet("host", baseUrl);
});

maxApi.addHandler("path", async (...parts) => {
  const path = parts.join(" ").trim() || "transport";
  try {
    const body = await requestJson("GET", `/api/v1/objects/resolve?path=${encodeURIComponent(path)}`);
    objectId = body.object.id;
    maxApi.outlet("path", objectId, body.object.type, JSON.stringify(body.object));
  } catch (error) {
    reportError(error);
  }
});

maxApi.addHandler("get", async () => {
  try {
    outletState((await requestJson("GET", objectPath())).object);
  } catch (error) {
    reportError(error);
  }
});

maxApi.addHandler("call", async (operation, ...atoms) => {
  try {
    const args = parseArgs(atoms);
    const body = await requestJson("POST", objectPath(), {
      operation: String(operation || ""),
      args,
      client_id: "max-node-transport",
      request_id: `${Date.now()}-${operation}`
    });
    maxApi.outlet("result", body.operation, JSON.stringify(body.result ?? {}));
    outletState(body.object);
  } catch (error) {
    reportError(error);
  }
});

maxApi.addHandler("observe", (enabled = 1) => {
  if (Number(enabled)) startObserver();
  else stopObserver();
});

maxApi.addHandler("bang", async () => {
  try {
    outletState((await requestJson("GET", objectPath())).object);
  } catch (error) {
    reportError(error);
  }
});

function startObserver() {
  stopObserver();
  const url = new URL(`${baseUrl}${objectPath()}/events`);
  const client = url.protocol === "https:" ? https : http;
  const request = client.request(url, { headers: { Accept: "text/event-stream" } });
  observerRequest = request;
  let buffer = "";
  request.on("response", (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (!data) continue;
        try {
          outletState(JSON.parse(data));
        } catch (error) {
          reportError(error);
        }
      }
    });
    response.on("end", () => {
      if (observerRequest === request) maxApi.outlet("observer", "disconnected");
    });
  });
  request.on("error", reportError);
  request.end();
  maxApi.outlet("observer", "connecting", url.href);
}

function stopObserver() {
  if (observerRequest) observerRequest.destroy();
  observerRequest = null;
  maxApi.outlet("observer", "stopped");
}

function objectPath() {
  return `/api/v1/objects/${encodeURIComponent(objectId)}`;
}

function outletState(state) {
  if (!state) return;
  maxApi.outlet("state", JSON.stringify(state));
  maxApi.outlet("playing", Number(Boolean(state.is_playing)));
  maxApi.outlet("position_beats", Number(state.position_beats) || 0);
  maxApi.outlet("position_seconds", Number(state.position_seconds) || 0);
  maxApi.outlet("position_bbt", state.position_bbt || "1.1.000");
  maxApi.outlet("tempo", Number(state.tempo) || 0);
  maxApi.outlet("section", state.active_section || "");
  maxApi.outlet("sync", state.sync?.state || "unknown", Number(state.sync?.max_phase_error_beats) || 0);
}

function requestJson(method, path, body) {
  const url = new URL(`${baseUrl}${path}`);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          const parsed = text ? JSON.parse(text) : {};
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(parsed.error || `HTTP ${response.statusCode}`);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function parseArgs(atoms) {
  if (!atoms.length) return {};
  const text = atoms.join(" ");
  try {
    return JSON.parse(text);
  } catch {
    if (atoms.length === 2) return { [String(atoms[0])]: atoms[1] };
    return { value: atoms.length === 1 ? atoms[0] : atoms };
  }
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text) throw new Error("host requires a URL or hostname");
  return /^https?:\/\//.test(text) ? text : `http://${text.includes(":") ? text : `${text}:8790`}`;
}

function reportError(error) {
  maxApi.outlet("error", error?.message || String(error));
}

process.on("exit", stopObserver);
