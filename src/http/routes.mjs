import { adminPage } from "./admin-page.mjs";
import { serveStaticAsset } from "./static-files.mjs";
import { compileScoreTransaction } from "../adapters/rnbo-osc.mjs";
import { configuredRnboTargets, discoverRnboTargets, writeRnboTransportParams } from "../adapters/rnbo-oscquery.mjs";
import { createLocalHardwareUnit } from "../registration/peer-registry.mjs";
import { createSessionSnapshot } from "../session.mjs";
import { deleteScoreFromLibrary, listSavedScores, loadScoreFromLibrary, saveScoreToLibrary } from "../state/persistence.mjs";

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

  if (request.method === "GET" && url.pathname === "/playback/timing-contracts") {
    writeJson(response, 200, {
      contracts: await readPlaybackTimingContracts(store.getScore(), config, runtime)
    });
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
      rememberRnboTransportParams(config, preparedParams);
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

  if (request.method === "GET" && url.pathname === "/clips") {
    writeJson(response, 200, store.getScore().clips ?? {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/structure") {
    const score = store.getScore();
    writeJson(response, 200, {
      clips: score.clips ?? {},
      mesostructure: score.mesostructure ?? {},
      macrostructure: score.macrostructure ?? {},
      structureState: score.structureState ?? {}
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/structure/playhead") {
    writeJson(response, 200, store.getScore().structureState ?? {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/macrostructure/playback") {
    writeJson(response, 200, macroPlaybackSnapshot(runtime, store));
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
        assignments: Boolean(body.assignments),
        structure: Boolean(body.structure)
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

  if (request.method === "GET" && url.pathname === "/admin/scores") {
    try {
      writeJson(response, 200, { scores: await listSavedScores(config) });
    } catch (error) {
      writeJson(response, 500, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/scores") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, { ok: true, score: await saveScoreToLibrary(config, store.getScore(), { name: body.name }) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const savedScoreLoadMatch = url.pathname.match(/^\/admin\/scores\/([^/]+)\/load$/);
  if (request.method === "POST" && savedScoreLoadMatch) {
    try {
      const snapshot = await loadScoreFromLibrary(config, decodeURIComponent(savedScoreLoadMatch[1]));
      writeJson(response, 200, store.restore(snapshot));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const savedScoreMatch = url.pathname.match(/^\/admin\/scores\/([^/]+)$/);
  if (request.method === "DELETE" && savedScoreMatch) {
    try {
      await deleteScoreFromLibrary(config, decodeURIComponent(savedScoreMatch[1]));
      writeJson(response, 200, { ok: true, scores: await listSavedScores(config) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
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

  if (request.method === "POST" && url.pathname === "/admin/import-legacy-voice-notes") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.importLegacyVoiceNotes({
        blockId: body.blockId,
        suffix: body.suffix,
        overwriteClips: Boolean(body.overwriteClips),
        includeEmpty: Boolean(body.includeEmpty),
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
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

  if (request.method === "POST" && url.pathname === "/clips") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.addClip(body.clipId ?? body.id, body.clip ?? body.document ?? withoutControlFields(body, ["clipId", "id", "expectedVersion"]), {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const clipRenameMatch = url.pathname.match(/^\/clips\/([^/]+)\/rename$/);
  if (request.method === "POST" && clipRenameMatch) {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.renameClip(decodeURIComponent(clipRenameMatch[1]), body.clipId ?? body.id, {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const clipMatch = url.pathname.match(/^\/clips\/([^/]+)$/);
  if ((request.method === "POST" || request.method === "DELETE") && clipMatch) {
    try {
      const clipId = decodeURIComponent(clipMatch[1]);
      const body = request.method === "DELETE" ? undefined : await readJson(request);
      const score =
        request.method === "DELETE"
          ? store.removeClip(clipId)
          : store.replaceClip(clipId, body.clip ?? body.document ?? withoutControlFields(body, ["expectedVersion"]), {
            expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
          });
      writeJson(response, 200, score);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.updateMacrostructure(body.macrostructure ?? withoutControlFields(body, ["expectedVersion", "replace"]), {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion"),
        replace: url.searchParams.get("replace") === "1" || Boolean(body.replace)
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/structure/playhead") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.updateStructureState(body.structureState ?? withoutControlFields(body, ["expectedVersion"]), {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/advance") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.advanceStructurePlayhead({
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/reset") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.resetStructurePlayhead({
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/playback/start") {
    try {
      const body = await readJson(request);
      const playback = requireMacroPlayback(runtime);
      const clockWrites = await writeTransportParamsToAvailableTargets(config, runtime, { Clock: 1 });
      writeJson(response, 200, {
        ok: true,
        clockWrites,
        playback: playback.start({
          reset: Boolean(body.reset),
          sourceClientId: "http"
        })
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/playback/stop") {
    try {
      const playback = requireMacroPlayback(runtime);
      const clockWrites = await writeTransportParamsToAvailableTargets(config, runtime, { Clock: 0 });
      writeJson(response, 200, {
        ok: true,
        clockWrites,
        playback: playback.stop()
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/mesostructure") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.replaceMesoBlock(body.blockId ?? body.id, body.block ?? body.document ?? withoutControlFields(body, ["blockId", "id", "expectedVersion"]), {
        expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const mesoBlockMatch = url.pathname.match(/^\/mesostructure\/([^/]+)$/);
  if ((request.method === "POST" || request.method === "DELETE") && mesoBlockMatch) {
    try {
      const blockId = decodeURIComponent(mesoBlockMatch[1]);
      const body = request.method === "DELETE" ? undefined : await readJson(request);
      const score =
        request.method === "DELETE"
          ? store.removeMesoBlock(blockId)
          : store.replaceMesoBlock(blockId, body.block ?? body.document ?? withoutControlFields(body, ["expectedVersion"]), {
            expectedVersion: optionalInteger(body.expectedVersion, "expectedVersion")
          });
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
    hardwareUnits: [localUnit, ...peerUnits],
    macroPlayback: runtime.macroPlayback
  };
}

async function readAllRnboTargets(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.rnboTargets;
}

async function readPlaybackTimingContracts(score, config, runtime) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.map((target) => {
    const assignedVoiceId = assignedVoiceForTarget(score, target);
    const compiled = compileScoreTransaction(score, config, 0, assignedVoiceId ? { ...target, voiceId: assignedVoiceId } : target);
    return {
      targetId: target.id ?? "",
      targetType: "rnbo",
      contractTransport: "rnbo-osc",
      available: target.available !== false,
      assignedVoiceId,
      timing: compiled.timing,
      noteCount: compiled.noteCount,
      transmittedRowCount: compiled.transmittedRowCount
    };
  });
}

async function findRnboTarget(config, runtime, targetId) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.find((target) => target.id === targetId);
}

async function writeTransportParamsToAvailableTargets(config, runtime, params) {
  const targets = (await readAllRnboTargets(config, runtime)).filter((target) => target.available !== false);
  const writes = [];
  for (const target of targets) {
    const targetWrites = await writeRnboTransportParams(config, target, params, {
      writer: runtime.rnboParamWriter
    });
    writes.push(...targetWrites.map((write) => ({
      ...write,
      targetId: target.id
    })));
  }
  return writes;
}

function prepareRnboTransportParams(score, config, target, params) {
  const entries = Object.entries(params ?? {});
  const assignedVoiceId = assignedVoiceForTarget(score, target);
  const prepared = new Map(entries);

  if (assignedVoiceId) {
    const compiled = compileScoreTransaction(score, config, 0, { ...target, voiceId: assignedVoiceId });
    prepared.set("MaxSteps", compiled.patternLength);
    prepared.set("ClockInterval", compiled.timing.ticksPerStage);
  }

  if (prepared.has("Clock")) {
    const clock = prepared.get("Clock");
    prepared.delete("Clock");
    prepared.set("Clock", clock);
  }

  return Object.fromEntries(prepared);
}

function rememberRnboTransportParams(config, params) {
  config.rnbo.transport ??= {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name === "Clock") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      config.rnbo.transport[name] = number;
    }
  }
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

function requireMacroPlayback(runtime) {
  if (!runtime.macroPlayback) {
    throw new Error("macro playback is not available");
  }
  return runtime.macroPlayback;
}

function macroPlaybackSnapshot(runtime, store) {
  if (runtime.macroPlayback?.snapshot) {
    return runtime.macroPlayback.snapshot();
  }
  const score = store.getScore();
  return {
    running: false,
    activeBlockId: score.structureState?.activeBlockId ?? "",
    macroIndex: score.structureState?.macroIndex ?? 0,
    nextAdvanceAt: null,
    currentBlockDurationMs: 0
  };
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

function withoutControlFields(document, fields) {
  const clone = { ...(document ?? {}) };
  for (const field of fields) {
    delete clone[field];
  }
  return clone;
}
