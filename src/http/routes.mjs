import { adminPage } from "./admin-page.mjs";
import { serveStaticAsset } from "./static-files.mjs";
import { transportPage } from "./transport-page.mjs";
import { compileScoreTransaction } from "../adapters/rnbo-osc.mjs";
import { configuredRnboTargets, discoverRnboControlTargets, discoverRnboDevices, discoverRnboTargets, writeRnboTransportControls } from "../adapters/rnbo-oscquery.mjs";
import { editorManifests } from "../editors/manifest.mjs";
import { distributeBlockTtid } from "../harmonic/distribution.mjs";
import { harmonicDrift, scaleCatalog } from "../harmonic/scale.mjs";
import { resolveOscAssignments } from "../osc/assignments.mjs";
import { findOscMacro, listOscMacros, resolveMacroStepAddress, saveOscMacro, validateMacro } from "../osc/macros.mjs";
import { sendOscMessage } from "../osc/send.mjs";
import { captureOscTarget } from "../osc/snapshot-capture.mjs";
import { createOscSnapshotRecallService } from "../osc/snapshot-recall.mjs";
import { buildOscTargets } from "../osc/targets.mjs";
import { buildOscResourceReport } from "../osc/resources.mjs";
import { runAutomaticOscOnboarding } from "../osc/onboarding.mjs";
import { selectBeatWitness } from "../playback/beat-witness.mjs";
import { buildPlaybackSnapshot, nextPlaybackSnapshotGeneration } from "../playback/playback-snapshot.mjs";
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

  if (request.method === "GET" && url.pathname === "/harmonic/scales") {
    writeJson(response, 200, { ok: true, scales: scaleCatalog() });
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

  if (request.method === "GET" && url.pathname === "/oscquery/devices") {
    writeJson(response, 200, { devices: await requireManualOscQueryDevices(runtime).list({ refresh: url.searchParams.get("refresh") === "true" }) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/oscquery/devices/probe") {
    try {
      writeJson(response, 200, { ok: true, device: await requireManualOscQueryDevices(runtime).probe(await readJson(request)) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/oscquery/devices") {
    try {
      const device = await requireManualOscQueryDevices(runtime).save(await readJson(request));
      const oscAssignmentReconciliation = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      const automaticOscOnboarding = await automaticOscOnboardingFromRuntime(store, config, runtime);
      writeJson(response, 200, { ok: true, device, oscAssignmentReconciliation, automaticOscOnboarding });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const oscQueryDeviceMatch = url.pathname.match(/^\/oscquery\/devices\/([^/]+)$/);
  if (oscQueryDeviceMatch && request.method === "PATCH") {
    try {
      const device = await requireManualOscQueryDevices(runtime).update(decodeURIComponent(oscQueryDeviceMatch[1]), await readJson(request));
      const oscAssignmentReconciliation = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      const automaticOscOnboarding = await automaticOscOnboardingFromRuntime(store, config, runtime);
      writeJson(response, 200, { ok: true, device, oscAssignmentReconciliation, automaticOscOnboarding });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }
  if (oscQueryDeviceMatch && request.method === "DELETE") {
    try {
      const device = await requireManualOscQueryDevices(runtime).remove(decodeURIComponent(oscQueryDeviceMatch[1]));
      const oscAssignmentReconciliation = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      writeJson(response, 200, { ok: true, device, oscAssignmentReconciliation });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const oscQueryRefreshMatch = url.pathname.match(/^\/oscquery\/devices\/([^/]+)\/refresh$/);
  if (oscQueryRefreshMatch && request.method === "POST") {
    try {
      const device = await requireManualOscQueryDevices(runtime).refresh(decodeURIComponent(oscQueryRefreshMatch[1]));
      const oscAssignmentReconciliation = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      const automaticOscOnboarding = await automaticOscOnboardingFromRuntime(store, config, runtime);
      writeJson(response, 200, { ok: true, device, oscAssignmentReconciliation, automaticOscOnboarding });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
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

  if (request.method === "GET" && url.pathname === "/osc/assignments") {
    const assignments = store.getScore().oscAssignments ?? {};
    if (url.searchParams.get("resolved") === "1" || url.searchParams.get("resolved") === "true") {
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      writeJson(response, 200, { assignments, resolutions: resolveOscAssignments(assignments, targets), targets });
    } else {
      writeJson(response, 200, assignments);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/osc/resources") {
    const assignments = store.getScore().oscAssignments ?? {};
    const targets = buildOscTargets(await readAllOscTargets(config, runtime));
    writeJson(response, 200, buildOscResourceReport(assignments, targets));
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/onboard") {
    try {
      const body = await readJson(request);
      if (body.targetIds !== undefined || Array.isArray(body.targetId)) throw new Error("OSC onboarding accepts exactly one targetId");
      const targetId = requiredString(body.targetId, "targetId");
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const target = targets.find((entry) => entry.id === targetId || entry.rnboTargetId === targetId);
      if (!target) throw new Error(`unknown OSC target '${targetId}'`);
      if (target.status !== "online" || !target.sendable) throw new Error(`OSC target '${target.id}' is not online and sendable`);
      const roleId = requiredString(body.roleId, "roleId");
      const clipId = requiredString(body.clipId, "clipId");
      const currentScore = store.getScore();
      const blockId = optionalString(body.blockId) || currentScore.structureState?.activeBlockId;
      if (!blockId) throw new Error("blockId is required when the score has no active block");
      if (!currentScore.mesostructure?.[blockId]) throw new Error(`unknown mesostructural block '${blockId}'`);
      const captured = await captureOscTarget(target, {
        name: body.clipName || body.name,
        allowIncomplete: Boolean(body.allowIncomplete),
        fetchImpl: runtime.oscCaptureFetch ?? globalThis.fetch,
        sender: runtime.oscSender,
        delay: runtime.oscCaptureDelay,
        now: runtime.now
      });
      const assignment = {
        label: body.roleLabel || target.label || roleId,
        app: target.app,
        deviceId: target.deviceId || target.unitId,
        oscTargetId: target.id,
        ignoreRecall: Boolean(body.ignoreRecall),
        ignoreScale: Boolean(body.ignoreScale),
        locked: Boolean(body.locked)
      };
      const score = store.onboardOscTarget(roleId, assignment, clipId, captured.clip, blockId, revisionOptions(body));
      writeJson(response, 201, {
        ok: true, roleId, clipId, blockId, assignment: score.oscAssignments[roleId],
        clip: score.oscClips[clipId], score, complete: captured.complete, diagnostics: captured.diagnostics
      });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/block-state/clear") {
    try {
      const body = await readJson(request);
      const scope = requiredString(body.scope, "scope");
      const result = store.clearOscBlockStates({
        scope,
        blockId: optionalString(body.blockId),
        roleId: optionalString(body.roleId)
      }, revisionOptions(body));
      writeJson(response, 200, { ok: true, scope, clearedCount: result.cleared.length, ...result });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && (url.pathname === "/osc/block-state/write" || url.pathname === "/osc/block-state/copy")) {
    try {
      const body = await readJson(request);
      const targetId = requiredString(body.targetId, "targetId");
      const blockId = requiredString(body.blockId, "blockId");
      const currentScore = store.getScore();
      if (!currentScore.mesostructure?.[blockId]) throw new Error(`unknown mesostructural block '${blockId}'`);
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const target = targets.find((entry) => entry.id === targetId || entry.rnboTargetId === targetId);
      if (!target) throw new Error(`unknown OSC target '${targetId}'`);
      if (target.status !== "online" || !target.sendable) throw new Error(`OSC target '${target.id}' is not online and sendable`);
      const role = blockStateRoleForTarget(currentScore, target, targets);
      const roleId = role.roleId;
      const existingLayer = currentScore.mesostructure[blockId].oscLayers?.[roleId];
      const copying = url.pathname.endsWith("/copy");
      const replace = Boolean(body.replace);
      if (existingLayer?.clipId && !replace) {
        const error = new Error(`${blockId} is already Written for '${roleId}'; replacement intent is required`);
        error.code = "OSC_BLOCK_STATE_WRITTEN";
        throw error;
      }
      const baseClipId = `${blockId}-${roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
      const clipId = copying
        ? uniqueOscClipId(currentScore, `${baseClipId}-copy`)
        : existingLayer?.clipId || uniqueOscClipId(currentScore, baseClipId);
      const snapshot = body.snapshot ?? body.draft ?? body.clip;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("snapshot is required");
      const label = role.assignment.label || target.label || roleId;
      const clip = { ...snapshot, name: optionalString(body.name) || `${blockId} · ${label}` };
      const score = store.writeOscBlockState(roleId, role.assignment, clipId, clip, blockId, {
        ...revisionOptions(body),
        replace
      });
      writeJson(response, existingLayer ? 200 : 201, {
        ok: true,
        blockId,
        roleId,
        clipId,
        createdRole: role.created,
        copied: copying,
        assignment: score.oscAssignments[roleId],
        clip: score.oscClips[clipId],
        score
      });
    } catch (error) {
      writeError(response, error, error?.code === "OSC_BLOCK_STATE_WRITTEN" || error?.code === "OSC_ROLE_ASSIGNMENT_REQUIRED" ? 409 : 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/onboard/automatic") {
    try {
      writeJson(response, 200, { ok: true, ...(await automaticOscOnboardingFromRuntime(store, config, runtime)) });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/assignments/reconcile") {
    try {
      const result = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      writeJson(response, 200, { ok: true, ...result });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/osc/recalls") {
    writeJson(response, 200, oscSnapshotRecallService(runtime).snapshot());
    return;
  }

  const oscAssignmentMatch = url.pathname.match(/^\/osc\/assignments\/([^/]+)$/);
  if (oscAssignmentMatch && (request.method === "PUT" || request.method === "DELETE")) {
    try {
      const roleId = decodeURIComponent(oscAssignmentMatch[1]);
      const body = request.method === "PUT" ? await readJson(request) : url.searchParams;
      const score = request.method === "PUT"
        ? store.replaceOscAssignment(roleId, body.assignment ?? body.document ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body))
        : store.removeOscAssignment(roleId, revisionOptions(body));
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
    }
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
      const oscAssignmentReconciliation = await reconcileOscAssignmentsFromRuntime(store, config, runtime);
      const automaticOscOnboarding = await automaticOscOnboardingFromRuntime(store, config, runtime);
      writeJson(response, 200, {
        ok: true,
        unit,
        heartbeatTtlMs: registry.heartbeatTtlMs,
        assignmentReconciliation: {
          changed: reconciliation.changed,
          reconciled: reconciliation.reconciled,
          ambiguous: reconciliation.ambiguous
        },
        oscAssignmentReconciliation,
        automaticOscOnboarding
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

  if (request.method === "GET" && url.pathname === "/playback/snapshot") {
    writeJson(response, 200, await coherentPlaybackSnapshot(runtime, store, config));
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
        oscAssignments: Boolean(body.oscAssignments),
        oscClips: Boolean(body.oscClips),
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

  if (request.method === "POST" && url.pathname === "/admin/scores/initialize/preview") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, {
        ok: true,
        dryRun: true,
        ...store.previewScoreInitialization(withoutControlFields(body, REVISION_CONTROL_FIELDS))
      });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/scores/initialize") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, {
        ok: true,
        dryRun: false,
        ...store.initializeScore(withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body))
      });
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

  if (request.method === "GET" && url.pathname === "/osc/clips") {
    writeJson(response, 200, store.getScore().oscClips ?? {});
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/clips") {
    try {
      const body = await readJson(request);
      writeJson(response, 201, store.addOscClip(body.clipId ?? body.id, body.clip ?? body.document ?? withoutControlFields(body, ["clipId", "id", ...REVISION_CONTROL_FIELDS]), revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/clips/capture") {
    try {
      const body = await readJson(request);
      if (body.targetIds !== undefined || Array.isArray(body.targetId)) throw new Error("OSC capture accepts exactly one targetId");
      const targetId = requiredString(body.targetId, "targetId");
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const target = targets.find((entry) => entry.id === targetId || entry.rnboTargetId === targetId);
      if (!target) throw new Error(`unknown OSC target '${targetId}'`);
      const captured = await captureOscTarget(target, {
        name: body.name,
        allowIncomplete: Boolean(body.allowIncomplete),
        fetchImpl: runtime.oscCaptureFetch ?? globalThis.fetch,
        sender: runtime.oscSender,
        delay: runtime.oscCaptureDelay,
        now: runtime.now
      });
      const clipId = requiredString(body.clipId ?? body.id, "clipId");
      const score = store.addCapturedOscClip(clipId, captured.clip, {
        ...revisionOptions(body),
        blockId: optionalString(body.blockId),
        roleId: optionalString(body.roleId)
      });
      writeJson(response, 201, { ok: true, clipId, clip: score.oscClips[clipId], score, complete: captured.complete, diagnostics: captured.diagnostics });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/osc/clips/references") {
    writeJson(response, 200, store.inspectOscClipReferences());
    return;
  }

  const oscClipReferencesMatch = url.pathname.match(/^\/osc\/clips\/([^/]+)\/references$/);
  if (request.method === "GET" && oscClipReferencesMatch) {
    try {
      writeJson(response, 200, store.inspectOscClipReferences(decodeURIComponent(oscClipReferencesMatch[1])));
    } catch (error) {
      writeError(response, error, 404);
    }
    return;
  }

  const oscClipMatch = url.pathname.match(/^\/osc\/clips\/([^/]+)$/);
  if (oscClipMatch) {
    const clipId = decodeURIComponent(oscClipMatch[1]);
    try {
      if (request.method === "GET") {
        const clip = store.getScore().oscClips?.[clipId];
        if (!clip) throw new Error(`unknown OSC clip '${clipId}'`);
        writeJson(response, 200, clip);
      } else if (request.method === "PUT") {
        const body = await readJson(request);
        writeJson(response, 200, store.replaceOscClip(clipId, body.clip ?? body.document ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body)));
      } else if (request.method === "DELETE") {
        writeJson(response, 200, store.removeOscClip(clipId, revisionOptions(url.searchParams)));
      } else {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
      }
    } catch (error) {
      writeError(response, error, error?.code === "OSC_CLIP_REFERENCED" ? 409 : 400);
    }
    return;
  }

  const mesoLayersMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/osc-layers$/);
  if (request.method === "GET" && mesoLayersMatch) {
    const blockId = decodeURIComponent(mesoLayersMatch[1]);
    const block = store.getScore().mesostructure?.[blockId];
    if (!block) {
      writeJson(response, 404, { ok: false, error: `unknown mesostructural block '${blockId}'` });
    } else {
      writeJson(response, 200, block.oscLayers ?? {});
    }
    return;
  }

  const mesoSnapshotRecallMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/osc-layers\/recall$/);
  if (mesoSnapshotRecallMatch && (request.method === "POST" || request.method === "GET")) {
    const blockId = decodeURIComponent(mesoSnapshotRecallMatch[1]);
    try {
      const service = oscSnapshotRecallService(runtime);
      if (request.method === "GET") {
        writeJson(response, 200, service.snapshot({ blockId }));
      } else {
        const body = await readJson(request);
        writeJson(response, 200, await recallOscSnapshotsForBlock(store, config, runtime, blockId, {
          roles: body.roles,
          dryRun: Boolean(body.dryRun)
        }));
      }
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const mesoSnapshotRoleMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/osc-layers\/([^/]+)$/);
  if (mesoSnapshotRoleMatch && (request.method === "PUT" || request.method === "DELETE")) {
    try {
      const blockId = decodeURIComponent(mesoSnapshotRoleMatch[1]);
      const roleId = decodeURIComponent(mesoSnapshotRoleMatch[2]);
      const body = request.method === "PUT" ? await readJson(request) : url.searchParams;
      const score = request.method === "PUT"
        ? store.assignOscLayer(blockId, roleId, body.clipId ?? body.layer?.clipId ?? body.document?.clipId, revisionOptions(body))
        : store.removeOscLayer(blockId, roleId, revisionOptions(body));
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const mesoBlockDuplicateMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/duplicate$/);
  if (request.method === "POST" && mesoBlockDuplicateMatch) {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.duplicateMesoBlock(decodeURIComponent(mesoBlockDuplicateMatch[1]), body.blockId ?? body.id, revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const mesoTtidMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/ttid$/);
  if (mesoTtidMatch && (request.method === "PUT" || request.method === "POST")) {
    try {
      const blockId = decodeURIComponent(mesoTtidMatch[1]);
      const body = await readJson(request);
      const score = request.method === "PUT"
        ? store.updateBlockTtid(blockId, body.ttid ?? body.value, revisionOptions(body))
        : store.getScore();
      const active = score.structureState?.activeBlockId === blockId;
      const distribution = await distributeTtidForBlock(score, config, runtime, blockId, {
        targetIds: request.method === "POST" || active
          ? undefined
          : Array.isArray(body.auditionTargets) ? body.auditionTargets : []
      });
      writeJson(response, distribution.ok ? 200 : 502, {
        ok: distribution.ok,
        score,
        blockId,
        ttid: score.mesostructure[blockId].ttid,
        drift: harmonicDrift(score.mesostructure[blockId].scale, score.mesostructure[blockId].ttid),
        distribution
      });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const mesoScaleTransformMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/scale-transform$/);
  if (request.method === "POST" && mesoScaleTransformMatch) {
    try {
      const blockId = decodeURIComponent(mesoScaleTransformMatch[1]);
      const body = await readJson(request);
      const result = store.transformBlockScale(blockId, body.scale ?? withoutControlFields(body, REVISION_CONTROL_FIELDS), revisionOptions(body));
      const distribution = result.score.structureState?.activeBlockId === blockId
        ? await distributeTtidForBlock(result.score, config, runtime, blockId)
        : null;
      writeJson(response, distribution?.ok === false ? 502 : 200, { ok: distribution?.ok !== false, ...result, distribution });
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
  response.setHeader("Access-Control-Allow-Methods", "DELETE,GET,PATCH,POST,PUT,OPTIONS");
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
  const manualTargets = await runtime.manualOscQueryDevices?.rnboTargets?.() ?? [];
  const manualOscTargets = await runtime.manualOscQueryDevices?.oscTargets?.() ?? [];
  const manualRnboDevices = await runtime.manualOscQueryDevices?.rnboDevices?.() ?? [];
  const sessionRuntime = {
    rnboTargets: [...localUnit.targets, ...peerTargets, ...manualTargets],
    oscTargets: [...localUnit.oscTargets, ...peerOscTargets, ...manualOscTargets],
    rnboDevices: [...localUnit.rnboDevices, ...(runtime.peerRegistry?.rnboDevices?.() ?? []), ...manualRnboDevices],
    hardwareUnits: [localUnit, ...peerUnits],
    macroPlayback: runtime.macroPlayback,
    jackTransport: runtime.jackTransport,
    rnboAdapter: runtime.rnboAdapter
  };
  runtime.sessionRuntimeCache = sessionRuntime;
  return sessionRuntime;
}

function requireManualOscQueryDevices(runtime) {
  if (!runtime.manualOscQueryDevices) {
    throw new Error("manual OSCQuery device registry is not available");
  }
  return runtime.manualOscQueryDevices;
}

async function readRnboDevices(config) {
  return discoverRnboDevices(config);
}

async function readOscControlTargets(config) {
  return discoverRnboControlTargets(config);
}

async function readAllRnboTargets(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return runtime.rnboStageCollector?.targets?.(sessionRuntime.rnboTargets) ?? sessionRuntime.rnboTargets;
}

async function readAllRnboDevices(config, runtime) {
  const sessionRuntime = await readSessionRuntime(config, runtime);
  return sessionRuntime.rnboDevices;
}

async function readAllOscTargets(config, runtime, options = {}) {
  const sessionRuntime = options.preferCached && runtime.sessionRuntimeCache
    ? runtime.sessionRuntimeCache
    : await readSessionRuntime(config, runtime);
  return [...sessionRuntime.rnboTargets, ...sessionRuntime.oscTargets];
}

async function reconcileOscAssignmentsFromRuntime(store, config, runtime) {
  return store.reconcileOscAssignments(buildOscTargets(await readAllOscTargets(config, runtime)));
}

async function automaticOscOnboardingFromRuntime(store, config, runtime) {
  return runAutomaticOscOnboarding({
    store,
    config,
    loadTargets: async () => buildOscTargets(await readAllOscTargets(config, runtime)),
    captureTarget: (target, template) => captureOscTarget(target, {
      name: template.clipName || template.label,
      allowIncomplete: Boolean(template.allowIncomplete),
      fetchImpl: runtime.oscCaptureFetch ?? globalThis.fetch,
      sender: runtime.oscSender,
      delay: runtime.oscCaptureDelay,
      now: runtime.now
    })
  });
}

function oscSnapshotRecallService(runtime) {
  if (!runtime.oscSnapshotRecall) {
    runtime.oscSnapshotRecall = createOscSnapshotRecallService({ sender: runtime.oscSender });
  }
  return runtime.oscSnapshotRecall;
}

export async function recallOscSnapshotsForBlock(store, config, runtime, blockId, options = {}) {
  return oscSnapshotRecallService(runtime).recall({
    score: store.getScore(),
    blockId,
    targets: buildOscTargets(await readAllOscTargets(config, runtime, {
      preferCached: Boolean(options.preferCachedTargets)
    })),
    roles: options.roles,
    dryRun: Boolean(options.dryRun),
    sender: runtime.oscSender
  });
}

export async function distributeTtidForBlock(score, config, runtime, blockId, options = {}) {
  return distributeBlockTtid(score, blockId, buildOscTargets(await readAllOscTargets(config, runtime, {
    preferCached: Boolean(options.preferCachedTargets)
  })), {
    targetIds: options.targetIds,
    sender: runtime.oscSender
  });
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
  const inputPort = optionalString(body.inputPort ?? body.inport);
  if (param && inputPort) {
    throw new Error("param and inputPort are mutually exclusive");
  }
  if (!param && !inputPort && !address.startsWith("/")) {
    throw new Error("OSC address must start with /");
  }
  const results = await Promise.all(targets.map(async (target) => {
    try {
      const targetAddress = param
        ? parameterAddressForTarget(target, param)
        : inputPort
          ? inputPortAddressForTarget(target, inputPort)
          : address;
      return await sendOscMessage(target, targetAddress, body.args ?? [], {
        sender: runtime.oscSender,
        allowUnavailable: body.allowUnavailable === true
      });
    } catch (error) {
      return {
        ok: false,
        targetId: target.id ?? "",
        status: target.status ?? "unavailable",
        error: messageForError(error)
      };
    }
  }));
  return {
    ok: results.every((result) => result.ok),
    address: param || inputPort ? "" : address,
    param,
    inputPort,
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

function inputPortAddressForTarget(target, name) {
  const inputPort = (target.inputPorts ?? []).find((entry) => entry.name === name);
  if (!inputPort?.address) {
    throw new Error(`OSC target '${target.id ?? ""}' does not expose input port '${name}'`);
  }
  return inputPort.address;
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
  const targetWrites = await Promise.all(targets.map(async (target) => {
    const targetWrites = await writeRnboTransportControls(config, target, controls, {
      writer: runtime.rnboParamWriter
    });
    return targetWrites.map((write) => ({
      ...write,
      targetId: target.id
    }));
  }));
  return targetWrites.flat();
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

async function macroPlaybackSnapshot(runtime, store, config, witnessContext) {
  if (runtime.macroPlayback?.snapshot) {
    const context = witnessContext ?? await readBeatWitnessContext(store.getScore(), config, runtime);
    return {
      ...runtime.macroPlayback.snapshot(context),
      oscSnapshotRecall: automaticOscSnapshotRecallStatus(runtime)
    };
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
    },
    oscSnapshotRecall: automaticOscSnapshotRecallStatus(runtime)
  };
}

async function coherentPlaybackSnapshot(runtime, store, config) {
  const score = store.getScore();
  let targets = await readAllRnboTargets(config, runtime);
  if (runtime.rnboStageCollector?.refresh) {
    await runtime.rnboStageCollector.refresh(targets);
    targets = runtime.rnboStageCollector.targets(targets);
  }
  // Capture the coherent snapshot boundary after peer polling completes so
  // each target's stateAgeMs reflects when its readback actually arrived.
  const observedAt = Date.now();
  targets = withRnboSendStatus(targets, runtime);
  const timingContracts = targets.map((target) => playbackTimingContractForTarget(score, config, target));
  const playback = await macroPlaybackSnapshot(runtime, store, config, {
    rnboTargets: targets,
    timingContracts
  });
  return buildPlaybackSnapshot({
    generation: nextPlaybackSnapshotGeneration(runtime),
    observedAt,
    score,
    playback,
    jack: transportSnapshot(config, runtime),
    targets,
    timingContracts,
    sendQueue: rnboSendQueueStatus(runtime),
    lifecycleEvents: runtime.rnboAdapter?.lifecycleEvents?.() ?? [],
    staleAfterMs: config.transport?.rnboClient?.staleAfterMs ?? 1000
  });
}

function automaticOscSnapshotRecallStatus(runtime) {
  return runtime.oscSnapshotAutoRecall?.snapshot?.() ?? {
    pending: false,
    pendingCount: 0,
    lastEntryKey: "",
    last: null
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
  const rnboReadiness = await awaitRnboPlaybackReady(runtime);
  const jackTempo = await maybeSendJackTempo(runtime, score.macrostructure?.tempo);
  const jackStart = await maybeStartJack(runtime);
  const ttidDistribution = await distributeTtidForBlock(score, config, runtime, score.structureState?.activeBlockId);
  const snapshotRecall = await recallOscSnapshotsForBlock(store, config, runtime, score.structureState?.activeBlockId);
  const phaseWrites = body.phaseReset === false
    ? []
    : await writeTransportControlsToPlaybackTargets(score, config, runtime, { SetStage: 0 }, { targetId });
  const activationSchedule = body.phaseReset === false
    ? []
    : runtime.rnboAdapter?.schedulePreparedActivations?.({ targetId, initialStage: 0 }) ?? [];
  const clockWrites = await writeTransportControlsToPlaybackTargets(score, config, runtime, { Clock: 1 }, { targetId });
  const mode = await playbackStartMode(score, config, runtime, optionalString(body.mode));
  playback.start({
    mode,
    reset: Boolean(body.reset),
    sourceClientId
  });
  const activations = activationSchedule.length
    ? await runtime.rnboAdapter.confirmPreparedActivations(activationSchedule, {
      tempo: score.macrostructure?.tempo
    })
    : [];
  return {
    mode,
    rnboReadiness,
    jackStart,
    jackTempo,
    ttidDistribution,
    snapshotRecall,
    activations,
    clockWrites,
    phaseWrites
  };
}

async function awaitRnboPlaybackReady(runtime) {
  if (!runtime.rnboAdapter?.enabled) return null;
  if (typeof runtime.rnboAdapter.waitForIdle === "function") {
    await runtime.rnboAdapter.waitForIdle();
  }
  const failed = (runtime.rnboAdapter.sendStatus?.() ?? []).filter((status) => status.ack?.ok === false);
  if (failed.length) {
    throw new Error(`RNBO playback is not ready: ${failed.map((status) => `${status.targetId} ${status.ack?.status ?? "failed"}`).join(", ")}`);
  }
  return runtime.rnboAdapter.sendQueueStatus?.() ?? { inProgress: false, queued: false };
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
    ...(error?.code ? { code: error.code } : {}),
    ...(Array.isArray(error?.references) ? { references: error.references } : {}),
    ...(Array.isArray(error?.diagnostics) ? { diagnostics: error.diagnostics } : {}),
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

function requiredString(value, field) {
  const text = optionalString(value);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function blockStateRoleForTarget(score, target, targets = []) {
  const app = optionalString(target.app).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const targetId = optionalString(target.id);
  const deviceId = optionalString(target.deviceId || target.unitId);
  const exact = Object.entries(score.oscAssignments ?? {}).find(([, assignment]) => assignment.oscTargetId === targetId);
  if (exact) {
    if (optionalString(exact[1].app) !== app) throw new Error(`OSC target '${targetId}' is assigned to incompatible role '${exact[0]}'`);
    return { roleId: exact[0], assignment: exact[1], created: false };
  }
  const compatible = Object.entries(score.oscAssignments ?? {}).filter(([, assignment]) => {
    if (optionalString(assignment.app) !== app || optionalString(assignment.deviceId) !== deviceId) return false;
    const assignedTargetId = optionalString(assignment.oscTargetId);
    return !assignedTargetId || !targets.some((entry) => entry.id === assignedTargetId && entry.status === "online" && entry.sendable);
  });
  if (compatible.length) {
    const error = new Error(`${compatible.length} compatible unresolved score role${compatible.length === 1 ? "" : "s"} require assignment in Admin before writing`);
    error.code = "OSC_ROLE_ASSIGNMENT_REQUIRED";
    throw error;
  }
  const used = new Set(Object.keys(score.oscAssignments ?? {}));
  let ordinal = 1;
  while (used.has(`${app}-${ordinal}`)) ordinal += 1;
  const roleId = `${app}-${ordinal}`;
  return {
    roleId,
    created: true,
    assignment: {
      label: optionalString(target.label) || `${app} ${ordinal}`,
      app,
      deviceId,
      oscTargetId: targetId,
      ignoreRecall: false,
      locked: false
    }
  };
}

function uniqueOscClipId(score, requested) {
  const base = requiredString(requested, "clipId");
  if (!score.oscClips?.[base]) return base;
  let suffix = 2;
  while (score.oscClips?.[`${base}-${suffix}`]) suffix += 1;
  return `${base}-${suffix}`;
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
