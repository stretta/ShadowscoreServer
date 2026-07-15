import { sendOscMessage } from "./send.mjs";
import { snapshotControlDisposition } from "./snapshot-contract.mjs";

const LIST_READBACK_APPS = new Set(["listsequencer", "listvelsequencer"]);

export async function captureOscTarget(target, options = {}) {
  if (!target?.id) throw new Error("OSC capture requires one normalized target");
  if (target.status !== "online") throw new Error(`OSC target '${target.id}' is ${target.status || "unavailable"}`);
  if (!target.baseAddress) throw new Error(`OSC target '${target.id}' has no RNBO base address`);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("OSC capture requires fetch");

  const diagnostics = [];
  const params = await captureParameters(target, fetchImpl, diagnostics, options);
  const inputPorts = await captureInputPorts(target, fetchImpl, diagnostics, options);
  const complete = diagnostics.every((entry) => entry.severity !== "error");
  if (!complete && !options.allowIncomplete) {
    const error = new Error(`OSC capture from '${target.id}' is incomplete`);
    error.code = "OSC_CAPTURE_INCOMPLETE";
    error.diagnostics = diagnostics;
    throw error;
  }
  return {
    clip: {
      name: stringField(options.name),
      schemaVersion: 1,
      app: target.app,
      params,
      inputPorts,
      capture: {
        deviceId: target.deviceId || target.unitId || "",
        targetId: target.id,
        capturedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        complete,
        diagnostics
      }
    },
    complete,
    diagnostics
  };
}

async function captureParameters(target, fetchImpl, diagnostics, options) {
  const body = await fetchJson(oscQueryUrl(target, `${target.baseAddress}/params`), fetchImpl, options.timeoutMs);
  const nodes = body?.CONTENTS ?? {};
  const params = {};
  for (const param of target.parameters ?? []) {
    const disposition = snapshotControlDisposition({ kind: "param", name: param.name, meta: param.meta });
    if (disposition.state === "excluded") continue;
    const liveName = addressTail(param.address) || param.name;
    const node = nodes[param.name] ?? nodes[liveName];
    const value = scalar(node?.VALUE ?? param.value);
    const normalized = normalizeParamValue(param, value);
    if (normalized.ok) params[param.name] = normalized.value;
    else diagnostics.push({ severity: "error", kind: "param", name: param.name, reason: normalized.reason });
  }
  return params;
}

async function captureInputPorts(target, fetchImpl, diagnostics, options) {
  const ports = (target.inputPorts ?? []).filter((port) =>
    snapshotControlDisposition({ kind: "inputPort", name: port.name, meta: port.meta }).state !== "excluded"
  );
  if (ports.length === 0) return {};
  if (!LIST_READBACK_APPS.has(target.app)) {
    for (const port of ports) diagnostics.push({ severity: "error", kind: "inputPort", name: port.name, reason: "unsupported-readback" });
    return {};
  }
  const sender = options.sender;
  const inputPorts = {};
  for (const port of ports) {
    try {
      await sendOscMessage(target, port.address, [-999], { sender });
      await (options.delay ?? delay)(options.readbackDelayMs ?? 75);
      const ackPath = readbackPath(target, port);
      const body = await fetchJson(oscQueryUrl(target, ackPath), fetchImpl, options.timeoutMs);
      const values = numericList(body?.VALUE);
      if (!values) throw new Error("ACK was not a numeric list");
      inputPorts[port.name] = values;
    } catch (error) {
      diagnostics.push({ severity: "error", kind: "inputPort", name: port.name, reason: "readback-failed", message: messageForError(error) });
    }
  }
  return inputPorts;
}

function normalizeParamValue(param, value) {
  if (param.type === "s" && Array.isArray(param.values) && param.values.length) {
    const index = param.values.map(String).indexOf(String(value));
    return index >= 0 ? { ok: true, value: index } : { ok: false, reason: "unknown-enum-value" };
  }
  const number = Number(value);
  return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, reason: "non-numeric-value" };
}

function readbackPath(target, port) {
  const liveName = addressTail(port.address) || port.name;
  const ackName = target.app === "listvelsequencer" && /^(\d+)row$/i.test(port.name)
    ? `${port.name.match(/^(\d+)/)[1]}rowAck`
    : `${liveName}Ack`;
  return `${target.baseAddress}/messages/out/${ackName}`;
}

function oscQueryUrl(target, path) {
  const base = stringField(target.oscQueryUrl) || `http://${target.host}:5678`;
  return `${base.replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
}

async function fetchJson(url, fetchImpl, timeoutMs = 1500) {
  const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) throw new Error(`OSCQuery returned HTTP ${response?.status ?? "unknown"}`);
  return response.json();
}

function scalar(value) {
  return Array.isArray(value) ? value[0] : value;
}

function numericList(value) {
  const values = Array.isArray(value) ? value : value === undefined ? null : [value];
  return values && values.every(Number.isFinite) ? values.map(Number) : null;
}

function addressTail(address) {
  return decodeURIComponent(String(address || "").split("/").filter(Boolean).at(-1) || "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
