import { adminPage } from "./admin-page.mjs";
import { serveStaticAsset } from "./static-files.mjs";
import { transportPage } from "./transport-page.mjs";
import { compileScoreTransaction } from "../adapters/rnbo-osc.mjs";
import { configuredRnboTargets, discoverRnboControlTargets, discoverRnboDevices, discoverRnboTargets, writeRnboTransportControls } from "../adapters/rnbo-oscquery.mjs";
import { editorManifests } from "../editors/manifest.mjs";
import { distributeBlockTtid } from "../harmonic/distribution.mjs";
import { scaleCatalog } from "../harmonic/scale.mjs";
import { activeWrittenTempo } from "../playback/tempo.mjs";
import { resolveOscAssignments } from "../osc/assignments.mjs";
import { findOscMacro, listOscMacros, normalizeMacro, saveOscMacro, validateMacro } from "../osc/macros.mjs";
import { sendOscMessage } from "../osc/send.mjs";
import { captureOscTarget } from "../osc/snapshot-capture.mjs";
import { createOscSnapshotRecallService } from "../osc/snapshot-recall.mjs";
import { buildOscTargets } from "../osc/targets.mjs";
import { buildOscResourceReport } from "../osc/resources.mjs";
import { runAutomaticOscOnboarding } from "../osc/onboarding.mjs";
import { rnboClientBeatWitness, selectBeatWitness } from "../playback/beat-witness.mjs";
import { rnboCurrentStageUrl, rnboOscQueryValueUrl } from "../playback/rnbo-stage-collector.mjs";
import { buildPlaybackSnapshot, nextPlaybackSnapshotGeneration } from "../playback/playback-snapshot.mjs";
import { createTempoPolicy } from "../playback/tempo-policy.mjs";
import { createLocalHardwareUnit } from "../registration/peer-registry.mjs";
import { createSessionSnapshot } from "../session.mjs";
import { distributeBlockSwing } from "../sequencer/distribution.mjs";
import { deleteScoreFromLibrary, listSavedScores, loadScoreFromLibrary, saveScoreToLibrary } from "../state/persistence.mjs";
import { buildAuthoritativeTransportState, deriveSyncHealth, transportObjectDescriptor } from "../transport/authoritative-transport.mjs";
import { phaseStageAtBeat } from "../transport/ensemble-sync-supervisor.mjs";

