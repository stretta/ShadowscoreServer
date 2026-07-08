import { adminPage } from "./admin-page.mjs";
import { serveStaticAsset } from "./static-files.mjs";
import { transportPage } from "./transport-page.mjs";
import { compileScoreTransaction } from "../adapters/rnbo-osc.mjs";
import { configuredRnboTargets, discoverRnboControlTargets, discoverRnboDevices, discoverRnboTargets, writeRnboTransportControls } from "../adapters/rnbo-oscquery.mjs";
import { editorManifests } from "../editors/manifest.mjs";
import { findOscMacro, listOscMacros, resolveMacroStepAddress, saveOscMacro, validateMacro } from "../osc/macros.mjs";
import { sendOscMessage } from "../osc/send.mjs";
import { buildOscTargets } from "../osc/targets.mjs";
import { selectBeatWitness } from "../playback/beat-witness.mjs";
import { createLocalHardwareUnit } from "../registration/peer-registry.mjs";
import { createSessionSnapshot } from "../session.mjs";
import { deleteScoreFromLibrary, listSavedScores, loadScoreFromLibrary, saveScoreToLibrary } from "../state/persistence.mjs";

const REVISION_CONTROL_FIELDS = ["expectedVersion", "expectedScoreRevision", "expectedStructureRevision"];

