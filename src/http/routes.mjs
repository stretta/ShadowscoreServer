import { adminPage } from "./admin-page.mjs";
import { serveStaticAsset } from "./static-files.mjs";
import { compileScoreTransaction } from "../adapters/rnbo-osc.mjs";
import { configuredRnboTargets, discoverRnboTargets, writeRnboTransportParams } from "../adapters/rnbo-oscquery.mjs";
import { createLocalHardwareUnit } from "../registration/peer-registry.mjs";
import { createSessionSnapshot } from "../session.mjs";

export async function routeRequest(request, response, store, config, runtime = {}) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      ensembleId: config.ensemble.id,
      version: store.getScore().version,
      rnbo: {
        enabled: config.rnbo.enabled,
        host: config.rnbo.host,
        port: config.rnbo.port
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/score") {
    writeJson(response, 200, store.getScore());
    return;
  }

  if (request.method === "GET" && url.pathname === "/session") {
    const sessionRuntime = await readSessionRuntime(config, runtime);
    writeJson(response, 200, createSessionSnapshot(store.getScore(), config, request, sessionRuntime));
    return;
  }

  if (request.method === "GET" && url.pathname === "/rnbo/targets") {
    writeJson(response, 200, { targets: await readAllRnboTargets(config, runtime) });
    return;
  }

  const rnboParamsMatch = url.pathname.match(/^\/rnbo\/targets\/([^/]+)\/params$/);
  if (request.method === "POST" && rnboParamsMatch) {
    try {
      const targetId = decodeURIComponent(rnboParamsMatch[1]);
      const target = await findRnboTarget(config, runtime, targetId);
      if (!target) {
        throw new Error(`unknown RNBO target '${targetId}'`);
      }
      const body = await readJson(request);
      const params = body.params ?? body;
      const preparedParams = prepareRnboTransportParams(store.getScore(), config, target, params);
      const writes = await writeRnboTransportParams(config, target, preparedParams, {
        writer: runtime.rnboParamWriter
      });
      writeJson(response, 200, { ok: true, targetId, writes });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/hardware/units") {
    writeJson(response, 200, { hardwareUnits: await readHardwareUnits(config, runtime) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/hardware/register") {
    try {
      const registry = requirePeerRegistry(runtime);
      const unit = registry.register(await readJson(request), { remoteAddress: request.socket?.remoteAddress ?? "" });
      writeJson(response, 200, { ok: true, unit, heartbeatTtlMs: registry.heartbeatTtlMs });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const heartbeatMatch = url.pathname.match(/^\/hardware\/units\/([^/]+)\/heartbeat$/);
  if (request.method === "POST" && heartbeatMatch) {
    try {
      const registry = requirePeerRegistry(runtime);
      const unit = registry.heartbeat(decodeURIComponent(heartbeatMatch[1]), { remoteAddress: request.socket?.remoteAddress ?? "" });
      writeJson(response, 200, { ok: true, unit });
    } catch (error) {
      writeJson(response, 404, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/assignments") {
    writeJson(response, 200, store.getScore().assignments ?? {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    writeHtml(response, 200, adminPage());
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    openEventStream(request, response, store);
    return;
  }

  if (request.method === "POST" && url.pathname === "/context") {
    try {
      const body = await readJson(request);
      const replace = url.searchParams.get("replace") === "1";
      writeJson(response, 200, store.updateContext(body.context ?? body, { replace }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/voices") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.addVoice(body.voiceId ?? body.id, body.assignment ?? {}, {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/reset") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.reset({
        context: Boolean(body.context),
        voices: Boolean(body.voices),
        assignments: Boolean(body.assignments)
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/backup") {
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    response.writeHead(200, {
      "Content-Disposition": `attachment; filename="shadowscore-${store.getScore().ensembleId}-${now}.json"`,
      "Content-Type": "application/json"
    });
    response.end(`${JSON.stringify(store.getScore(), null, 2)}\n`);
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/restore") {
    try {
      writeJson(response, 200, store.restore(await readJson(request)));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/assignment-preset") {
    try {
      const body = await readJson(request);
      const presetId = String(body.presetId ?? "");
      const preset = config.ensemble?.assignmentPresets?.[presetId];
      if (!preset) {
        throw new Error(`unknown assignment preset '${presetId}'`);
      }
      writeJson(response, 200, store.applyAssignmentPreset(preset.assignments ?? {}, { presetId }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const assignmentMatch = url.pathname.match(/^\/voices\/([^/]+)\/assignment$/);
  if ((request.method === "POST" || request.method === "DELETE") && assignmentMatch) {
    try {
      const voiceId = decodeURIComponent(assignmentMatch[1]);
      const score =
        request.method === "DELETE"
          ? store.clearVoiceAssignment(voiceId)
          : store.replaceVoiceAssignment(voiceId, await readJson(request));
      writeJson(response, 200, score);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const deleteVoiceMatch = url.pathname.match(/^\/voices\/([^/]+)$/);
  if (request.method === "DELETE" && deleteVoiceMatch) {
    try {
      const voiceId = decodeURIComponent(deleteVoiceMatch[1]);
      writeJson(response, 200, store.removeVoice(voiceId));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const voiceMatch = url.pathname.match(/^\/voices\/([^/]+)\/notes$/);
  if (request.method === "POST" && voiceMatch) {
    try {
      const voiceId = decodeURIComponent(voiceMatch[1]);
      const body = await readJson(request);
      writeJson(response, 200, store.replaceVoiceNotes(voiceId, body, {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion"),
        expectedVoiceVersion: optionalInteger(body.expectedVoiceVersion, "expectedVoiceVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && await serveStaticAsset(url, response, config)) {
    return;
  }

  writeJson(response, 404, { ok: false, error: "not found" });
}

export function writeJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

export function writeHtml(response, status, html) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

export async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function openEventStream(request, response, store) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });

  writeEvent(response, "snapshot", {
    type: "snapshot",
    score: store.getScore()
  });

  const onChange = (event) => writeEvent(response, event.type, event);
  store.events.on("change", onChange);

  request.on("close", () => {
    store.events.off("change", onChange);
  });
}

function writeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "DELETE,GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Origin", "*");
}

async function readRnboTargets(config) {
  const discovered = await discoverRnboTargets(config);
  return discovered.length > 0 ? discovered : configuredRnboTargets(config);
}

async function readSessionRuntime(config, runtime) {
  const localTargets = await readRnboTargets(config);
  const localUnit = createLocalHardwareUnit(config, localTargets);
  const peerUnits = runtime.peerRegistry?.snapshot?.() ?? [];
  const peerTargets = runtime.peerRegistry?.targets?.() ?? [];
  return {
    rnboTargets: [...localUnit.targets, ...peerTargets],
    hardwareUnits: [localUnit, ...peerUnits]
  };
}

async function readAllRnboTargets(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.rnboTargets;
}

async function findRnboTarget(config, runtime, targetId) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.find((target) => target.id === targetId);
}

function prepareRnboTransportParams(score, config, target, params) {
  const entries = Object.entries(params ?? {});
  const assignedVoiceId = assignedVoiceForTarget(score, target);
  const prepared = new Map(entries);

  if (assignedVoiceId) {
    const compiled = compileScoreTransaction(score, config, 0, { ...target, voiceId: assignedVoiceId });
    prepared.set("MaxSteps", compiled.patternLength);
  }

  if (prepared.has("Clock")) {
    const clock = prepared.get("Clock");
    prepared.delete("Clock");
    prepared.set("Clock", clock);
  }

  return Object.fromEntries(prepared);
}

function assignedVoiceForTarget(score, target) {
  for (const [voiceId, assignment] of Object.entries(score.assignments ?? {})) {
    if (!assignment?.rnboAddress) {
      continue;
    }
    const targetIds = new Set([target.id, target.localId].filter(Boolean));
    if (targetIds.has(assignment.rnboTargetId)) {
      return voiceId;
    }
    if (
      assignment.rnboAddress === target.address &&
      String(assignment.rnboHost || "") === String(target.host || "") &&
      Number(assignment.rnboPort) === Number(target.port)
    ) {
      return voiceId;
    }
  }
  return "";
}

async function readHardwareUnits(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.hardwareUnits;
}

function requirePeerRegistry(runtime) {
  if (!runtime.peerRegistry) {
    throw new Error("peer registration registry is not available");
  }
  return runtime.peerRegistry;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}

function optionalInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`${field} must be an integer`);
  }
  return number;
}