const REVISION_CONTROL_FIELDS = ["expectedVersion", "expectedScoreRevision", "expectedStructureRevision"];
const OSC_SEQUENCER_APPS = new Set([
  "analogsequencer",
  "listvelsequencer",
  "listsequencer",
  "triggerseq",
  "triggersequencer"
]);

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

  if (request.method === "GET" && url.pathname === "/coordinator") {
    writeJson(response, 200, await requireCoordinator(runtime).snapshot({ refresh: url.searchParams.get("refresh") === "true" }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/coordinator/select") {
    try {
      writeJson(response, 200, { ok: true, ...(await requireCoordinator(runtime).select(await readJson(request))) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/coordinator/claim") {
    try {
      writeJson(response, 200, { ok: true, ...(await requireCoordinator(runtime).claim()) });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
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
      sendQueue: rnboSendQueueStatus(runtime),
      transfers: rnboTransferStatus(runtime)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/rnbo/transfers") {
    writeJson(response, 200, rnboTransferStatus(runtime));
    return;
  }

  if (request.method === "GET" && url.pathname === "/rnbo/transfers/events") {
    openRnboTransferEventStream(request, response, runtime);
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

  if (request.method === "POST" && url.pathname === "/osc/block-state/capture") {
    try {
      const body = await readJson(request);
      const blockId = requiredString(body.blockId, "blockId");
      const requestedTargetIds = Array.isArray(body.targets)
        ? Array.from(new Set(body.targets.map((targetId) => requiredString(targetId, "targets[]"))))
        : [];
      if (!requestedTargetIds.length) throw new Error("targets must include at least one checked instance");
      const currentScore = store.getScore();
      if (!currentScore.mesostructure?.[blockId]) throw new Error(`unknown mesostructural block '${blockId}'`);
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const selectedTargets = requestedTargetIds.map((requestedTargetId) => {
        const target = targets.find((entry) => entry.id === requestedTargetId || entry.rnboTargetId === requestedTargetId);
        if (!target) throw new Error(`unknown OSC target '${requestedTargetId}'`);
        if (target.status !== "online" || !target.sendable) throw new Error(`OSC target '${target.id}' is not online and sendable`);
        return target;
      });
      const capturedTargets = await Promise.all(selectedTargets.map(async (target) => ({
        target,
        captured: await captureOscTarget(target, {
          allowIncomplete: Boolean(body.allowIncomplete),
          fetchImpl: runtime.oscCaptureFetch ?? globalThis.fetch,
          sender: runtime.oscSender,
          delay: runtime.oscCaptureDelay,
          now: runtime.now
        })
      })));
      let planningScore = currentScore;
      const plans = [];
      for (const { target, captured } of capturedTargets) {
        const role = blockStateRoleForTarget(planningScore, target, targets);
        const existingLayer = planningScore.mesostructure[blockId].oscLayers?.[role.roleId];
        const baseClipId = `${blockId}-${role.roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const clipId = existingLayer?.clipId || uniqueOscClipId(planningScore, baseClipId);
        const label = role.assignment.label || target.label || role.roleId;
        const clip = { ...captured.clip, name: optionalString(body.name) || `${blockId} · ${label}` };
        plans.push({
          targetId: target.id,
          roleId: role.roleId,
          assignment: role.assignment,
          clipId,
          clip,
          replace: Boolean(existingLayer?.clipId),
          complete: captured.complete,
          diagnostics: captured.diagnostics
        });
        planningScore = {
          ...planningScore,
          oscAssignments: { ...(planningScore.oscAssignments ?? {}), [role.roleId]: role.assignment },
          oscClips: { ...(planningScore.oscClips ?? {}), [clipId]: clip },
          mesostructure: {
            ...planningScore.mesostructure,
            [blockId]: {
              ...planningScore.mesostructure[blockId],
              oscLayers: {
                ...(planningScore.mesostructure[blockId].oscLayers ?? {}),
                [role.roleId]: { clipId }
              }
            }
          }
        };
      }
      const result = store.writeOscBlockStates(plans, blockId, revisionOptions(body));
      writeJson(response, 200, {
        ok: true,
        blockId,
        capturedCount: plans.length,
        captures: result.writes.map((write, index) => ({
          ...write,
          targetId: plans[index].targetId,
          complete: plans[index].complete,
          diagnostics: plans[index].diagnostics
        })),
        score: result.score
      });
    } catch (error) {
      writeError(response, error, new Set(["OSC_ROLE_ASSIGNMENT_REQUIRED", "stale_structure_revision"]).has(error?.code) ? 409 : 400);
    }
    return;
  }

  if (request.method === "PUT" && url.pathname === "/osc/block-state") {
    try {
      const body = await readJson(request);
      const blockId = requiredString(body.blockId, "blockId");
      const requestedTargetIds = Array.isArray(body.targets)
        ? Array.from(new Set(body.targets.map((targetId) => requiredString(targetId, "targets[]"))))
        : [];
      if (!requestedTargetIds.length) throw new Error("targets must include at least one checked instance");
      const snapshot = body.snapshot;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("snapshot is required");
      const currentScore = store.getScore();
      if (!currentScore.mesostructure?.[blockId]) throw new Error(`unknown mesostructural block '${blockId}'`);
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      let planningScore = currentScore;
      const plans = [];
      for (const requestedTargetId of requestedTargetIds) {
        const target = targets.find((entry) => entry.id === requestedTargetId || entry.rnboTargetId === requestedTargetId);
        if (!target) throw new Error(`unknown OSC target '${requestedTargetId}'`);
        if (target.status !== "online" || !target.sendable) throw new Error(`OSC target '${target.id}' is not online and sendable`);
        const role = blockStateRoleForTarget(planningScore, target, targets);
        const existingLayer = planningScore.mesostructure[blockId].oscLayers?.[role.roleId];
        const baseClipId = `${blockId}-${role.roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const clipId = existingLayer?.clipId || uniqueOscClipId(planningScore, baseClipId);
        const label = role.assignment.label || target.label || role.roleId;
        const clip = { ...snapshot, name: optionalString(body.name) || `${blockId} · ${label}` };
        plans.push({
          targetId: target.id,
          roleId: role.roleId,
          assignment: role.assignment,
          clipId,
          clip,
          replace: Boolean(existingLayer?.clipId)
        });
        planningScore = {
          ...planningScore,
          oscAssignments: { ...(planningScore.oscAssignments ?? {}), [role.roleId]: role.assignment },
          oscClips: { ...(planningScore.oscClips ?? {}), [clipId]: clip },
          mesostructure: {
            ...planningScore.mesostructure,
            [blockId]: {
              ...planningScore.mesostructure[blockId],
              oscLayers: {
                ...(planningScore.mesostructure[blockId].oscLayers ?? {}),
                [role.roleId]: { clipId }
              }
            }
          }
        };
      }
      const result = store.writeOscBlockStates(plans, blockId, revisionOptions(body));
      writeJson(response, 200, {
        ok: true,
        blockId,
        targetCount: plans.length,
        writes: result.writes.map((write, index) => ({ ...write, targetId: plans[index].targetId })),
        score: result.score
      });
    } catch (error) {
      writeError(response, error, new Set(["OSC_ROLE_ASSIGNMENT_REQUIRED", "stale_structure_revision"]).has(error?.code) ? 409 : 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/osc/block-state/duplicate") {
    try {
      const body = await readJson(request);
      const sourceBlockId = requiredString(body.sourceBlockId, "sourceBlockId");
      const destinationBlockId = requiredString(body.destinationBlockId, "destinationBlockId");
      if (sourceBlockId === destinationBlockId) throw new Error("sourceBlockId and destinationBlockId must be different");
      const requestedTargetIds = Array.isArray(body.targets)
        ? Array.from(new Set(body.targets.map((targetId) => requiredString(targetId, "targets[]"))))
        : [];
      if (!requestedTargetIds.length) throw new Error("targets must include at least one checked instance");
      const currentScore = store.getScore();
      if (!currentScore.mesostructure?.[sourceBlockId]) throw new Error(`unknown mesostructural block '${sourceBlockId}'`);
      if (!currentScore.mesostructure?.[destinationBlockId]) throw new Error(`unknown mesostructural block '${destinationBlockId}'`);
      const targets = buildOscTargets(await readAllOscTargets(config, runtime));
      const replace = Boolean(body.replace);
      let planningScore = currentScore;
      const plans = [];
      for (const requestedTargetId of requestedTargetIds) {
        const target = targets.find((entry) => entry.id === requestedTargetId || entry.rnboTargetId === requestedTargetId);
        if (!target) throw new Error(`unknown OSC target '${requestedTargetId}'`);
        if (target.status !== "online" || !target.sendable) throw new Error(`OSC target '${target.id}' is not online and sendable`);
        const role = blockStateRoleForTarget(planningScore, target, targets);
        const sourceLayer = currentScore.mesostructure[sourceBlockId].oscLayers?.[role.roleId];
        const sourceClip = sourceLayer?.clipId ? currentScore.oscClips?.[sourceLayer.clipId] : null;
        if (!sourceClip) {
          const error = new Error(`${sourceBlockId} is Unspecified for '${role.roleId}'`);
          error.code = "OSC_BLOCK_STATE_UNSPECIFIED";
          throw error;
        }
        const existingLayer = currentScore.mesostructure[destinationBlockId].oscLayers?.[role.roleId];
        if (existingLayer?.clipId && !replace) {
          const error = new Error(`${destinationBlockId} is already Written for '${role.roleId}'; replacement intent is required`);
          error.code = "OSC_BLOCK_STATE_WRITTEN";
          throw error;
        }
        const baseClipId = `${destinationBlockId}-${role.roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const clipId = existingLayer?.clipId || uniqueOscClipId(planningScore, baseClipId);
        const label = role.assignment.label || target.label || role.roleId;
        const clip = structuredClone(sourceClip);
        clip.name = optionalString(body.name) || `${destinationBlockId} · ${label}`;
        plans.push({
          targetId: target.id,
          roleId: role.roleId,
          assignment: role.assignment,
          clipId,
          clip,
          replace
        });
        planningScore = {
          ...planningScore,
          oscClips: { ...(planningScore.oscClips ?? {}), [clipId]: clip },
          mesostructure: {
            ...planningScore.mesostructure,
            [destinationBlockId]: {
              ...planningScore.mesostructure[destinationBlockId],
              oscLayers: {
                ...(planningScore.mesostructure[destinationBlockId].oscLayers ?? {}),
                [role.roleId]: { clipId }
              }
            }
          }
        };
      }
      const result = store.writeOscBlockStates(plans, destinationBlockId, revisionOptions(body));
      writeJson(response, 200, {
        ok: true,
        sourceBlockId,
        destinationBlockId,
        copiedCount: plans.length,
        copies: result.writes.map((write, index) => ({
          ...write,
          targetId: plans[index].targetId,
          sourceClipId: currentScore.mesostructure[sourceBlockId].oscLayers[write.roleId].clipId
        })),
        score: result.score
      });
    } catch (error) {
      writeError(response, error, error?.code === "OSC_BLOCK_STATE_WRITTEN" ? 409 : 400);
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

  if (request.method === "POST" && url.pathname === "/osc/macros/run") {
    try {
      const body = await readJson(request);
      const macro = normalizeMacro(body.macro ?? body);
      const result = await runOscMacro(macro, config, runtime, { dryRun: body.dryRun === true });
      writeJson(response, result.ok ? 200 : 409, result);
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
      const result = await runOscMacro(macro, config, runtime, { dryRun: body.dryRun === true });
      writeJson(response, result.ok ? 200 : 409, result);
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
    tempoPolicyFor(store, config, runtime);
    writeJson(response, 200, transportSnapshot(config, runtime));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/objects/resolve") {
    const path = String(url.searchParams.get("path") ?? "").trim().replaceAll("/", " ").replace(/\s+/g, " ");
    if (!["transport", "shadow_score transport"].includes(path)) {
      writeJson(response, 404, { ok: false, error: `unknown object path '${path}'` });
    } else {
      writeJson(response, 200, { ok: true, object: transportObjectDescriptor });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/objects/transport") {
    try {
      writeJson(response, 200, { ok: true, object: await authoritativeTransportSnapshot(store, config, runtime) });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 503);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/objects/transport/events") {
    await openAuthoritativeTransportEventStream(request, response, store, config, runtime);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/objects/transport") {
    try {
      const body = await readJson(request);
      const result = await executeAuthoritativeTransportOperation(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        request_id: optionalString(body.request_id),
        operation: optionalString(body.operation),
        result,
        object: await authoritativeTransportSnapshot(store, config, runtime)
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/transport/events") {
    tempoPolicyFor(store, config, runtime);
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
      const result = await startUnifiedTransport(store, config, runtime, {
        ...body,
        forceArrangementRun: true
      }, "transport");
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

  if (request.method === "POST" && url.pathname === "/transport/external") {
    try {
      const body = await readJson(request);
      const result = await observeExternalTransportIntent(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        action: body.rolling ? "external-play" : "external-stop",
        ...result,
        transport: performanceTransportSnapshot(runtime, requireMacroPlayback(runtime).snapshot())
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/players/play") {
    try {
      const body = await readJson(request);
      const result = await startUnifiedTransport(store, config, runtime, body, "players");
      writeJson(response, 200, {
        ok: true,
        action: "players-play",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/players/stop") {
    try {
      const body = await readJson(request);
      const result = await stopUnifiedTransport(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        action: "players-stop",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/arrangement/run") {
    try {
      const body = await readJson(request);
      const result = await runArrangement(store, config, runtime, body);
      writeJson(response, 200, {
        ok: true,
        action: "arrangement-run",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/arrangement/hold") {
    try {
      const result = holdArrangement(runtime);
      writeJson(response, 200, {
        ok: true,
        action: "arrangement-hold",
        ...result,
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeError(response, error, error?.statusCode ?? 400);
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

  if (request.method === "POST" && url.pathname === "/transport/tempo") {
    try {
      const body = await readJson(request);
      const policy = tempoPolicyFor(store, config, runtime);
      policy.setLiveTempo(positiveNumber(body.bpm ?? body.tempo, "bpm"));
      await policy.flush();
      writeJson(response, 200, {
        ok: true,
        action: "tempo",
        tempo: policy.snapshot(),
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/tempo/follow-block") {
    try {
      const body = await readJson(request);
      if (typeof body.follow !== "boolean") throw new Error("follow must be boolean");
      const policy = tempoPolicyFor(store, config, runtime);
      policy.setFollowBlockTempo(body.follow);
      writeJson(response, 200, {
        ok: true,
        action: "follow-block-tempo",
        tempo: policy.snapshot(),
        transport: await transportFacadeStatus(store, config, runtime)
      });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/transport/tempo/use-block") {
    try {
      const policy = tempoPolicyFor(store, config, runtime);
      policy.useBlockTempo();
      await policy.flush();
      writeJson(response, 200, {
        ok: true,
        action: "use-block-tempo",
        tempo: policy.snapshot(),
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
      const body = await readJson(request);
      transport.update(body);
      if (Number.isFinite(Number(body.beatsPerMinute)) && Number(body.beatsPerMinute) > 0) {
        await observeExternalTempoAndRefreshClocks(store, config, runtime, body.beatsPerMinute);
      }
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
      const bpm = positiveNumber(body.bpm ?? body.tempo, "bpm");
      const result = await controller.tempo(bpm);
      await observeExternalTempoAndRefreshClocks(store, config, runtime, bpm);
      writeJson(response, 200, result);
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

  if (request.method === "GET" && url.pathname === "/playback/updates") {
    try {
      const adapter = requirePlaybackUpdateAdapter(runtime);
      writeJson(response, 200, await adapter.playbackUpdates(optionalString(url.searchParams.get("blockId"))));
    } catch (error) {
      writeError(response, error, 503);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/playback/updates/apply-next-beat") {
    try {
      const body = await readJson(request);
      const playback = await macroPlaybackSnapshot(runtime, store, config);
      if (!playback.running) throw new Error("transport is stopped; use Update players now");
      const blockId = optionalString(body.blockId) || playback.activeBlockId || store.getScore().structureState?.activeBlockId || "";
      assertApplyNextBeatSafe(playback, store.getScore(), config, blockId);
      const restoreBlockId = nextMacroBlockId(store.getScore(), blockId);
      const adapter = requirePlaybackUpdateAdapter(runtime);
      writeJson(response, 200, await adapter.applyBlockUpdate(blockId, {
        activationMode: "continue",
        expectedScoreRevision: optionalInteger(body.expectedScoreRevision, "expectedScoreRevision"),
        restoreBlockId,
        authorizeActivation: async () => {
          const latest = await macroPlaybackSnapshot(runtime, store, config);
          assertApplyNextBeatSafe(latest, store.getScore(), config, blockId);
        }
      }));
    } catch (error) {
      writeError(response, error, Number.isInteger(error?.statusCode) ? error.statusCode : 400);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/playback/updates/update-now") {
    try {
      const body = await readJson(request);
      const playback = await macroPlaybackSnapshot(runtime, store, config);
      if (playback.running) throw new Error("transport is running; use Apply next beat");
      const adapter = requirePlaybackUpdateAdapter(runtime);
      writeJson(response, 200, await adapter.applyBlockUpdate(body.blockId, {
        activationMode: "now",
        expectedScoreRevision: optionalInteger(body.expectedScoreRevision, "expectedScoreRevision")
      }));
    } catch (error) {
      writeError(response, error);
    }
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
    let score;
    try {
      score = store.createNewScore();
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
      return;
    }

    try {
      const adapter = runtime.rnboAdapter;
      if (adapter?.enabled && typeof adapter.applyBlockUpdate === "function") {
        await adapter.applyBlockUpdate(score.structureState?.activeBlockId, {
          activationMode: "now",
          expectedScoreRevision: score.scoreRevision ?? score.version
        });
      }
      writeJson(response, 200, score);
    } catch (error) {
      writeJson(response, 502, {
        ok: false,
        error: `New score was created, but clients could not be updated: ${messageForError(error)}`,
        score
      });
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

  if (request.method === "POST" && url.pathname === "/clips/actions/move-note") {
    try {
      const body = await readJson(request);
      const result = store.moveClipNote({
        blockId: body.blockId,
        sourcePlayerId: body.sourcePlayerId,
        sourceClipId: body.sourceClipId,
        noteIndex: body.noteIndex,
        noteId: body.noteId,
        destinationPlayerId: body.destinationPlayerId
      }, {
        ...revisionOptions(body),
        confirmShared: Boolean(body.confirmShared)
      });
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/clips/actions/import-midi-to-players") {
    try {
      const body = await readJson(request);
      const result = store.importMidiToPlayers(body, revisionOptions(body));
      writeJson(response, 200, result);
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
      const macrostructure = body.macrostructure ?? withoutControlFields(body, ["replace", ...REVISION_CONTROL_FIELDS]);
      const score = store.updateMacrostructure(macrostructure, {
        ...revisionOptions(body),
        replace: url.searchParams.get("replace") === "1" || Boolean(body.replace)
      });
      writeJson(response, 200, score);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/structure/playhead") {
    try {
      const body = await readJson(request);
      const requested = body.structureState ?? withoutControlFields(body, REVISION_CONTROL_FIELDS);
      writeJson(response, 200, await cueStructurePlayhead(store, config, runtime, {
        ...requested,
        source: "cue-section"
      }, revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/advance") {
    try {
      const body = await readJson(request);
      const score = store.getScore();
      const blocks = score.macrostructure?.blocks ?? [];
      const currentIndex = Math.min(Math.max(Number(score.structureState?.macroIndex) || 0, 0), Math.max(0, blocks.length - 1));
      const nextMacroIndex = blocks.length ? (currentIndex + 1) % blocks.length : 0;
      writeJson(response, 200, await cueStructurePlayhead(store, config, runtime, {
        activeBlockId: blocks[nextMacroIndex] ?? score.structureState?.activeBlockId ?? "",
        macroIndex: nextMacroIndex,
        source: "next-section"
      }, revisionOptions(body)));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/macrostructure/reset") {
    try {
      const body = await readJson(request);
      const score = store.getScore();
      writeJson(response, 200, await cueStructurePlayhead(store, config, runtime, {
        activeBlockId: score.macrostructure?.blocks?.[0] ?? score.structureState?.activeBlockId ?? "",
        macroIndex: 0,
        source: "return-to-start"
      }, revisionOptions(body)));
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
        forceArrangementRun: true,
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
      const explicitTargets = Array.isArray(body.destinationTargets) ? body.destinationTargets : undefined;
      const distribution = await distributeTtidForBlock(score, config, runtime, blockId, {
        targetIds: explicitTargets ?? (request.method === "POST" || active
          ? undefined
          : Array.isArray(body.auditionTargets) ? body.auditionTargets : [])
      });
      writeJson(response, distribution.ok ? 200 : 502, {
        ok: distribution.ok,
        score,
        blockId,
        ttid: score.mesostructure[blockId].ttid,
        distribution
      });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  const mesoSwingMatch = url.pathname.match(/^\/mesostructure\/([^/]+)\/swing$/);
  if (mesoSwingMatch && (request.method === "PUT" || request.method === "POST")) {
    try {
      const blockId = decodeURIComponent(mesoSwingMatch[1]);
      const body = await readJson(request);
      const score = request.method === "PUT"
        ? store.updateBlockSwing(blockId, body, revisionOptions(body))
        : store.getScore();
      const active = score.structureState?.activeBlockId === blockId;
      const explicitTargets = Array.isArray(body.destinationTargets) ? body.destinationTargets : undefined;
      const distribution = await distributeSwingForBlock(score, config, runtime, blockId, {
        targetIds: explicitTargets ?? (request.method === "POST" || active
          ? undefined
          : Array.isArray(body.auditionTargets) ? body.auditionTargets : [])
      });
      writeJson(response, distribution.ok ? 200 : 502, {
        ok: distribution.ok,
        score,
        blockId,
        swing: score.mesostructure[blockId].swing,
        swingAmt: score.mesostructure[blockId].swingAmt,
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

function openRnboTransferEventStream(request, response, runtime) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });

  writeEvent(response, "snapshot", rnboTransferStatus(runtime));
  const events = runtime.rnboAdapter?.transferEvents;
  const onSnapshot = (snapshot) => writeEvent(response, "snapshot", snapshot);
  events?.on?.("snapshot", onSnapshot);

  request.on("close", () => {
    events?.off?.("snapshot", onSnapshot);
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

async function openAuthoritativeTransportEventStream(request, response, store, config, runtime) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });

  let closed = false;
  let pending = false;
  const publish = async () => {
    if (closed || pending) return;
    pending = true;
    try {
      writeEvent(response, "snapshot", await authoritativeTransportSnapshot(store, config, runtime));
    } catch (error) {
      writeEvent(response, "error", { error: messageForError(error) });
    } finally {
      pending = false;
    }
  };
  await publish();
  const interval = setInterval(publish, 500);

  request.on("close", () => {
    closed = true;
    clearInterval(interval);
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

function requireCoordinator(runtime) {
  if (!runtime.coordinator) {
    throw new Error("coordinator manager is not available");
  }
  return runtime.coordinator;
}

async function readRnboDevices(config) {
  return discoverRnboDevices(config);
}

async function readOscControlTargets(config) {
  return discoverRnboControlTargets(config);
}

async function readAllRnboTargets(config, runtime, options = {}) {
  if (options.preferCached === true) {
    const cachedTargets = runtime.rnboStageCollector?.currentTargets?.() ?? [];
    if (cachedTargets.length) return cachedTargets;
  }
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

export async function distributeSwingForBlock(score, config, runtime, blockId, options = {}) {
  return distributeBlockSwing(score, blockId, buildOscTargets(await readAllOscTargets(config, runtime, {
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
  const parameter = (target.parameters ?? []).find((entry) => (entry.key ?? entry.name) === name)
    ?? (target.parameters ?? []).find((entry) => entry.name === name);
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

async function runOscMacro(macro, config, runtime, options = {}) {
  const targets = buildOscTargets(await readAllOscTargets(config, runtime));
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  const validation = validateMacro(macro, targetsById);
  const valid = validation.every((step) => step.ok);
  if (options.dryRun || !valid) {
    return { ok: valid, dryRun: true, macro, validation };
  }
  const results = await sendOscSteps(validation, targetsById, runtime);
  return { ok: results.every((result) => result.ok), dryRun: false, macro, validation, results };
}

async function sendOscSteps(validation, targetsById, runtime) {
  const results = [];
  for (const step of validation) {
    const target = targetsById.get(step.target);
    try {
      results.push(await sendOscMessage(target, step.address, step.args, {
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
  return cachedPlaybackTimingContracts(score, config, runtime, targets);
}

function cachedPlaybackTimingContracts(score, config, runtime, targets) {
  const key = JSON.stringify({
    scoreRevision: score.scoreRevision ?? score.version ?? 0,
    activeBlockId: score.structureState?.activeBlockId ?? "",
    targets: targets.map((target) => ({
      id: target.id ?? "",
      voiceId: assignedVoiceForTarget(score, target),
      available: target.available !== false,
      capabilities: target.capabilities ?? {}
    })).sort((left, right) => left.id.localeCompare(right.id))
  });
  if (runtime.playbackTimingContractsCache?.key === key) {
    return runtime.playbackTimingContractsCache.contracts;
  }
  const contracts = targets.map((target) => playbackTimingContractForTarget(score, config, target));
  runtime.playbackTimingContractsCache = { key, contracts };
  return contracts;
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
    compactScoreReplace: compiled.compactScoreReplace === true,
    resumableScoreReplace: compiled.resumableScoreReplace === true
  };
}

async function findRnboTarget(config, runtime, targetId) {
  const targets = await readAllRnboTargets(config, runtime);
  return targets.find((target) => target.id === targetId);
}

export async function writeTransportControlsToPlaybackTargets(score, config, runtime, controls, options = {}) {
  const targetId = optionalString(options.targetId);
  if (!targetId) {
    const availableTargets = (await readAllRnboTargets(config, runtime))
      .filter((target) => target.available !== false);
    const assignedTargets = availableTargets.filter((target) => assignedVoiceForTarget(score, target));
    const targets = assignedTargets.length > 0 ? assignedTargets : availableTargets;
    const targetWrites = await Promise.all(targets.map(async (target) => {
      const writes = await writeRnboTransportControls(config, target, controls, {
        writer: runtime.rnboParamWriter
      });
      return writes.map((write) => ({ ...write, targetId: target.id }));
    }));
    return targetWrites.flat();
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

export async function reassertPlaybackClockIntervals(score, config, runtime) {
  const targets = (await readAllRnboTargets(config, runtime)).filter((target) => target.available !== false);
  const targetWrites = await Promise.all(targets.map(async (target) => {
    const assignedVoiceId = assignedVoiceForTarget(score, target);
    if (!assignedVoiceId) {
      return [];
    }
    const compiled = compileScoreTransaction(score, config, 0, { ...target, voiceId: assignedVoiceId });
    const writes = await writeRnboTransportControls(config, target, {
      ClockInterval: compiled.timing.ticksPerStage
    }, {
      writer: runtime.rnboParamWriter
    });
    return writes.map((write) => ({
      ...write,
      targetId: target.id
    }));
  }));
  return targetWrites.flat();
}

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

function tempoPolicyFor(store, config, runtime) {
  if (!runtime.tempoPolicy) {
    runtime.tempoPolicy = createTempoPolicy(store, config, {
      applyTempo: (tempo) => applyLiveTempo(store, config, runtime, tempo),
      onTempoChanged: () => runtime.macroPlayback?.tempoChanged?.()
    });
  }
  return runtime.tempoPolicy;
}

async function observeExternalTempoAndRefreshClocks(store, config, runtime, value) {
  const policy = tempoPolicyFor(store, config, runtime);
  const previousTempo = Number(policy.snapshot().live);
  const nextTempo = Number(value);
  if (Number.isFinite(previousTempo) && Number.isFinite(nextTempo) && Math.abs(previousTempo - nextTempo) < 0.001) {
    return [];
  }
  policy.observeExternalTempo(nextTempo);
  // ClockInterval is expressed in beat-relative ticks. A JACK/Link BPM update
  // changes the duration of those ticks, not the number of ticks per stage, so
  // rewriting every assigned client here is unnecessary and turns harmless
  // floating-point BPM jitter into continuous fleet traffic.
  return [];
}

function performanceTransportFor(runtime) {
  if (!runtime.performanceTransport) {
    runtime.performanceTransport = {
      playersPlaying: false,
      playerControlOrigin: "none",
      adoptionPayloadVerified: null,
      arrangementRequestedMode: "run",
      lastExternalIntent: null,
      lastExternalPhaseAlignment: null,
      lastClockStartAcknowledgement: null
    };
  }
  return runtime.performanceTransport;
}

function performanceTransportSnapshot(runtime, playback = runtime.macroPlayback?.snapshot?.() ?? {}) {
  const performance = performanceTransportFor(runtime);
  const observedPlaying = playback.externalPlayback?.running === true;
  return {
    players: {
      playing: Boolean(performance.playersPlaying),
      observedPlaying,
      externallyPlaying: observedPlaying && !performance.playersPlaying,
      controlOrigin: performance.playerControlOrigin,
      payloadVerified: performance.adoptionPayloadVerified,
      lastExternalIntent: performance.lastExternalIntent,
      phaseAlignment: performance.lastExternalPhaseAlignment,
      clockStartAcknowledgement: performance.lastClockStartAcknowledgement,
      syncRecovery: runtime.ensembleSyncSupervisor?.snapshot?.() ?? null
    },
    arrangement: {
      running: Boolean(playback.running),
      mode: playback.running ? "run" : "hold",
      requestedMode: performance.arrangementRequestedMode,
      activeBlockId: playback.activeBlockId ?? "",
      macroIndex: playback.macroIndex ?? 0
    }
  };
}

function performanceStateText(controls) {
  const players = controls.players.playing
    ? "Players playing"
    : controls.players.externallyPlaying ? "Players running externally" : "Players stopped";
  const arrangement = controls.arrangement.running
    ? "Arrangement running"
    : `Arrangement held${controls.arrangement.activeBlockId ? ` on ${controls.arrangement.activeBlockId}` : ""}`;
  return `${players} · ${arrangement}`;
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
    tempoAuthority: config.transport?.tempoAuthority === "server" ? "server" : "link",
    tempo: runtime.tempoPolicy?.snapshot?.() ?? null
  };
}

async function macroPlaybackSnapshot(runtime, store, config, witnessContext) {
  const tempo = tempoPolicyFor(store, config, runtime).snapshot();
  if (runtime.macroPlayback?.snapshot) {
    const context = witnessContext ?? await readBeatWitnessContext(store.getScore(), config, runtime);
    const snapshot = runtime.macroPlayback.snapshot(context);
    return {
      ...snapshot,
      externalPlayback: observedRnboPlayback(context),
      tempo,
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
    tempo,
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

function observedRnboPlayback(context = {}) {
  const witness = rnboClientBeatWitness({
    targets: context.rnboTargets ?? [],
    contracts: context.timingContracts ?? [],
    maxSkewBeats: context.rnboClient?.maxSkewBeats,
    requireMoving: true
  });
  return {
    running: witness.usable === true,
    source: witness.usable ? "rnbo-client" : "none",
    witness
  };
}

function assertApplyNextBeatSafe(playback, score, config, blockId) {
  const activeBlockId = String(playback.activeBlockId ?? score.structureState?.activeBlockId ?? "").trim();
  if (blockId && activeBlockId && blockId !== activeBlockId) {
    const error = new Error(`Apply next beat can only update the playing block '${activeBlockId}'`);
    error.code = "PLAYBACK_UPDATE_NOT_ACTIVE_BLOCK";
    error.statusCode = 409;
    throw error;
  }

  const leadBeats = Math.min(0.999, Math.max(0, Number(config.rnbo?.activation?.armLeadBeats ?? 0.75)));
  const beatsRemaining = Number(playback.beatsRemaining);
  const transitionArm = playback.activationArm ?? {};
  const armedForCurrentBoundary = transitionArm.pending === true || (
    transitionArm.last?.ok === true &&
    transitionArm.last.activeBlockId === activeBlockId &&
    Number.isFinite(Number(playback.activeBlockEndBeat)) &&
    Number(transitionArm.last.boundaryBeat) === Number(playback.activeBlockEndBeat)
  );
  const insideJackGuard = Number.isFinite(beatsRemaining) && beatsRemaining > 0 && beatsRemaining <= leadBeats;

  const nextAdvanceAt = Number(playback.nextAdvanceAt);
  const tempo = Number(playback.tempo?.live ?? activeWrittenTempo(score, config.rnbo?.transport?.Tempo));
  const timerGuardMs = tempo > 0 ? leadBeats * 60000 / tempo : 0;
  const insideTimerGuard = playback.mode === "timer" && Number.isFinite(nextAdvanceAt) && nextAdvanceAt > 0 &&
    nextAdvanceAt - Date.now() <= timerGuardMs;

  if (!armedForCurrentBoundary && !insideJackGuard && !insideTimerGuard) return;
  const error = new Error(`block transition from '${activeBlockId}' is already reserved; Apply next beat is available after the transition`);
  error.code = "BLOCK_TRANSITION_RESERVED";
  error.statusCode = 409;
  throw error;
}

function nextMacroBlockId(score, activeBlockId) {
  const blocks = score.macrostructure?.blocks ?? [];
  if (blocks.length < 2) return "";
  const stateIndex = Number(score.structureState?.macroIndex);
  const activeIndex = Number.isInteger(stateIndex) && blocks[stateIndex] === activeBlockId
    ? stateIndex
    : blocks.indexOf(activeBlockId);
  if (activeIndex < 0) return "";
  return blocks[(activeIndex + 1) % blocks.length] ?? "";
}

async function cueStructurePlayhead(store, config, runtime, request, revisions = {}) {
  const score = store.getScore();
  assertCueRevisions(score, revisions);
  const blockId = optionalString(request.activeBlockId);
  if (!blockId || !score.mesostructure?.[blockId]) {
    throw new Error(`unknown mesostructural block '${blockId}'`);
  }
  const blocks = score.macrostructure?.blocks ?? [];
  const requestedIndex = Number(request.macroIndex);
  const macroIndex = Number.isInteger(requestedIndex) && blocks[requestedIndex] === blockId
    ? requestedIndex
    : blocks.indexOf(blockId);
  const targetMacroIndex = macroIndex >= 0 ? macroIndex : Math.max(0, Number(score.structureState?.macroIndex) || 0);

  const playback = await macroPlaybackSnapshot(runtime, store, config);
  if (playback.running) {
    if (typeof runtime.macroPlayback?.cue !== "function") {
      throw new Error("coordinated section cueing is not available");
    }
    const queued = runtime.macroPlayback.cue({
      blockId,
      macroIndex: targetMacroIndex,
      source: request.source ?? "manual"
    });
    return {
      ...store.getScore(),
      cue: queued.cue,
      playback: queued
    };
  }

  const controls = performanceTransportSnapshot(runtime, playback);
  const activationMode = controls.players.playing ? "continue" : "now";
  let update = null;
  if (runtime.rnboAdapter?.enabled && typeof runtime.rnboAdapter.applyBlockUpdate === "function") {
    update = await runtime.rnboAdapter.applyBlockUpdate(blockId, {
      activationMode,
      expectedScoreRevision: score.scoreRevision ?? score.version,
      reusePrepared: true
    });
    if (!["active", "no-targets"].includes(update.state)) {
      const error = new Error(`block '${blockId}' did not reach ACTIVE on every required client`);
      error.code = "SECTION_CUE_NOT_ACTIVE";
      throw error;
    }
  }
  const committed = store.updateStructureState({ activeBlockId: blockId, macroIndex: targetMacroIndex }, {
    ...revisions,
    sourceClientId: request.source ?? "manual"
  });
  runtime.macroPlayback?.clearCue?.();
  return {
    ...committed,
    cue: {
      source: request.source ?? "manual",
      blockId,
      macroIndex: targetMacroIndex,
      boundary: activationMode === "now" ? "now" : "next-beat",
      state: "active",
      error: ""
    },
    playbackUpdate: update
  };
}

function assertCueRevisions(score, revisions) {
  const checks = [
    [revisions.expectedVersion, score.version, "score version"],
    [revisions.expectedScoreRevision, score.scoreRevision ?? score.version, "score revision"],
    [revisions.expectedStructureRevision, score.structureRevision ?? 0, "structure revision"]
  ];
  for (const [expected, current, label] of checks) {
    if (expected !== undefined && expected !== null && Number(expected) !== Number(current)) {
      const error = new Error(`stale ${label} ${expected}; current ${label} is ${current}`);
      error.code = `stale_${label.replaceAll(" ", "_")}`;
      error.currentVersion = score.version;
      error.currentScoreRevision = score.scoreRevision ?? score.version;
      error.currentStructureRevision = score.structureRevision ?? 0;
      throw error;
    }
  }
}

async function coherentPlaybackSnapshot(runtime, store, config) {
  const score = store.getScore();
  let targets = await readAllRnboTargets(config, runtime, { preferCached: true });
  if (runtime.rnboStageCollector?.ensureObservations) {
    await runtime.rnboStageCollector.ensureObservations(targets);
    targets = runtime.rnboStageCollector.targets(targets);
  } else if (runtime.rnboStageCollector?.refresh) {
    // Compatibility for injected collectors that predate server-owned polling.
    await runtime.rnboStageCollector.refresh(targets);
    targets = runtime.rnboStageCollector.targets(targets);
  }
  // Capture the coherent boundary after any first-observation refresh. Normal
  // requests use the collector's cached, timestamped periodic observations.
  const observedAt = Date.now();
  targets = withRnboSendStatus(targets, runtime);
  const timingContracts = cachedPlaybackTimingContracts(score, config, runtime, targets);
  const playback = await macroPlaybackSnapshot(runtime, store, config, {
    rnboTargets: targets,
    timingContracts
  });
  const updates = typeof runtime.rnboAdapter?.playbackUpdates === "function"
    ? await runtime.rnboAdapter.playbackUpdates(
        playback.activeBlockId ?? score.structureState?.activeBlockId ?? "",
        { targets }
      )
    : null;
  return buildPlaybackSnapshot({
    generation: nextPlaybackSnapshotGeneration(runtime),
    observedAt,
    score,
    playback,
    tempo: tempoPolicyFor(store, config, runtime).snapshot(),
    controls: performanceTransportSnapshot(runtime, playback),
    jack: transportSnapshot(config, runtime),
    targets,
    timingContracts,
    sendQueue: rnboSendQueueStatus(runtime),
    transfers: rnboTransferStatus(runtime),
    lifecycleEvents: runtime.rnboAdapter?.lifecycleEvents?.() ?? [],
    updates,
    staleAfterMs: config.transport?.rnboClient?.staleAfterMs ?? 1000
  });
}

async function authoritativeTransportSnapshot(store, config, runtime) {
  runtime.authoritativeTransportRevision = Math.max(0, Number(runtime.authoritativeTransportRevision) || 0) + 1;
  const revision = runtime.authoritativeTransportRevision;
  const playbackSnapshot = await coherentPlaybackSnapshot(runtime, store, config);
  return buildAuthoritativeTransportState({
    score: store.getScore(),
    playbackSnapshot,
    revision,
    observedAt: playbackSnapshot.observedAt
  });
}

export async function runAutomaticSyncRecovery(store, config, runtime) {
  const settings = config.transport?.rnboClient?.autoResync ?? {};
  const supervisor = runtime.ensembleSyncSupervisor;
  if (settings.enabled !== true || !supervisor) return null;
  const performance = performanceTransportFor(runtime);
  if (!performance.playersPlaying) {
    supervisor.reset();
    return supervisor.snapshot();
  }
  if (runtime.automaticSyncRecoveryPromise) return runtime.automaticSyncRecoveryPromise;
  runtime.automaticSyncRecoveryPromise = (async () => {
    const playbackSnapshot = await coherentPlaybackSnapshot(runtime, store, config);
    const health = deriveSyncHealth(playbackSnapshot);
    const decision = supervisor.observe(health);
    if (!decision.trigger || !supervisor.begin()) return decision;
    try {
      const result = await startUnifiedTransport(store, config, runtime, {
        forceRestart: true,
        phaseReset: true,
        preservePosition: true,
        phaseOnly: true
      }, "automatic-sync-recovery");
      supervisor.finish({
        ok: result.clockPhaseAcknowledgement?.verified === true
          && result.clockStartPhaseVerification?.verified === true
      });
    } catch (error) {
      supervisor.finish({ ok: false, error: messageForError(error) });
      console.error(`[transport] automatic sync recovery failed: ${messageForError(error)}`);
    }
    return supervisor.snapshot();
  })().finally(() => {
    runtime.automaticSyncRecoveryPromise = null;
  });
  return runtime.automaticSyncRecoveryPromise;
}

async function executeAuthoritativeTransportOperation(store, config, runtime, body = {}) {
  const operation = optionalString(body.operation);
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : body;
  switch (operation) {
    case "play":
      return startUnifiedTransport(store, config, runtime, {
        ...args,
        forceArrangementRun: true
      }, optionalString(body.client_id) || "transport-object");
    case "stop":
      return stopUnifiedTransport(store, config, runtime, args);
    case "return_to_start": {
      store.resetStructurePlayhead(revisionOptions(args));
      const phaseWrites = await writeTransportControlsToPlaybackTargets(store.getScore(), config, runtime, { SetStage: 0 }, {
        targetId: optionalString(args.targetId)
      });
      return { action: operation, phaseWrites };
    }
    case "set_tempo": {
      const policy = tempoPolicyFor(store, config, runtime);
      policy.setLiveTempo(positiveNumber(args.bpm ?? args.tempo, "bpm"));
      await policy.flush();
      return { action: operation, tempo: policy.snapshot() };
    }
    case "previous_section":
    case "next_section": {
      const score = store.getScore();
      const blocks = score.macrostructure?.blocks ?? [];
      const current = Math.min(Math.max(Number(score.structureState?.macroIndex) || 0, 0), Math.max(0, blocks.length - 1));
      const delta = operation === "previous_section" ? -1 : 1;
      const index = blocks.length ? (current + delta + blocks.length) % blocks.length : 0;
      return cueStructurePlayhead(store, config, runtime, {
        activeBlockId: blocks[index] ?? score.structureState?.activeBlockId ?? "",
        macroIndex: index,
        source: operation
      }, revisionOptions(args));
    }
    case "re_sync":
      return startUnifiedTransport(store, config, runtime, {
        ...args,
        forceArrangementRun: true,
        forceRestart: true,
        phaseReset: true,
        preservePosition: true,
        phaseOnly: true
      }, optionalString(body.client_id) || "transport-object");
    case "locate_beats":
    case "locate_fraction": {
      const error = new Error("continuous arrangement locate is not yet available; use previous_section, next_section, or return_to_start");
      error.statusCode = 501;
      throw error;
    }
    default: {
      const error = new Error(`unknown transport operation '${operation}'`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function requirePlaybackUpdateAdapter(runtime) {
  const adapter = runtime.rnboAdapter;
  if (!adapter?.enabled || typeof adapter.playbackUpdates !== "function") {
    throw new Error("RNBO playback update service is not available");
  }
  return adapter;
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
  const selectedWitness = playback.witness ?? selectBeatWitness({
    mode: playback.mode === "jack" ? "jack" : "timer",
    running: Boolean(playback.running),
    jackTransport: jackTransportSnapshot(runtime),
    rnboTargets: targets,
    timingContracts: cachedPlaybackTimingContracts(score, config, runtime, targets),
    rnboClient: config.transport?.rnboClient
  });
  const availableWitness = playback.externalPlayback?.witness;
  const witness = selectedWitness.usable ? selectedWitness : availableWitness?.usable ? availableWitness : selectedWitness;
  const syncSource = witness.source === "rnbo-client" ? "rnbo" : witness.source === "jack" ? "jack" : playback.mode === "timer" ? "timer" : "none";
  const controls = performanceTransportSnapshot(runtime, playback);
  const warnings = [];
  if (assignedTargets.length === 0) {
    warnings.push("No assigned playback clients.");
  } else if (onlineTargets.length < assignedTargets.length) {
    warnings.push(`${assignedTargets.length - onlineTargets.length} assigned playback client${assignedTargets.length - onlineTargets.length === 1 ? "" : "s"} offline.`);
  }
  if (playback.running && witness.usable === false && witness.reason) {
    warnings.push(witness.reason);
  }
  if (controls.players.controlOrigin === "adopted" && controls.players.payloadVerified === false) {
    warnings.push("Running RNBO payload was preserved without server-side hash verification.");
  }
  if (controls.players.playing
    && controls.players.clockStartAcknowledgement?.required
    && controls.players.clockStartAcknowledgement.verified === false) {
    warnings.push("One or more RNBO clients did not acknowledge their quantized clock start.");
  }
  return {
    playing: controls.players.playing,
    activeBlockId: playback.activeBlockId ?? score.structureState?.activeBlockId ?? "",
    macroIndex: playback.macroIndex ?? score.structureState?.macroIndex ?? 0,
    beatIntoBlock: playback.beatIntoBlock ?? null,
    tempo: tempoPolicyFor(store, config, runtime).snapshot(),
    players: controls.players,
    arrangement: controls.arrangement,
    stateText: performanceStateText(controls),
    sync: {
      source: syncSource,
      fresh: Boolean(witness.fresh ?? witness.usable),
      label: syncLabel(syncSource),
      reason: witness.reason ?? "",
      selected: Boolean(playback.running && selectedWitness.usable),
      available: Boolean(witness.usable)
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
  const performance = performanceTransportFor(runtime);
  const requestedArrangementMode = body.forceArrangementRun
    ? "run"
    : performance.arrangementRequestedMode;
  const score = store.getScore();
  const continuingClockContract = requestedArrangementMode === "run"
    ? await requireStableContinuingClockContract(score, config, runtime)
    : null;
  if (body.forceArrangementRun) performance.arrangementRequestedMode = "run";
  if (performance.playersPlaying && body.forceRestart !== true) {
    if (requestedArrangementMode === "run" && !playback.snapshot().running) {
      const mode = await playbackStartMode(store.getScore(), config, runtime, optionalString(body.mode));
      playback.start({ mode, reset: Boolean(body.reset), sourceClientId });
    }
    return {
      idempotent: true,
      mode: playback.snapshot().mode,
      rnboReadiness: null,
      jackStart: null,
      jackTempo: null,
      tempoWrites: [],
      ttidDistribution: null,
      swingDistribution: null,
      snapshotRecall: null,
      playbackUpdate: null,
      activations: [],
      clockWrites: [],
      oscClockWrites: [],
      phaseWrites: []
    };
  }
  const targetId = optionalString(body.targetId);
  const witnessContext = await readBeatWitnessContext(score, config, runtime);
  const externalPlayback = observedRnboPlayback(witnessContext);
  const phaseOnly = body.phaseOnly === true && performance.playersPlaying;
  const initialReadiness = phaseOnly
    ? { allActive: true, phaseOnly: true }
    : await rnboPlaybackReadiness(runtime, score, { waitForIdle: true });
  if (externalPlayback.running && body.forceRestart !== true) {
    const jackStart = await maybeStartJack(runtime);
    const mode = "jack";
    if (requestedArrangementMode === "run") {
      playback.start({
        mode,
        reset: false,
        sourceClientId,
        witnessContext,
        anchorOffsetBeats: externalPlayback.witness.absoluteBeat
      });
    } else {
      playback.stop();
    }
    performance.playersPlaying = true;
    performance.playerControlOrigin = "adopted";
    performance.adoptionPayloadVerified = initialReadiness.allActive;
    return {
      adopted: true,
      payloadVerified: initialReadiness.allActive,
      mode,
      rnboReadiness: initialReadiness,
      jackStart,
      jackTempo: null,
      tempoWrites: [],
      ttidDistribution: null,
      swingDistribution: null,
      snapshotRecall: null,
      playbackUpdate: null,
      activations: [],
      clockWrites: [],
      oscClockWrites: [],
      phaseWrites: []
    };
  }
  if (!phaseOnly && !initialReadiness.allActive && runtime.rnboAdapter?.enabled && typeof runtime.rnboAdapter.prepareBlock === "function") {
    await runtime.rnboAdapter.prepareBlock(score.structureState?.activeBlockId, "transport-start");
  }
  const rnboReadiness = phaseOnly ? initialReadiness : await awaitRnboPlaybackReady(runtime, score);
  const playbackUpdate = phaseOnly || initialReadiness.allActive || body.phaseReset === false || typeof runtime.rnboAdapter?.applyBlockUpdate !== "function"
    ? null
    : await runtime.rnboAdapter.applyBlockUpdate(score.structureState?.activeBlockId, {
      activationMode: "now",
      expectedScoreRevision: score.scoreRevision ?? score.version
    });
  const tempo = tempoPolicyFor(store, config, runtime).snapshot().live;
  const tempoApplication = await applyLiveTempo(store, config, runtime, tempo);
  const jackTempo = tempoApplication.jack;
  const jackStart = await maybeStartJack(runtime);
  const [ttidDistribution, swingDistribution] = await Promise.all([
    distributeTtidForBlock(score, config, runtime, score.structureState?.activeBlockId),
    distributeSwingForBlock(score, config, runtime, score.structureState?.activeBlockId)
  ]);
  const snapshotRecall = await recallOscSnapshotsForBlock(store, config, runtime, score.structureState?.activeBlockId);
  const phaseStage = body.phaseReset === false
    ? null
    : await transportRestartStage(store, score, config, runtime, body);
  const phaseClockStopWrites = body.phaseReset === false
    ? []
    : await writeTransportControlsToPlaybackTargets(score, config, runtime, { Clock: 0 }, { targetId });
  const phaseWrites = body.phaseReset === false
    ? []
    : await writeTransportControlsToPlaybackTargets(score, config, runtime, { SetStage: phaseStage }, { targetId });
  // Read the acknowledgement cohort at the phase-write boundary. Preparation
  // can take long enough for peer registrations and exported instances to
  // change after the initial beat-witness snapshot.
  const phaseAckTargets = body.phaseReset === false
    ? []
    : (await readAllRnboTargets(config, runtime)).filter((target) =>
        target.available !== false
        && assignedVoiceForTarget(score, target)
        && (!targetId || optionalString(target.id) === targetId)
      );
  const clockStartAckBaselines = body.phaseReset === false
    ? {}
    : await readClockStartAckBaselines(config, runtime, phaseAckTargets);
  const activationSchedule = body.phaseReset === false || playbackUpdate
    ? []
    : runtime.rnboAdapter?.schedulePreparedActivations?.({ targetId, initialStage: phaseStage }) ?? [];
  const [clockWrites, oscClockWrites] = await Promise.all([
    writeTransportControlsToPlaybackTargets(score, config, runtime, { Clock: 1 }, { targetId }),
    writeOscSequencerClocks(score, config, runtime, "On")
  ]);
  const clockStartAcknowledgement = body.phaseReset === false
    ? { required: false, verified: true, expectedStage: null, targetCount: 0, acknowledgements: [] }
    : await verifyClockStartAcknowledgements(
        config,
        runtime,
        phaseAckTargets,
        clockStartAckBaselines,
        phaseStage
      );
  // Clock On is only quantized locally by each RNBO client. The ACK cohort is
  // therefore a barrier, not proof that every client caught the same beat.
  // Once every client has actually started, one concurrent SetStage write
  // gives the freewheeling clocks a shared phase without stopping them again.
  const clockStartCorrectionWrites = body.phaseReset === false
    || !clockStartAcknowledgement.required
    || !clockStartAcknowledgement.verified
    ? []
    : await writeTransportControlsToPlaybackTargets(score, config, runtime, { SetStage: phaseStage }, { targetId });
  if (clockStartCorrectionWrites.length > 0) {
    await phaseAlignmentSettle(config.rnbo?.phaseAlignment?.startCorrectionSettleMs ?? 100);
  }
  const clockPhaseResetSupported = phaseAckTargets.length > 0 && phaseAckTargets.every((target) =>
    target.clockPhaseResetPath && rnboOscQueryValueUrl(target, target.clockPhaseAckPath)
  );
  const clockPhaseAckBaselines = clockPhaseResetSupported
    ? await readClockPhaseAckBaselines(config, runtime, phaseAckTargets)
    : {};
  const clockPhaseResetWrites = clockPhaseResetSupported && clockStartCorrectionWrites.length > 0
    ? await writeTransportControlsToPlaybackTargets(score, config, runtime, { clock_phase_reset: 1 }, { targetId })
    : [];
  const clockPhaseAcknowledgement = clockPhaseResetWrites.length > 0
    ? await verifyClockPhaseAcknowledgements(config, runtime, phaseAckTargets, clockPhaseAckBaselines, phaseStage)
    : {
        required: phaseAckTargets.length > 0,
        supported: false,
        verified: false,
        expectedStage: phaseStage,
        targetCount: 0,
        acknowledgements: []
      };
  const clockStartPhaseVerification = clockPhaseAcknowledgement.verified
    ? await verifyExternalTransportPhase(score, config, runtime, phaseAckTargets)
    : {
        verified: false,
        complete: false,
        targetCount: 0,
        expectedTargetCount: phaseAckTargets.length,
        witness: {
          source: "rnbo-client",
          usable: false,
          fresh: false,
          reason: clockPhaseResetSupported
            ? "clock phase reset acknowledgement failed"
            : "clock phase reset is not available on every playback client"
        }
      };
  performance.lastClockStartAcknowledgement = {
    ...clockStartAcknowledgement,
    correctionWriteCount: clockStartCorrectionWrites.length,
    clockPhaseResetWriteCount: clockPhaseResetWrites.length,
    clockPhaseAcknowledgement,
    phaseVerification: clockStartPhaseVerification
  };
  const startWitnessContext = body.phaseReset === false
    ? witnessContext
    : await readBeatWitnessContext(score, config, runtime);
  const phaseAnchor = body.phaseReset === false
    ? null
    : observedRnboPlayback(startWitnessContext).witness;
  const mode = await playbackStartMode(score, config, runtime, optionalString(body.mode));
  if (requestedArrangementMode === "run") {
    playback.start({
      mode,
      reset: Boolean(body.reset),
      sourceClientId,
      witnessContext: startWitnessContext,
      anchorOffsetBeats: phaseAnchor?.usable && Number.isFinite(phaseAnchor.absoluteBeat)
        ? phaseAnchor.absoluteBeat
        : undefined
    });
  } else {
    playback.stop();
  }
  performance.playersPlaying = true;
  performance.playerControlOrigin = "shadowscore";
  performance.adoptionPayloadVerified = null;
  const activations = playbackUpdate?.activations ?? (activationSchedule.length
    ? await runtime.rnboAdapter.confirmPreparedActivations(activationSchedule, {
      tempo
    })
    : []);
  return {
    mode,
    rnboReadiness,
    continuingClockContract,
    jackStart,
    jackTempo,
    tempoWrites: tempoApplication.rnboWrites,
    ttidDistribution,
    swingDistribution,
    snapshotRecall,
    playbackUpdate,
    activations,
    phaseClockStopWrites,
    clockWrites,
    clockStartAcknowledgement,
    clockStartCorrectionWrites,
    clockPhaseResetWrites,
    clockPhaseAcknowledgement,
    clockStartPhaseVerification,
    oscClockWrites,
    phaseWrites,
    phaseAnchor,
    phaseStage
  };
}

async function transportRestartStage(store, score, config, runtime, body = {}) {
  if (body.preservePosition !== true) return 0;
  const context = await readBeatWitnessContext(score, config, runtime);
  const playback = await macroPlaybackSnapshot(runtime, store, config, context);
  const reference = context.timingContracts.find((contract) =>
    contract.assignedVoiceId
      && Number.isFinite(Number(contract.timing?.stagesPerBeat))
      && Number.isFinite(Number(contract.timing?.patternLength))
  ) ?? context.timingContracts.find((contract) =>
    Number.isFinite(Number(contract.timing?.stagesPerBeat))
      && Number.isFinite(Number(contract.timing?.patternLength))
  );
  if (!reference || !Number.isFinite(Number(playback.beatIntoBlock))) return 0;
  return phaseStageAtBeat({
    beatIntoBlock: playback.beatIntoBlock,
    stagesPerBeat: reference.timing.stagesPerBeat,
    patternLength: reference.timing.patternLength
  });
}

async function observeExternalTransportIntent(store, config, runtime, body = {}) {
  if (typeof body.rolling !== "boolean") {
    const error = new Error("rolling must be a boolean");
    error.statusCode = 400;
    throw error;
  }
  const playback = requireMacroPlayback(runtime);
  const performance = performanceTransportFor(runtime);
  const source = optionalString(body.source) || "external";
  const unitId = optionalString(body.unitId);
  performance.lastExternalIntent = {
    source,
    unitId,
    rolling: body.rolling,
    receivedAt: new Date().toISOString()
  };

  if (!body.rolling) {
    playback.stop();
    performance.playersPlaying = false;
    performance.playerControlOrigin = "none";
    performance.adoptionPayloadVerified = null;
    return { adopted: false, released: true, mode: "stopped" };
  }

  performance.playersPlaying = true;
  performance.playerControlOrigin = source === "shadowbox" ? "shadowbox" : "external";
  performance.adoptionPayloadVerified = null;
  if (performance.arrangementRequestedMode !== "run") {
    playback.stop();
    return { adopted: true, arrangementHeld: true, mode: "stopped" };
  }

  const witnessContext = await readExternalPhaseWitnessContext(store.getScore(), config, runtime);
  const initialAnchor = externalTransportAnchor(body, unitId, witnessContext);
  const phaseAlignment = await alignExternalTransportPhase(
    store.getScore(),
    config,
    runtime,
    body,
    initialAnchor,
    witnessContext
  );
  const phaseVerified = phaseAlignment.verified === true;
  const anchor = phaseVerified
    ? {
        ...initialAnchor,
        beatIntoBlock: phaseAlignment.beatIntoBlock,
        phaseAligned: true
      }
    : initialAnchor;
  performance.lastExternalPhaseAlignment = {
    ...phaseAlignment,
    observedAt: new Date().toISOString(),
    source,
    unitId,
    anchor: structuredClone(anchor)
  };
  if (anchor.source !== "rnbo-client" || !Number.isFinite(anchor.beatIntoBlock)) {
    const current = playback.snapshot();
    return {
      adopted: true,
      arrangementHeld: !current.running,
      arrangementSynchronized: false,
      mode: current.mode,
      anchor,
      phaseAlignment,
      phaseWrites: phaseAlignment.writes,
      witnessAvailable: false
    };
  }
  const result = playback.start({
    mode: "jack",
    reset: false,
    sourceClientId: source,
    witnessContext,
    anchorOffsetBeats: anchor.beatIntoBlock
  });
  return {
    adopted: true,
    arrangementHeld: false,
    mode: result.mode,
    anchor,
    phaseAlignment,
    phaseWrites: phaseAlignment.writes,
    arrangementSynchronized: phaseVerified,
    witnessAvailable: result.witness?.usable === true
  };
}

async function alignExternalTransportPhase(score, config, runtime, body, anchor, context = {}) {
  if (body.phaseAlign === false) {
    return externalPhaseAlignmentResult("disabled");
  }
  if (anchor.source !== "rnbo-client" || !anchor.targetId) {
    return externalPhaseAlignmentResult("source-stage-unavailable");
  }

  const targets = (context.rnboTargets ?? []).filter((target) =>
    target.available !== false && assignedVoiceForTarget(score, target)
  );
  const contracts = context.timingContracts ?? [];
  const sourceTarget = targets.find((target) => optionalString(target.id) === anchor.targetId);
  const sourceContract = contracts.find((contract) => optionalString(contract.targetId) === anchor.targetId);
  const stagesPerBeat = Number(sourceContract?.timing?.stagesPerBeat);
  const patternLength = Number(sourceContract?.timing?.patternLength);
  if (!sourceTarget || !Number.isFinite(sourceTarget.currentStage)
    || !Number.isFinite(stagesPerBeat) || stagesPerBeat <= 0
    || !Number.isFinite(patternLength) || patternLength <= 0) {
    return externalPhaseAlignmentResult("source-stage-unavailable");
  }

  const activeBlockId = score.structureState?.activeBlockId ?? "";
  const tempo = Number(score.mesostructure?.[activeBlockId]?.tempo)
    || Number(sourceContract?.timing?.tempo)
    || Number(config.rnbo?.transport?.Tempo)
    || 120;
  const comparable = targets.flatMap((target) => {
    const contract = contracts.find((entry) => optionalString(entry.targetId) === optionalString(target.id));
    if (Number(contract?.timing?.stagesPerBeat) !== stagesPerBeat
      || Number(contract?.timing?.patternLength) !== patternLength
      || !Number.isFinite(target.currentStage)
      || ["stale", "error"].includes(target.stageReadbackStatus)) {
      return [];
    }
    return [{
      target,
      stage: extrapolatedStage(target, stagesPerBeat, patternLength, tempo)
    }];
  });
  if (comparable.length !== targets.length) {
    const comparableIds = new Set(comparable.map(({ target }) => optionalString(target.id)));
    return {
      ...externalPhaseAlignmentResult("incomplete-comparable-targets"),
      unavailableTargetIds: targets
        .map((target) => optionalString(target.id))
        .filter((targetId) => targetId && !comparableIds.has(targetId))
    };
  }
  if (comparable.length < 2) {
    return externalPhaseAlignmentResult("insufficient-comparable-targets");
  }

  const source = comparable.find(({ target }) => optionalString(target.id) === anchor.targetId);
  if (!source) {
    return externalPhaseAlignmentResult("source-stage-unavailable");
  }
  const offsets = comparable.map(({ target, stage }) => ({
    targetId: target.id,
    stage,
    offsetStages: circularStageOffset(stage, source.stage, patternLength)
  }));
  const maxOffsetStages = Math.max(...offsets.map(({ offsetStages }) => Math.abs(offsetStages)));
  if (maxOffsetStages > stagesPerBeat) {
    return {
      ...externalPhaseAlignmentResult("skew-exceeds-one-beat"),
      sourceTargetId: source.target.id,
      value: source.stage,
      beatIntoBlock: source.stage / stagesPerBeat,
      offsets
    };
  }

  const phaseTargets = comparable.map(({ target }) => target);
  const clockOffWrites = await writeTransportControlPhase(
    config,
    runtime,
    phaseTargets,
    "clock-off",
    { Clock: 0 }
  );
  await phaseAlignmentSettle(config.rnbo?.phaseAlignment?.clockOffSettleMs);
  const setStageWrites = await writeTransportControlPhase(
    config,
    runtime,
    phaseTargets,
    "set-stage",
    { SetStage: source.stage }
  );
  await phaseAlignmentSettle(config.rnbo?.phaseAlignment?.setStageSettleMs);
  const clockStartAckBaselines = await readClockStartAckBaselines(config, runtime, phaseTargets);
  const clockOnWrites = await writeTransportControlPhase(
    config,
    runtime,
    phaseTargets,
    "clock-on",
    { Clock: 1 }
  );
  const clockStartAcknowledgement = await verifyClockStartAcknowledgements(
    config,
    runtime,
    phaseTargets,
    clockStartAckBaselines,
    source.stage
  );
  performanceTransportFor(runtime).lastClockStartAcknowledgement = clockStartAcknowledgement;
  const verification = await verifyExternalTransportPhase(score, config, runtime, phaseTargets);
  const verified = verification.verified && clockStartAcknowledgement.verified;
  return {
    applied: true,
    verified,
    reason: verified ? "coordinated-clock-restart" : "coordinated-clock-verification-failed",
    sourceTargetId: source.target.id,
    value: source.stage,
    beatIntoBlock: source.stage / stagesPerBeat,
    offsets,
    writes: [...clockOffWrites, ...setStageWrites, ...clockOnWrites],
    clockStartAcknowledgement,
    verification
  };
}

async function writeTransportControlPhase(config, runtime, targets, phase, controls) {
  const targetWrites = await Promise.all(targets.map(async (target) => {
    const writes = await writeRnboTransportControls(config, target, controls, {
      writer: runtime.rnboParamWriter
    });
    return writes.map((write) => ({ ...write, targetId: target.id, phase }));
  }));
  return targetWrites.flat();
}

async function phaseAlignmentSettle(value) {
  const milliseconds = Math.max(0, Math.min(2000, Number(value) || 0));
  if (milliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

async function readClockStartAckBaselines(config, runtime, targets) {
  const entries = await Promise.all(targets.map(async (target) => [
    target.id,
    await readClockStartAck(config, runtime, target)
  ]));
  return Object.fromEntries(entries);
}

async function readClockPhaseAckBaselines(config, runtime, targets) {
  const entries = await Promise.all(targets.map(async (target) => [
    target.id,
    await readClockPhaseAck(config, runtime, target)
  ]));
  return Object.fromEntries(entries);
}

async function verifyClockStartAcknowledgements(config, runtime, targets, baselines, expectedStage) {
  const supported = targets.filter((target) => rnboOscQueryValueUrl(target, target.clockStartAckPath));
  if (!supported.length) {
    return { required: false, verified: true, expectedStage, targetCount: 0, acknowledgements: [] };
  }
  const timeoutMs = Math.max(0, Math.min(5000,
    Number(config.rnbo?.phaseAlignment?.startAckTimeoutMs) || 5000));
  const pollIntervalMs = Math.max(10, Math.min(250,
    Number(config.rnbo?.phaseAlignment?.startAckPollIntervalMs) || 100));
  const deadline = Date.now() + timeoutMs;
  let acknowledgements = [];
  do {
    acknowledgements = await Promise.all(supported.map(async (target) => {
      const baseline = baselines?.[target.id];
      const observed = await readClockStartAck(config, runtime, target);
      const counterAdvanced = Number.isFinite(baseline?.counter)
        ? Number.isFinite(observed.counter) && observed.counter !== baseline.counter
        : Number.isFinite(observed.counter);
      const stageMatched = Number.isFinite(observed.stage)
        && Math.abs(observed.stage - Number(expectedStage)) < 0.000001;
      return {
        targetId: target.id,
        baselineCounter: baseline?.counter ?? null,
        counter: observed.counter ?? null,
        stage: observed.stage ?? null,
        acknowledged: counterAdvanced && stageMatched,
        error: observed.error ?? ""
      };
    }));
    if (acknowledgements.every(({ acknowledged }) => acknowledged) || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    required: true,
    verified: acknowledgements.length === supported.length
      && acknowledgements.every(({ acknowledged }) => acknowledged),
    expectedStage,
    targetCount: supported.length,
    acknowledgements
  };
}

async function verifyClockPhaseAcknowledgements(config, runtime, targets, baselines, expectedStage) {
  const supported = targets.filter((target) => rnboOscQueryValueUrl(target, target.clockPhaseAckPath));
  if (supported.length !== targets.length || supported.length === 0) {
    return {
      required: targets.length > 0,
      supported: false,
      verified: false,
      expectedStage,
      targetCount: supported.length,
      acknowledgements: []
    };
  }
  const timeoutMs = Math.max(0, Math.min(5000,
    Number(config.rnbo?.phaseAlignment?.phaseAckTimeoutMs)
      || Number(config.rnbo?.phaseAlignment?.startAckTimeoutMs)
      || 5000));
  const pollIntervalMs = Math.max(10, Math.min(250,
    Number(config.rnbo?.phaseAlignment?.phaseAckPollIntervalMs)
      || Number(config.rnbo?.phaseAlignment?.startAckPollIntervalMs)
      || 100));
  const deadline = Date.now() + timeoutMs;
  let acknowledgements = [];
  do {
    acknowledgements = await Promise.all(supported.map(async (target) => {
      const baseline = baselines?.[target.id];
      const observed = await readClockPhaseAck(config, runtime, target);
      const counterAdvanced = Number.isFinite(baseline?.counter)
        ? Number.isFinite(observed.counter) && observed.counter !== baseline.counter
        : Number.isFinite(observed.counter);
      const stageMatched = Number.isFinite(observed.stage)
        && Math.abs(observed.stage - Number(expectedStage)) < 0.000001;
      return {
        targetId: target.id,
        baselineCounter: baseline?.counter ?? null,
        counter: observed.counter ?? null,
        stage: observed.stage ?? null,
        acknowledged: counterAdvanced && stageMatched,
        error: observed.error ?? ""
      };
    }));
    if (acknowledgements.every(({ acknowledged }) => acknowledged) || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    required: true,
    supported: true,
    verified: acknowledgements.length === supported.length
      && acknowledgements.every(({ acknowledged }) => acknowledged),
    expectedStage,
    targetCount: supported.length,
    acknowledgements
  };
}

async function readClockStartAck(config, runtime, target) {
  const url = rnboOscQueryValueUrl(target, target.clockStartAckPath);
  if (!url) return {};
  const timeoutMs = Math.max(100, Math.min(2000,
    Number(config.rnbo?.phaseAlignment?.startAckReadTimeoutMs) || 2000));
  const fetchImpl = runtime.rnboAckFetch ?? runtime.rnboStageFetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const value = Array.isArray(body?.VALUE) ? body.VALUE : [];
    const counter = Number(value[0]);
    const stage = Number(value[1]);
    return {
      counter: Number.isFinite(counter) ? counter : undefined,
      stage: Number.isFinite(stage) ? stage : undefined
    };
  } catch (error) {
    return { error: messageForError(error) };
  }
}

async function readClockPhaseAck(config, runtime, target) {
  const url = rnboOscQueryValueUrl(target, target.clockPhaseAckPath);
  if (!url) return {};
  const timeoutMs = Math.max(100, Math.min(2000,
    Number(config.rnbo?.phaseAlignment?.startAckReadTimeoutMs) || 2000));
  const fetchImpl = runtime.rnboAckFetch ?? runtime.rnboStageFetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const value = Array.isArray(body?.VALUE) ? body.VALUE : [];
    const counter = Number(value[0]);
    const stage = Number(value[1]);
    return {
      counter: Number.isFinite(counter) ? counter : undefined,
      stage: Number.isFinite(stage) ? stage : undefined
    };
  } catch (error) {
    return { error: messageForError(error) };
  }
}

async function verifyExternalTransportPhase(score, config, runtime, phaseTargets) {
  const expected = new Set(phaseTargets.map(({ id }) => optionalString(id)).filter(Boolean));
  const timeoutMs = Math.max(0, Math.min(5000, Number(config.rnbo?.phaseAlignment?.verifyTimeoutMs) || 0));
  const pollIntervalMs = Math.max(10, Math.min(500,
    Number(config.rnbo?.phaseAlignment?.verifyPollIntervalMs) || 100));
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    const directReadAvailable = phaseTargets.every((target) => rnboCurrentStageUrl(target));
    let targets;
    let readError = "";
    if (directReadAvailable) {
      try {
        targets = await readPhaseTargetsDirect(config, runtime, phaseTargets);
      } catch (error) {
        targets = [];
        readError = messageForError(error);
      }
    } else {
      await runtime.rnboStageCollector?.refresh?.(phaseTargets);
      targets = runtime.rnboStageCollector?.targets?.(phaseTargets) ?? phaseTargets;
    }
    const contracts = cachedPlaybackTimingContracts(score, config, runtime, targets);
    const witness = readError
      ? { source: "rnbo-client", usable: false, fresh: false, reason: readError }
      : projectedPhaseWitness(score, config, targets, contracts);
    const complete = targets.length === expected.size && contracts.length === expected.size;
    result = {
      verified: complete && witness.usable === true && witness.targetCount === expected.size,
      complete,
      observedAt: new Date().toISOString(),
      targetCount: targets.length,
      expectedTargetCount: expected.size,
      witness
    };
    if (result.verified || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return result;
}

async function readPhaseTargetsDirect(config, runtime, targets) {
  const timeoutMs = Math.max(100, Math.min(5000,
    Number(config.rnbo?.phaseAlignment?.verifyReadTimeoutMs) || 2000));
  const fetchImpl = runtime.rnboStageFetch ?? globalThis.fetch;
  const observations = await Promise.all(targets.map(async (target) => {
    const requestedAt = Date.now();
    const response = await fetchImpl(rnboCurrentStageUrl(target), {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`${target.id} current_stage HTTP ${response.status}`);
    const body = await response.json();
    const value = Array.isArray(body?.VALUE) ? body.VALUE[0] : body?.VALUE;
    const currentStage = Number(value);
    if (!Number.isFinite(currentStage)) throw new Error(`${target.id} current_stage is unavailable`);
    const observedAt = Date.now();
    return { target, currentStage, midpoint: requestedAt + ((observedAt - requestedAt) / 2) };
  }));
  const commonNow = Date.now();
  return observations.map(({ target, currentStage, midpoint }) => ({
    ...target,
    currentStage,
    stateAgeMs: Math.max(0, commonNow - midpoint),
    fresh: true,
    // This direct read is made after the Clock On acknowledgement barrier.
    // Do not retain a stale collector classification from before the start.
    stageMovement: "moving",
    stageReadbackStatus: "fresh"
  }));
}

function projectedPhaseWitness(score, config, targets, contracts) {
  const movementWitness = rnboClientBeatWitness({
    targets,
    contracts,
    maxSkewBeats: Number.MAX_SAFE_INTEGER,
    requireMoving: false
  });
  if (!movementWitness.usable) return movementWitness;

  const activeBlockId = score.structureState?.activeBlockId ?? "";
  const tempo = Number(score.mesostructure?.[activeBlockId]?.tempo)
    || Number(config.rnbo?.transport?.Tempo)
    || 120;
  const projected = targets.flatMap((target) => {
    const contract = contracts.find((entry) => optionalString(entry.targetId) === optionalString(target.id));
    const stagesPerBeat = Number(contract?.timing?.stagesPerBeat);
    const patternLength = Number(contract?.timing?.patternLength);
    if (!Number.isFinite(target.currentStage)
      || target.fresh === false
      || ["stale", "error"].includes(target.stageReadbackStatus)
      || !Number.isFinite(stagesPerBeat) || stagesPerBeat <= 0
      || !Number.isFinite(patternLength) || patternLength <= 0) {
      return [];
    }
    return [{
      targetId: target.id,
      stage: extrapolatedStage(target, stagesPerBeat, patternLength, tempo),
      stagesPerBeat,
      patternLength
    }];
  });
  if (projected.length !== targets.length || projected.length === 0) {
    return { ...movementWitness, usable: false, reason: "incomplete projected RNBO phase" };
  }
  const source = projected[0];
  const compatible = projected.every((entry) =>
    entry.stagesPerBeat === source.stagesPerBeat && entry.patternLength === source.patternLength);
  const offsets = compatible
    ? projected.map((entry) => ({
        targetId: entry.targetId,
        stage: entry.stage,
        offsetStages: circularStageOffset(entry.stage, source.stage, source.patternLength)
      }))
    : [];
  const aligned = compatible && offsets.every(({ offsetStages }) => offsetStages === 0);
  return {
    ...movementWitness,
    usable: aligned,
    fresh: aligned,
    projectedStages: projected.map(({ targetId, stage }) => ({ targetId, stage })),
    offsets,
    reason: aligned ? "projected RNBO addresses aligned" : "projected RNBO address skew"
  };
}

function externalPhaseAlignmentResult(reason) {
  return { applied: false, reason, writes: [] };
}

function extrapolatedStage(target, stagesPerBeat, patternLength, tempo) {
  const ageMs = Math.max(0, Number(target.stateAgeMs) || 0);
  const elapsedStages = ageMs * tempo * stagesPerBeat / 60000;
  return positiveModulo(Math.floor(Number(target.currentStage) + elapsedStages), patternLength);
}

function circularStageOffset(stage, sourceStage, patternLength) {
  const forward = positiveModulo(stage - sourceStage, patternLength);
  return forward > patternLength / 2 ? forward - patternLength : forward;
}

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function externalTransportAnchor(body, unitId, context = {}) {
  const explicitBeat = Number(body.beatIntoBlock);
  if (Number.isFinite(explicitBeat)) {
    return {
      beatIntoBlock: Math.max(0, explicitBeat),
      source: "external-intent",
      unitId
    };
  }

  const targets = context.rnboTargets ?? [];
  const timingContracts = context.timingContracts ?? [];
  const unitTargets = unitId
    ? targets.filter((target) => [target.hardwareUnitId, target.hardwareUnitName]
      .some((value) => optionalString(value) === unitId))
    : [];
  const unitTargetIds = new Set(unitTargets.map((target) => optionalString(target.id)).filter(Boolean));
  const unitContracts = timingContracts.filter((contract) => unitTargetIds.has(optionalString(contract.targetId)));
  const unitWitness = rnboClientBeatWitness({
    targets: unitTargets,
    contracts: unitContracts,
    maxSkewBeats: context.rnboClient?.maxSkewBeats
  });
  if (unitWitness.usable && Number.isFinite(unitWitness.absoluteBeat)) {
    return {
      beatIntoBlock: Math.max(0, unitWitness.absoluteBeat),
      source: "rnbo-client",
      unitId,
      targetId: unitWitness.targetId ?? ""
    };
  }

  const ensembleWitness = rnboClientBeatWitness({
    targets,
    contracts: timingContracts,
    maxSkewBeats: context.rnboClient?.maxSkewBeats
  });
  if (ensembleWitness.usable && Number.isFinite(ensembleWitness.absoluteBeat)) {
    return {
      beatIntoBlock: Math.max(0, ensembleWitness.absoluteBeat),
      source: "rnbo-client",
      unitId,
      targetId: ensembleWitness.targetId ?? ""
    };
  }

  return {
    beatIntoBlock: 0,
    source: "default",
    unitId,
    reason: unitWitness.reason || ensembleWitness.reason || "RNBO current_stage readback unavailable"
  };
}

async function awaitRnboPlaybackReady(runtime, score) {
  const readiness = await rnboPlaybackReadiness(runtime, score, { waitForIdle: true });
  if (!runtime.rnboAdapter?.enabled) return readiness;
  if (!readiness.ready) {
    throw new Error(`RNBO playback is not ready: ${readiness.failures.join(", ")}`);
  }
  return readiness;
}

async function rnboPlaybackReadiness(runtime, score, { waitForIdle = false } = {}) {
  if (!runtime.rnboAdapter?.enabled) {
    return { ready: true, allActive: false, source: "disabled", failures: [], queue: null };
  }
  if (waitForIdle && typeof runtime.rnboAdapter.waitForIdle === "function") {
    await runtime.rnboAdapter.waitForIdle();
  }
  const assignedTargetKeys = new Set(Object.values(score.assignments ?? {})
    .flatMap((assignment) => [assignment?.rnboTargetId, assignment?.rnboAddress])
    .map(optionalString)
    .filter(Boolean));
  const assignedTargetIds = new Set(Object.values(score.assignments ?? {})
    .map((assignment) => optionalString(assignment?.rnboTargetId))
    .filter(Boolean));
  if (typeof runtime.rnboAdapter.playbackUpdates === "function") {
    const updates = await runtime.rnboAdapter.playbackUpdates(score.structureState?.activeBlockId ?? "");
    const entries = Object.entries(updates?.targets ?? {})
      .filter(([targetId, update]) => assignedTargetKeys.size === 0 || assignedTargetKeys.has(optionalString(targetId))
        || assignedTargetKeys.has(optionalString(update?.targetId)));
    if (entries.length) {
      const presentTargetIds = new Set(entries.flatMap(([targetId, update]) => [optionalString(targetId), optionalString(update?.targetId)]).filter(Boolean));
      const missing = [...assignedTargetIds].filter((targetId) => !presentTargetIds.has(targetId));
      const failures = entries
        .filter(([, update]) => !["active", "prepared"].includes(update?.state))
        .map(([targetId, update]) => `${targetId} ${update?.state ?? "unknown"}`);
      failures.push(...missing.map((targetId) => `${targetId} missing`));
      return {
        ready: failures.length === 0,
        allActive: missing.length === 0 && entries.every(([, update]) => update?.state === "active"),
        source: "playback-updates",
        failures,
        queue: runtime.rnboAdapter.sendQueueStatus?.() ?? { inProgress: false, queued: false },
        updates
      };
    }
  }
  const statuses = runtime.rnboAdapter.sendStatus?.() ?? [];
  const relevantStatuses = assignedTargetKeys.size === 0
    ? statuses
    : statuses.filter((status) => assignedTargetKeys.has(optionalString(status.targetId))
      || assignedTargetKeys.has(optionalString(status.address)));
  const failed = relevantStatuses.filter((status) => status.ack?.ok === false);
  return {
    ready: failed.length === 0,
    allActive: false,
    source: "send-status",
    failures: failed.map((status) => `${status.targetId} ${status.ack?.status ?? "failed"}`),
    queue: runtime.rnboAdapter.sendQueueStatus?.() ?? { inProgress: false, queued: false }
  };
}

async function stopUnifiedTransport(store, config, runtime, body = {}) {
  const playback = requireMacroPlayback(runtime);
  const performance = performanceTransportFor(runtime);
  if (!performance.playersPlaying) {
    playback.stop();
    return { idempotent: true, jackStop: null, clockWrites: [], oscClockWrites: [] };
  }
  const targetId = optionalString(body.targetId);
  const score = store.getScore();
  const [clockWrites, oscClockWrites] = await Promise.all([
    writeTransportControlsToPlaybackTargets(score, config, runtime, { Clock: 0 }, { targetId }),
    writeOscSequencerClocks(score, config, runtime, "Off")
  ]);
  playback.stop();
  const jackStop = await maybeStopJack(runtime);
  performance.playersPlaying = false;
  performance.playerControlOrigin = "none";
  performance.adoptionPayloadVerified = null;
  return {
    jackStop,
    clockWrites,
    oscClockWrites
  };
}

async function writeOscSequencerClocks(score, config, runtime, value) {
  const targets = buildOscTargets(await readAllOscTargets(config, runtime));
  const resolutions = resolveOscAssignments(score.oscAssignments ?? {}, targets);
  const selected = new Map();
  for (const [roleId, resolution] of Object.entries(resolutions)) {
    const assignment = score.oscAssignments?.[roleId] ?? {};
    const app = optionalString(assignment.app || resolution.target?.app).toLowerCase();
    const target = resolution.target;
    if (!OSC_SEQUENCER_APPS.has(app) || !target || !["online", "ignored"].includes(resolution.status)) continue;
    if (!(target.parameters ?? []).some((parameter) => parameter.name === "Clock")) continue;
    selected.set(target.id, target);
  }
  if (selected.size === 0) return [];
  const result = await sendOscToResolvedTargets([...selected.values()], runtime, {
    param: "Clock",
    args: [value]
  });
  return result.results;
}

async function runArrangement(store, config, runtime, body = {}) {
  const playback = requireMacroPlayback(runtime);
  const performance = performanceTransportFor(runtime);
  if (!performance.playersPlaying) {
    const error = new Error("Players are stopped; start Players before running the arrangement");
    error.statusCode = 409;
    throw error;
  }
  const continuingClockContract = await requireStableContinuingClockContract(store.getScore(), config, runtime);
  performance.arrangementRequestedMode = "run";
  if (playback.snapshot().running) {
    return { idempotent: true, continuingClockContract, playback: playback.snapshot() };
  }
  const mode = await playbackStartMode(store.getScore(), config, runtime, optionalString(body.mode));
  return {
    idempotent: false,
    continuingClockContract,
    playback: playback.start({
      mode,
      reset: Boolean(body.reset),
      sourceClientId: "arrangement"
    })
  };
}

async function requireStableContinuingClockContract(score, config, runtime) {
  const targets = await readAllRnboTargets(config, runtime);
  const result = continuingClockContractForArrangement(score, config, targets);
  if (result.applies && !result.stable) {
    const variants = result.variants
      .map(({ blockId, targetId, ticksPerStage }) => `${blockId}/${targetId}=${ticksPerStage}`)
      .join(", ");
    const error = new Error(
      `Uninterrupted continuing activation requires one ClockInterval across the arrangement; observed ${variants}`
    );
    error.code = "UNSTABLE_CONTINUING_CLOCK_CONTRACT";
    error.statusCode = 409;
    error.contract = result;
    throw error;
  }
  return result;
}

export function continuingClockContractForArrangement(score, config, targets = []) {
  const blocks = [...new Set(score.macrostructure?.blocks ?? [])]
    .filter((blockId) => score.mesostructure?.[blockId]);
  const continuingTargets = targets.filter((target) =>
    target.available !== false
    && target.capabilities?.continuingScoreActivation === true
    && assignedVoiceForTarget(score, target)
  );
  if (blocks.length < 2 || continuingTargets.length === 0) {
    return { applies: false, stable: true, ticksPerStage: null, variants: [] };
  }

  const contracts = blocks.flatMap((blockId, macroIndex) => {
    const blockScore = {
      ...score,
      structureState: { ...score.structureState, activeBlockId: blockId, macroIndex }
    };
    return continuingTargets.map((target) => {
      const voiceId = assignedVoiceForTarget(score, target);
      const compiled = compileScoreTransaction(blockScore, config, 0, { ...target, voiceId });
      return {
        blockId,
        targetId: target.id ?? "",
        ticksPerStage: compiled.timing.ticksPerStage
      };
    });
  });
  const distinct = new Set(contracts.map(({ ticksPerStage }) => Number(ticksPerStage).toPrecision(12)));
  return {
    applies: true,
    stable: distinct.size === 1,
    ticksPerStage: distinct.size === 1 ? contracts[0].ticksPerStage : null,
    variants: contracts
  };
}

function holdArrangement(runtime) {
  const playback = requireMacroPlayback(runtime);
  const performance = performanceTransportFor(runtime);
  performance.arrangementRequestedMode = "hold";
  const wasRunning = Boolean(playback.snapshot().running);
  return {
    idempotent: !wasRunning,
    playback: playback.stop()
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

export async function applyLiveTempo(store, config, runtime, tempo) {
  const bpm = positiveNumber(tempo, "bpm");
  const jack = await maybeSendJackTempo(runtime, bpm);
  let rnboWrites = [];
  if (config.transport?.tempoAuthority === "server") {
    rememberRnboTransportControls(config, { Tempo: bpm });
    rnboWrites = await writeTransportControlsToPlaybackTargets(
      store.getScore(),
      config,
      runtime,
      { Tempo: bpm }
    );
  }
  const clockIntervalWrites = await reassertPlaybackClockIntervals(store.getScore(), config, runtime);
  rnboWrites.push(...clockIntervalWrites);
  return { jack, rnboWrites };
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

export async function readBeatWitnessContext(score, config, runtime) {
  let rnboTargets = await readAllRnboTargets(config, runtime);
  if (runtime.rnboStageCollector?.ensureObservations) {
    await runtime.rnboStageCollector.ensureObservations(rnboTargets);
    rnboTargets = runtime.rnboStageCollector.targets(rnboTargets);
  }
  const timingContracts = cachedPlaybackTimingContracts(score, config, runtime, rnboTargets);
  return {
    rnboTargets,
    timingContracts,
    rnboClient: config.transport?.rnboClient ?? {}
  };
}

async function readExternalPhaseWitnessContext(score, config, runtime) {
  const cachedTargets = runtime.sessionRuntimeCache?.rnboTargets;
  const targets = Array.isArray(cachedTargets) && cachedTargets.length
    ? cachedTargets.filter((target) => target.available !== false)
    : (await readAllRnboTargets(config, runtime)).filter((target) => target.available !== false);
  if (!targets.length || !targets.every((target) => rnboCurrentStageUrl(target))) {
    return readBeatWitnessContext(score, config, runtime);
  }

  const timeoutMs = Math.max(0, Math.min(5000,
    Number(config.rnbo?.phaseAlignment?.verifyTimeoutMs) || 0));
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const rnboTargets = await readPhaseTargetsDirect(config, runtime, targets);
      return {
        rnboTargets,
        timingContracts: cachedPlaybackTimingContracts(score, config, runtime, rnboTargets),
        rnboClient: config.transport?.rnboClient ?? {}
      };
    } catch (error) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);
  return readBeatWitnessContext(score, config, runtime);
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
    resumableScoreReplace: compiled.resumableScoreReplace === true,
    resumedRowCount: compiled.resumedRowCount ?? 0,
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

function rnboTransferStatus(runtime) {
  return runtime.rnboAdapter?.transferStatus?.() ?? {
    observedAt: new Date().toISOString(),
    summary: {
      targetCount: 0,
      inProgressCount: 0,
      readyCount: 0,
      liveCount: 0,
      failedCount: 0
    },
    targets: {},
    history: []
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