export async function routeRequest(request, response, store, config, runtime = {}) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    const score = store.getScore();
    writeJson(response, 200, {
      ok: true,
      ensembleId: config.ensemble.id,
      version: score.version,
      scoreRevision: score.scoreRevision ?? score.version ?? 0,
      structureRevision: score.structureRevision ?? 0,
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
    writeJson(response, 200, {
      targets: withRnboSendStatus(await readAllRnboTargets(config, runtime), runtime),
      sendQueue: rnboSendQueueStatus(runtime)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/rnbo/devices") {
    writeJson(response, 200, { devices: await readAllRnboDevices(config, runtime) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/osc/targets") {
    writeJson(response, 200, {
      targets: buildOscTargets(await readAllOscTargets(config, runtime), {
        app: url.searchParams.get("app"),
        capability: url.searchParams.get("capability"),
        status: url.searchParams.get("status")
      })
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/editors/manifest") {
    writeJson(response, 200, { editors: editorManifests(config) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/send") {
    try {
      writeJson(response, 200, await sendOscToTargets(await readAllOscTargets(config, runtime), runtime, await readJson(request)));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/broadcast") {
    try {
      const body = await readJson(request);
      const targets = buildOscTargets(await readAllOscTargets(config, runtime), body.where ?? {});
      writeJson(response, 200, await sendOscToResolvedTargets(targets, runtime, body));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/osc/macros") {
    writeJson(response, 200, { macros: await listOscMacros(config) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/macros") {
    try {
      writeJson(response, 200, { ok: true, macro: await saveOscMacro(config, await readJson(request)) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const oscMacroRunMatch = url.pathname.match(/^\/osc\/macros\/([^/]+)\/run$/);
  if (request.method === "POST" && oscMacroRunMatch) {
    try {
      const macroId = decodeURIComponent(oscMacroRunMatch[1]);
      const body = await readJson(request);
      const macro = await findOscMacro(config, macroId);
      if (!macro) {
        throw new Error(`unknown OSC macro '${macroId}'`);
      }
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const targetsById = new Map(targets.map((target) => [target.id, target]));
      const validation = validateMacro(macro, targetsById);
      const valid = validation.every((step) => step.ok);
      if (body.dryRun === true || !valid) {
        writeJson(response, valid ? 200 : 409, { ok: valid, dryRun: true, macro, validation });
      } else {
        writeJson(response, 200, {
          ok: true,
          macro,
          validation,
          results: await sendOscSteps(macro.steps, targetsById, runtime)
        });
      }
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/playback/timing-contracts") {
    const score = store.getScore();
    writeJson(response, 200, {
      scoreRevision: score.scoreRevision ?? score.version ?? 0,
      structureRevision: score.structureRevision ?? 0,
      contracts: await readPlaybackTimingContracts(score, config, runtime)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/transport") {
    writeJson(response, 200, transportSnapshot(config, runtime));
    return;
  }

  if (request.method === "GET" && url.pathname === "/transport/events") {
    openTransportEventStream(request, response, config, runtime);
    return;
  }

  if (request.method === "GET" && url.pathname === "/transport/status") {
    writeHtml(response, 200, transportPage());
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/play") {
    try {
      const body = await readJson(request);
      const result = await startUnifiedTransport(store, config, runtime, body, "transport");
      writeJson(response, 200, {
        ok: true,
        action: "play",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/stop") {
    try {
      const body = await readJson(request);
      const result = await stopUnifiedTransport(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        action: "stop",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/return-to-start") {
    try {
      const body = await readJson(request);
      store.resetStructurePlayhead(revisionOptions(body));
      const phaseWrites = await writeTransportControlsToPlaybackTargets(store.getScore(), config, runtime, { SetStage: 0 }, {
        targetId: optionalString(body.targetId)
      });
      writeJson(response, 200, {
        ok: true,
        action: "return-to-start",
        phaseWrites,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/jack/snapshot") {
    try {
      const transport = requireJackTransport(runtime);
      transport.update(await readJson(request));
      writeJson(response, 200, {
        ok: true,
        transport: transportSnapshot(config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/jack/start") {
    try {
      const controller = requireJackController(runtime);
      writeJson(response, 200, await controller.start());
    } catch (error) {
      writeJson(response, jackControllerStatus(error), { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/jack/stop") {
    try {
      const controller = requireJackController(runtime);
      writeJson(response, 200, await controller.stop());
    } catch (error) {
      writeJson(response, jackControllerStatus(error), { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/jack/locate") {
    try {
      const controller = requireJackController(runtime);
      const body = await readJson(request);
      writeJson(response, 200, await controller.locate(nonNegativeInteger(body.frame, "frame")));
    } catch (error) {
      writeJson(response, jackControllerStatus(error), { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/jack/tempo") {
    try {
      const controller = requireJackController(runtime);
      const body = await readJson(request);
      writeJson(response, 200, await controller.tempo(positiveNumber(body.bpm ?? body.tempo, "bpm")));
    } catch (error) {
      writeJson(response, jackControllerStatus(error), { ok: false, error: messageForError(error) });
    }
    return;
  }

  const rnboTransportControlsMatch = url.pathname.match(/^\/rnbo\/targets\/([^/]+)\/(?:transport-controls|params)$/);
  if (request.method === "POST" && rnboTransportControlsMatch) {
    try {
      const targetId = decodeURIComponent(rnboTransportControlsMatch[1]);
      const target = await findRnboTarget(config, runtime, targetId);
      if (!target) {
        throw new Error(`unknown RNBO target '${targetId}'`);
      }
      const body = await readJson(request);
      const controls = body.controls ?? body.params ?? body;
      const preparedControls = prepareRnboTransportControls(store.getScore(), config, target, controls);
      const writes = await writeRnboTransportControls(config, target, preparedControls, {
        writer: runtime.rnboParamWriter
      });
      rememberRnboTransportControls(config, preparedControls);
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
      const reconciliation = store.reconcileRegisteredHardwareUnit(unit);
      writeJson(response, 200, {
        ok: true,
        unit,
        heartbeatTtlMs: registry.heartbeatTtlMs,
        assignmentReconciliation: {
          changed: reconciliation.changed,
          reconciled: reconciliation.reconciled,
          ambiguous: reconciliation.ambiguous
        }
      });
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

  const observedHostRepairMatch = url.pathname.match(/^\/hardware\/units\/([^/]+)\/targets\/([^/]+)\/use-observed-host$/);
  if (request.method === "POST" && observedHostRepairMatch) {
    try {
      const registry = requirePeerRegistry(runtime);
      const unit = registry.useObservedHost(
        decodeURIComponent(observedHostRepairMatch[1]),
        decodeURIComponent(observedHostRepairMatch[2])
      );
      writeJson(response, 200, { ok: true, unit });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/assignments") {
    writeJson(response, 200, store.getScore().assignments ?? {});
    return;
  }

  if (request.method === "POST" && url.pathname === "/assignments/reconcile") {
    try {
      const hardwareUnits = await readHardwareUnits(config, runtime);
      const results = hardwareUnits.map((unit) => store.reconcileRegisteredHardwareUnit(unit));
      const reconciled = results.flatMap((result) => result.reconciled);
      const ambiguous = results.flatMap((result) => result.ambiguous);
      writeJson(response, 200, {
        ok: true,
        changed: results.some((result) => result.changed),
        reconciled,
        ambiguous,
        score: store.getScore()
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
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
      structureState: score.structureState ?? {},
      scoreRevision: score.scoreRevision ?? score.version ?? 0,
      structureRevision: score.structureRevision ?? 0
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/structure/playhead") {
    writeJson(response, 200, store.getScore().structureState ?? {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/macrostructure/playback") {
    writeJson(response, 200, await macroPlaybackSnapshot(runtime, store, config));
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
      writeJson(response, 200, store.updateContext(body.context ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), {
        replace,
        ...revisionOptions(body)
      }));
    } catch (error) {
      writeError(response, error);
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
        structure: Boolean(body.structure),
        notes: Boolean(body.notes)
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

  if (request.method === "POST" && url.pathname === "/admin/scores/new") {
    try {
      writeJson(response, 200, store.createNewScore());
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/rnbo/resend") {
    try {
      const rnboAdapter = runtime.rnboAdapter;
      if (!rnboAdapter?.enabled || typeof rnboAdapter.resendCurrentScore !== "function") {
        throw new Error("RNBO adapter is not available");
      }
      const body = await readJson(request);
      const mode = optionalString(body.mode) || optionalString(url.searchParams.get("mode"));
      const forceFullClearRows = mode === "full-clear";
      const sendPromise = rnboAdapter.resendCurrentScore(forceFullClearRows ? "admin-full-clear" : "admin", {
        forceFullClearRows
      });
      if (sendPromise && typeof sendPromise.catch === "function") {
        sendPromise.catch((error) => {
          console.error(`[rnbo] admin resend failed: ${messageForError(error)}`);
        });
      }
      writeJson(response, 200, {
        ok: true,
        mode: forceFullClearRows ? "full-clear" : "default",
        sendQueue: rnboSendQueueStatus(runtime)
      });
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
      const body = await readJson(request);
      writeJson(response, 200, store.restore(withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
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
      writeJson(response, 200, store.addClip(body.clipId ?? body.id, body.clip ?? body.document ?? withoutControlFields(body, ["clipId", "id", ...REVISION_CONTROL_FIELDS]), revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const clipRenameMatch = url.pathname.match(/^\/clips\/([^/]+)\/rename$/);
  if (request.method === "POST" && clipRenameMatch) {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.renameClip(decodeURIComponent(clipRenameMatch[1]), body.clipId ?? body.id, revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
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
          ? store.removeClip(clipId, revisionOptions(url.searchParams))
          : store.replaceClip(clipId, body.clip ?? body.document ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body));
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure") {
    try {
      const body = await readJson(request);
      const previousTempo = store.getScore().macrostructure?.tempo;
      const macrostructure = body.macrostructure ?? withoutControlFields(body, ["replace", ...REVISION_CONTROL_FIELDS]);
      const score = store.updateMacrostructure(macrostructure, {
        ...revisionOptions(body),
        replace: url.searchParams.get("replace") === "1" || Boolean(body.replace)
      });
      await maybeSendJackTempo(runtime, score.macrostructure?.tempo, previousTempo);
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/structure/playhead") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.updateStructureState(body.structureState ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/advance") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.advanceStructurePlayhead(revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/reset") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.resetStructurePlayhead(revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/phase-reset") {
    try {
      const body = await readJson(request);
      const phaseWrites = await writeTransportControlsToPlaybackTargets(store.getScore(), config, runtime, { SetStage: 0 }, {
        targetId: optionalString(body.targetId)
      });
      writeJson(response, 200, {
        ok: true,
        action: "SetStage",
        value: 0,
        phaseWrites
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/playback/start") {
    try {
      const body = await readJson(request);
      const result = await startUnifiedTransport(store, config, runtime, {
        phaseReset: false,
        ...body
      }, "http");
      writeJson(response, 200, {
        ok: true,
        ...result,
        playback: await macroPlaybackSnapshot(runtime, store, config)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/playback/stop") {
    try {
      const body = await readJson(request);
      const result = await stopUnifiedTransport(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        ...result,
        playback: await macroPlaybackSnapshot(runtime, store, config)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/mesostructure") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.replaceMesoBlock(body.blockId ?? body.id, body.block ?? body.document ?? withoutControlFields(body, ["blockId", "id", ...REVISION_CONTROL_FIELDS]), revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
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
          ? store.removeMesoBlock(blockId, revisionOptions(url.searchParams))
          : store.replaceMesoBlock(blockId, body.block ?? body.document ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body));
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
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

function openTransportEventStream(request, response, config, runtime) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });

  writeEvent(response, "snapshot", {
    type: "snapshot",
    transport: transportSnapshot(config, runtime)
  });

  const onSnapshot = (event) => writeEvent(response, event.type, {
    ...event,
    transport: {
      ...(event.transport ?? {}),
      tempoAuthority: config.transport?.tempoAuthority === "server" ? "server" : "link"
    }
  });
  runtime.jackTransport?.events?.on?.("snapshot", onSnapshot);

  request.on("close", () => {
    runtime.jackTransport?.events?.off?.("snapshot", onSnapshot);
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
  const localRnboDevices = await readRnboDevices(config);
  const localOscTargets = await readOscControlTargets(config);
  const localUnit = createLocalHardwareUnit(config, localTargets, localRnboDevices, localOscTargets);
  const peerUnits = runtime.peerRegistry?.snapshot?.() ?? [];
  const peerTargets = runtime.peerRegistry?.targets?.() ?? [];
  const peerOscTargets = runtime.peerRegistry?.oscTargets?.() ?? [];
  return {
    rnboTargets: [...localUnit.targets, ...peerTargets],
    oscTargets: [...localUnit.oscTargets, ...peerOscTargets],
    rnboDevices: [...localUnit.rnboDevices, ...(runtime.peerRegistry?.rnboDevices?.() ?? [])],
    hardwareUnits: [localUnit, ...peerUnits],
    macroPlayback: runtime.macroPlayback,
    jackTransport: runtime.jackTransport,
    rnboAdapter: runtime.rnboAdapter
  };
}

async function readRnboDevices(config) {
  return discoverRnboDevices(config);
}

async function readOscControlTargets(config) {
  return discoverRnboControlTargets(config);
}

async function readAllRnboTargets(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.rnboTargets;
}

async function readAllRnboDevices(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.rnboDevices;
}

async function readAllOscTargets(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return [...sessionRuntime.rnboTargets, ...sessionRuntime.oscTargets];
}

async function sendOscToTargets(rnboTargets, runtime, body) {
  const targetIds = Array.isArray(body.targets) ? body.targets.map((target) => String(target)) : [];
  if (targetIds.length === 0) {
    throw new Error("targets must include at least one OSC target id");
  }
  const targets = buildOscTargets(rnboTargets);
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  return sendOscToResolvedTargets(targetIds.map((id) => targetsById.get(id) ?? { id, status: "missing", sendable: false }), runtime, body);
}

async function sendOscToResolvedTargets(targets, runtime, body) {
  const address = String(body.address ?? "");
  const param = optionalString(body.param ?? body.parameter);
  if (!param && !address.startsWith("/")) {
    throw new Error("OSC address must start with /");
  }
  const results = [];
  for (const target of targets) {
    try {
      const targetAddress = param ? parameterAddressForTarget(target, param) : address;
      results.push(await sendOscMessage(target, targetAddress, body.args ?? [], {
        sender: runtime.oscSender,
        allowUnavailable: body.allowUnavailable === true
      }));
    } catch (error) {
      results.push({
        ok: false,
        targetId: target.id ?? "",
        status: target.status ?? "unavailable",
        error: messageForError(error)
      });
    }
  }
  return {
    ok: results.every((result) => result.ok),
    address: param ? "" : address,
    param,
    results
  };
}

function parameterAddressForTarget(target, name) {
  const parameter = (target.parameters ?? []).find((entry) => entry.name === name);
  if (!parameter?.address) {
    throw new Error(`OSC target '${target.id ?? ""}' does not expose parameter '${name}'`);
  }
  return parameter.address;
}

async function sendOscSteps(steps, targetsById, runtime) {
  const results = [];
  for (const step of steps) {
    const target = targetsById.get(step.target);
    try {
      results.push(await sendOscMessage(target, resolveMacroStepAddress(step, target), step.args, {
        sender: runtime.oscSender
      }));
    } catch (error) {
      results.push({
        ok: false,
        targetId: step.target,
        status: target?.status ?? "missing",
        error: messageForError(error)
      });
    }
  }
  return results;
}

async function readPlaybackTimingContracts(score, config, runtime) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.map((target) => playbackTimingContractForTarget(score, config, target));
}

function playbackTimingContractForTarget(score, config, target) {
  const assignedVoiceId = assignedVoiceForTarget(score, target);
  const compiled = compileScoreTransaction(score, config, 0, assignedVoiceId ? { ...target, voiceId: assignedVoiceId } : target);
  return {
    targetId: target.id ?? "",
    targetType: "rnbo",
    contractTransport: "rnbo-osc",
    available: target.available !== false,
    assignedVoiceId,
    timing: compiled.timing,
    targetCapabilities: target.capabilities ?? {},
    noteCount: compiled.noteCount,
    transmittedRowCount: compiled.transmittedRowCount,
    replacementMode: compiled.replacementMode,
    compactScoreReplace: compiled.compactScoreReplace === true
  };
}

async function findRnboTarget(config, runtime, targetId) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.find((target) => target.id === targetId);
}

async function writeTransportControlsToAvailableTargets(config, runtime, controls) {
  const targets = (await readAllRnboTargets(config, runtime)).filter((target) => target.available !== false);
  const writes = [];
  for (const target of targets) {
    const targetWrites = await writeRnboTransportControls(config, target, controls, {
      writer: runtime.rnboParamWriter
    });
    writes.push(...targetWrites.map((write) => ({
      ...write,
      targetId: target.id
    })));
  }
  return writes;
}

export async function writeTransportControlsToPlaybackTargets(score, config, runtime, controls, options = {}) {
  const targetId = optionalString(options.targetId);
  if (!targetId) {
    return writeTransportControlsToAvailableTargets(config, runtime, controls);
  }
  const target = await findRnboTarget(config, runtime, targetId);
  if (!target || target.available === false) {
    throw new Error(`unknown RNBO target '${targetId}'`);
  }
  const preparedParams = prepareRnboTransportControls(score, config, target, controls);
  const writes = await writeRnboTransportControls(config, target, preparedParams, {
    writer: runtime.rnboParamWriter
  });
  return writes.map((write) => ({
    ...write,
    targetId: target.id
  }));
}

export const writeTransportParamsToPlaybackTargets = writeTransportControlsToPlaybackTargets;

function prepareRnboTransportControls(score, config, target, controls) {
  const entries = Object.entries(controls ?? {});
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

function rememberRnboTransportControls(config, controls) {
  config.rnbo.transport ??= {};
  for (const [name, value] of Object.entries(controls ?? {})) {
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

function requireJackTransport(runtime) {
  if (!runtime.jackTransport) {
    throw new Error("JACK transport state is not available");
  }
  return runtime.jackTransport;
}

function requireJackController(runtime) {
  if (!runtime.jackController) {
    const error = new Error("JACK transport control is not available");
    error.statusCode = 501;
    throw error;
  }
  return runtime.jackController;
}

function jackTransportSnapshot(runtime) {
  return runtime.jackTransport?.snapshot?.() ?? {
    source: "jack",
    latest: null,
    ageMs: null,
    freshnessThresholdMs: 0,
    fresh: false,
    stale: false,
    unusable: true,
    status: "unusable",
    reason: "transport state is not available"
  };
}

function transportSnapshot(config, runtime) {
  return {
    ...jackTransportSnapshot(runtime),
    tempoAuthority: config.transport?.tempoAuthority === "server" ? "server" : "link"
  };
}

async function macroPlaybackSnapshot(runtime, store, config) {
  if (runtime.macroPlayback?.snapshot) {
    const context = await readBeatWitnessContext(store.getScore(), config, runtime);
    return runtime.macroPlayback.snapshot(context);
  }
  const score = store.getScore();
  return {
    running: false,
    mode: "stopped",
    activeBlockId: score.structureState?.activeBlockId ?? "",
    macroIndex: score.structureState?.macroIndex ?? 0,
    nextAdvanceAt: null,
    currentBlockDurationMs: 0,
    activeBlockStartBeat: null,
    activeBlockEndBeat: null,
    activeBlockDurationBeats: 0,
    macroStartBeat: null,
    macroStartIndex: 0,
    macroStartOffsetBeats: 0,
    compositionBeat: null,
    beatIntoBlock: null,
    beatsRemaining: null,
    witness: {
      source: "none",
      usable: false,
      absoluteBeat: null,
      tempo: null,
      fresh: false,
      reason: "macro playback is not available"
    },
    jack: {
      status: "unusable",
      state: "",
      absoluteBeat: null
    },
    phaseAlignment: {
      pending: false,
      last: null
    }
  };
}

async function transportFacadeStatus(store, config, runtime) {
  const score = store.getScore();
  const playback = await macroPlaybackSnapshot(runtime, store, config);
  const targets = await readAllRnboTargets(config, runtime);
  const assignedTargets = targets.filter((target) => assignedVoiceForTarget(score, target));
  const onlineTargets = assignedTargets.filter((target) => target.available !== false);
  const witness = playback.witness ?? selectBeatWitness({
    mode: playback.mode === "jack" ? "jack" : "timer",
    running: Boolean(playback.running),
    jackTransport: jackTransportSnapshot(runtime),
    rnboTargets: targets,
    timingContracts: targets.map((target) => playbackTimingContractForTarget(score, config, target)),
    rnboClient: config.transport?.rnboClient
  });
  const syncSource = witness.source === "rnbo-client" ? "rnbo" : witness.source === "jack" ? "jack" : playback.mode === "timer" ? "timer" : "none";
  const warnings = [];
  if (assignedTargets.length === 0) {
    warnings.push("No assigned playback clients.");
  } else if (onlineTargets.length < assignedTargets.length) {
    warnings.push(`${assignedTargets.length - onlineTargets.length} assigned playback client${assignedTargets.length - onlineTargets.length === 1 ? "" : "s"} offline.`);
  }
  if (playback.running && witness.usable === false && witness.reason) {
    warnings.push(witness.reason);
  }
  return {
    playing: Boolean(playback.running),
    activeBlockId: playback.activeBlockId ?? score.structureState?.activeBlockId ?? "",
    macroIndex: playback.macroIndex ?? score.structureState?.macroIndex ?? 0,
    beatIntoBlock: playback.beatIntoBlock ?? null,
    sync: {
      source: syncSource,
      fresh: Boolean(witness.fresh ?? witness.usable),
      label: syncLabel(syncSource),
      reason: witness.reason ?? ""
    },
    clients: {
      assigned: assignedTargets.length,
      online: onlineTargets.length,
      ready: assignedTargets.length > 0 && onlineTargets.length === assignedTargets.length
    },
    warnings,
    playback
  };
}

async function startUnifiedTransport(store, config, runtime, body = {}, sourceClientId = "transport") {
  const playback = requireMacroPlayback(runtime);
  const score = store.getScore();
  const targetId = optionalString(body.targetId);
  const mode = await playbackStartMode(score, config, runtime, optionalString(body.mode));
  const jackStart = await maybeStartJack(runtime);
  const jackTempo = await maybeSendJackTempo(runtime, score.macrostructure?.tempo);
  const clockWrites = await writeTransportControlsToPlaybackTargets(score, config, runtime, { Clock: 1 }, { targetId });
  const phaseWrites = body.phaseReset === false
    ? []
    : await writeTransportControlsToPlaybackTargets(score, config, runtime, { SetStage: 0 }, { targetId });
  playback.start({
    mode,
    reset: Boolean(body.reset),
    sourceClientId
  });
  return {
    mode,
    jackStart,
    jackTempo,
    clockWrites,
    phaseWrites
  };
}

async function stopUnifiedTransport(store, config, runtime, body = {}) {
  const playback = requireMacroPlayback(runtime);
  const targetId = optionalString(body.targetId);
  const clockWrites = await writeTransportControlsToPlaybackTargets(store.getScore(), config, runtime, { Clock: 0 }, { targetId });
  playback.stop();
  const jackStop = await maybeStopJack(runtime);
  return {
    jackStop,
    clockWrites
  };
}

async function maybeStartJack(runtime) {
  if (!runtime.jackController?.start) {
    return null;
  }
  return runtime.jackController.start();
}

async function maybeStopJack(runtime) {
  if (!runtime.jackController?.stop) {
    return null;
  }
  return runtime.jackController.stop();
}

async function maybeSendJackTempo(runtime, tempo, previousTempo) {
  const bpm = Number(tempo);
  if (!Number.isFinite(bpm) || bpm <= 0 || !runtime.jackController?.tempo) {
    return null;
  }
  const previous = Number(previousTempo);
  if (Number.isFinite(previous) && Math.abs(previous - bpm) < 0.000001) {
    return null;
  }
  return runtime.jackController.tempo(bpm);
}

function syncLabel(source) {
  switch (source) {
    case "jack":
      return "JACK";
    case "rnbo":
      return "RNBO";
    case "timer":
      return "Timer";
    default:
      return "No sync";
  }
}

async function readBeatWitnessContext(score, config, runtime) {
  const rnboTargets = await readAllRnboTargets(config, runtime);
  const timingContracts = rnboTargets.map((target) => playbackTimingContractForTarget(score, config, target));
  return {
    rnboTargets,
    timingContracts
  };
}

async function playbackStartMode(score, config, runtime, requestedMode) {
  if (requestedMode === "jack" || requestedMode === "timer") {
    return requestedMode;
  }
  const context = await readBeatWitnessContext(score, config, runtime);
  const witness = selectBeatWitness({
    mode: "jack",
    running: true,
    jackTransport: jackTransportSnapshot(runtime),
    rnboTargets: context.rnboTargets,
    timingContracts: context.timingContracts,
    rnboClient: config.transport?.rnboClient
  });
  return witness.usable ? "jack" : "timer";
}

function summarizeRnboSendResult(result) {
  if (Array.isArray(result?.targets)) {
    return {
      targets: result.targets.map(({ target, compiled }) => summarizeCompiledTarget(target, compiled))
    };
  }
  return summarizeCompiledTarget(undefined, result);
}

function summarizeCompiledTarget(target, compiled = {}) {
  return {
    targetId: target?.id ?? compiled.targetId ?? "",
    voiceId: target?.voiceId ?? compiled.voiceId ?? "",
    noteCount: compiled.noteCount ?? 0,
    transmittedRowCount: compiled.transmittedRowCount ?? 0,
    replacementMode: compiled.replacementMode ?? "legacy-full-clear",
    compactScoreReplace: compiled.compactScoreReplace === true,
    forceFullClearRows: compiled.forceFullClearRows === true,
    patternLength: compiled.patternLength ?? 0,
    stagesPerBeat: compiled.stagesPerBeat ?? compiled.timing?.stagesPerBeat ?? 0,
    ack: compiled.ack
  };
}

function withRnboSendStatus(targets, runtime) {
  const statuses = runtime.rnboAdapter?.sendStatus?.() ?? [];
  if (!statuses.length) {
    return targets;
  }
  const byTargetId = new Map(statuses.map((status) => [status.targetId, status]));
  return targets.map((target) => {
    const sendStatus = byTargetId.get(target.id);
    return sendStatus ? { ...target, sendStatus } : target;
  });
}

function rnboSendQueueStatus(runtime) {
  return runtime.rnboAdapter?.sendQueueStatus?.() ?? {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  };
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeError(response, error, status = 400) {
  writeJson(response, status, {
    ok: false,
    error: messageForError(error),
    ...(error?.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
    ...(error?.currentScoreRevision !== undefined ? { currentScoreRevision: error.currentScoreRevision } : {}),
    ...(error?.currentStructureRevision !== undefined ? { currentStructureRevision: error.currentStructureRevision } : {})
  });
}

function jackControllerStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 400;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}

function positiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return number;
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

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function revisionOptions(body) {
  return {
    expectedVersion: optionalInteger(readControlField(body, "expectedVersion"), "expectedVersion"),
    expectedScoreRevision: optionalInteger(readControlField(body, "expectedScoreRevision"), "expectedScoreRevision"),
    expectedStructureRevision: optionalInteger(readControlField(body, "expectedStructureRevision"), "expectedStructureRevision")
  };
}

function readControlField(body, field) {
  if (typeof body?.get === "function") {
    return body.get(field);
  }
  return body?.[field];
}

function withoutControlFields(document, fields) {
  const clone = { ...(document ?? {}) };
  for (const field of fields) {
    delete clone[field];
  }
  return clone;
}
