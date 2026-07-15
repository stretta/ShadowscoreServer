#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";

const options = parseOptions(process.argv.slice(2));
const baseUrl = new URL(options.baseUrl);
const oscQueryUrl = new URL(options.oscQueryUrl || `${baseUrl.protocol}//${baseUrl.hostname}:5678`);
const prefix = `snapshot-measure-${Date.now()}`;
const createdRoles = [];
const originalState = new Map();
let blockId = options.blockId;

try {
  const transport = await requestJson("/transport");
  if (transport.latest?.state !== "stopped" && !options.allowRunning) {
    throw new Error(`transport must be stopped (reported '${transport.latest?.state || "unknown"}')`);
  }
  let score = await requestJson("/score");
  blockId ||= score.structureState?.activeBlockId || Object.keys(score.mesostructure || {})[0];
  if (!score.mesostructure?.[blockId]) throw new Error(`unknown measurement block '${blockId}'`);

  const targetDocument = await requestJson("/osc/targets?status=online");
  const targets = selectTargets(targetDocument.targets || []);
  if (targets.length < 2) throw new Error("at least two supported live sequencers are required");

  for (const target of targets) originalState.set(target.id, await captureTarget(target));

  for (const target of targets) {
    const roleId = `${prefix}-${target.app}-${target.instance}`;
    score = await requestJson(`/osc/assignments/${encodeURIComponent(roleId)}`, {
      method: "PUT",
      body: {
        expectedScoreRevision: score.scoreRevision,
        label: `Snapshot measurement ${target.label}`,
        app: target.app,
        deviceId: target.deviceId,
        oscTargetId: target.id,
        locked: true,
        ignoreRecall: false
      }
    });
    createdRoles.push({ roleId, target });
  }

  for (const { roleId, target } of createdRoles) {
    score = await requestJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-snapshots/${encodeURIComponent(roleId)}`, {
      method: "PUT",
      body: {
        expectedStructureRevision: score.structureRevision,
        ...denseSnapshot(target, options.listLength)
      }
    });
  }

  const roles = createdRoles.map(({ roleId }) => roleId);
  const dryRun = await requestJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-snapshots/recall`, {
    method: "POST",
    body: { roles, dryRun: true }
  });
  const recalls = [];
  for (let index = 0; index < options.runs; index += 1) {
    recalls.push(await requestJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-snapshots/recall`, {
      method: "POST",
      body: { roles }
    }));
  }

  process.stdout.write(`${JSON.stringify({
    baseUrl: baseUrl.href,
    oscQueryUrl: oscQueryUrl.href,
    blockId,
    runCount: recalls.length,
    targets: targets.map(({ id, app, instance, label }) => ({ id, app, instance, label })),
    dryRun: compactRecall(dryRun),
    summary: summarizeRecalls(recalls),
    recalls: recalls.map(compactRecall)
  }, null, 2)}\n`);
} finally {
  await restoreAndCleanup().catch((error) => {
    process.stderr.write(`cleanup failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}

async function captureTarget(target) {
  const params = Object.fromEntries((target.parameters || []).map((param) => [param.name, param.value]));
  const inputPorts = {};
  for (const inputPort of target.inputPorts || []) {
    if (isMomentary(inputPort.name)) continue;
    await requestJson("/osc/send", { method: "POST", body: { targets: [target.id], inputPort: inputPort.name, args: [-999] } });
    await delay(90);
    const ackName = ackNameFor(inputPort.name);
    const response = await fetch(new URL(`${target.baseAddress}/messages/out/${ackName}`, oscQueryUrl));
    if (!response.ok) throw new Error(`${target.id} ${ackName} read failed (${response.status})`);
    const document = await response.json();
    inputPorts[inputPort.name] = asList(document.VALUE);
  }
  return { params, inputPorts };
}

function denseSnapshot(target, listLength) {
  const params = {};
  for (const param of target.parameters || []) {
    if (Array.isArray(param.values) && param.values.length) {
      const choices = Array.from(new Set(param.values.map(String)));
      params[param.name] = Math.max(0, choices.indexOf(String(param.value)));
    } else if (Number.isFinite(Number(param.value))) {
      params[param.name] = Number(param.value);
    }
  }
  if (Object.hasOwn(params, "Clock")) params.Clock = 0;
  const inputPorts = {};
  let row = 0;
  for (const inputPort of target.inputPorts || []) {
    if (isMomentary(inputPort.name)) continue;
    inputPorts[inputPort.name] = Array.from({ length: listLength }, (_, index) => (index + row) % 16);
    row += 1;
  }
  return { schemaVersion: 1, app: target.app, params, inputPorts };
}

async function restoreAndCleanup() {
  for (const { target } of createdRoles) {
    const saved = originalState.get(target.id);
    if (!saved) continue;
    for (const [name, value] of Object.entries(saved.params).filter(([name]) => name !== "Clock")) {
      await requestJson("/osc/send", { method: "POST", body: { targets: [target.id], param: name, args: [value] } });
    }
    for (const [name, values] of Object.entries(saved.inputPorts)) {
      await requestJson("/osc/send", { method: "POST", body: { targets: [target.id], inputPort: name, args: values } });
    }
    if (Object.hasOwn(saved.params, "Clock")) {
      await requestJson("/osc/send", { method: "POST", body: { targets: [target.id], param: "Clock", args: [saved.params.Clock] } });
    }
  }
  let score = await requestJson("/score");
  for (const { roleId } of [...createdRoles].reverse()) {
    if (score.mesostructure?.[blockId]?.oscSnapshots?.[roleId]) {
      score = await requestJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-snapshots/${encodeURIComponent(roleId)}?expectedStructureRevision=${score.structureRevision}`, { method: "DELETE" });
    }
  }
  for (const { roleId } of [...createdRoles].reverse()) {
    if (score.oscAssignments?.[roleId]) {
      score = await requestJson(`/osc/assignments/${encodeURIComponent(roleId)}?expectedScoreRevision=${score.scoreRevision}`, { method: "DELETE" });
    }
  }
}

function selectTargets(targets) {
  const supported = targets.filter((target) => ["analogsequencer", "listsequencer", "listvelsequencer"].includes(target.app));
  return supported.sort((left, right) => left.app.localeCompare(right.app) || String(left.instance).localeCompare(String(right.instance)));
}

function compactRecall(recall) {
  return {
    id: recall.id,
    plannedWriteCount: recall.plannedWriteCount,
    attemptedWriteCount: recall.attemptedWriteCount,
    failedWriteCount: recall.failedWriteCount,
    plannedPacketBytes: recall.plannedPacketBytes,
    attemptedPacketBytes: recall.attemptedPacketBytes,
    dispatchDurationMs: recall.dispatchDurationMs,
    durationMs: recall.durationMs
  };
}

function summarizeRecalls(recalls) {
  const durations = recalls.map((recall) => recall.dispatchDurationMs).sort((a, b) => a - b);
  return {
    minDispatchMs: durations[0] ?? 0,
    medianDispatchMs: percentile(durations, 0.5),
    p95DispatchMs: percentile(durations, 0.95),
    maxDispatchMs: durations.at(-1) ?? 0,
    failedWriteCount: recalls.reduce((sum, recall) => sum + recall.failedWriteCount, 0),
    attemptedPacketBytes: recalls.reduce((sum, recall) => sum + recall.attemptedPacketBytes, 0)
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

async function requestJson(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const document = await response.json().catch(() => ({}));
  if (!response.ok || document.ok === false) throw new Error(document.error || `${options.method || "GET"} ${path}: ${response.status}`);
  return document;
}

function isMomentary(name) {
  return ["get", "panic", "probe", "reset", "rtz", "setstage"].includes(String(name).toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function ackNameFor(name) {
  return /^4(?:ow|row)$/i.test(String(name)) ? "4rowAck" : `${name}Ack`;
}

function asList(value) {
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry !== undefined && entry !== null).map(Number);
}

function parseOptions(args) {
  const result = { baseUrl: "http://wren.local:8790", oscQueryUrl: "", blockId: "", runs: 20, listLength: 128, allowRunning: false };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--allow-running") result.allowRunning = true;
    else if (name === "--base-url") result.baseUrl = required(args[++index], name);
    else if (name === "--oscquery-url") result.oscQueryUrl = required(args[++index], name);
    else if (name === "--block") result.blockId = required(args[++index], name);
    else if (name === "--runs") result.runs = positiveInteger(args[++index], name);
    else if (name === "--list-length") result.listLength = positiveInteger(args[++index], name);
    else throw new Error(`unknown option '${name}'`);
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}
