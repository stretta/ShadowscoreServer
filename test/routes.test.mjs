import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { continuingClockContractForArrangement, distributeTtidForBlock, recallOscSnapshotsForBlock, routeRequest } from "../src/http/routes.mjs";
import { createOscSnapshotAutoRecall } from "../src/osc/snapshot-auto-recall.mjs";
import { createMacroPlayback } from "../src/playback/macro-playback.mjs";
import { createPeerRegistry } from "../src/registration/peer-registry.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";
import { createJackTransportState } from "../src/transport/jack-transport-state.mjs";

test("assignment routes expose, replace, and clear voice assignments", async () => {
  const context = createRouteContext();

  const saved = await requestJson(context, "POST", "/voices/player-1/assignment", {
    assignee: "Ari",
    deviceId: "shadowbox-05"
  });
  assert.equal(saved.assignments["player-1"].assignee, "Ari");

  const assignments = await requestJson(context, "GET", "/assignments");
  assert.equal(assignments["player-1"].deviceId, "shadowbox-05");

  const cleared = await requestJson(context, "DELETE", "/voices/player-1/assignment");
  assert.equal(cleared.assignments["player-1"].assignee, "");
});

test("coordinator routes expose discovery and change the local selection", async () => {
  const calls = [];
  const snapshot = {
    local: { id: "elm", name: "Elm", url: "http://elm.local:8790" },
    selection: { mode: "local", coordinatorId: "elm", coordinatorUrl: "http://elm.local:8790" },
    registration: { active: false, lastRegistrationAt: "", lastError: "" },
    candidates: [{ id: "birch", name: "birch", shadowscoreUrl: "http://birch.local:8790", shadowscoreAvailable: true }]
  };
  const context = createRouteContext({
    runtime: {
      coordinator: {
        async snapshot(options) { calls.push(["snapshot", options]); return snapshot; },
        async select(body) { calls.push(["select", body]); return { ...snapshot, selection: body }; },
        async claim() { calls.push(["claim"]); return { ...snapshot, claimed: true, results: [] }; }
      }
    }
  });

  const current = await requestJson(context, "GET", "/coordinator?refresh=true");
  assert.equal(current.local.id, "elm");
  const selected = await requestJson(context, "POST", "/coordinator/select", {
    mode: "remote",
    coordinatorId: "birch",
    coordinatorUrl: "http://birch.local:8790"
  });
  assert.equal(selected.selection.coordinatorId, "birch");
  const claimed = await requestJson(context, "POST", "/coordinator/claim", {});
  assert.equal(claimed.claimed, true);
  assert.deepEqual(calls, [
    ["snapshot", { refresh: true }],
    ["select", { mode: "remote", coordinatorId: "birch", coordinatorUrl: "http://birch.local:8790" }],
    ["claim"]
  ]);
});

test("assignment route rejects duplicate RNBO targets", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "rnbo-inst-5:shadowscore",
    rnboHost: "192.168.68.96",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/5/messages/in/shadowscore"
  });

  const response = await request(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "rnbo-inst-5:shadowscore",
    rnboHost: "192.168.68.96",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/5/messages/in/shadowscore"
  });

  assert.equal(response.status, 400);
  assert.match(response.body, /RNBO target 'rnbo-inst-5:shadowscore' is already assigned to player-1/);
});

test("OSC assignment routes manage logical roles separately with revision checks", async () => {
  const context = createRouteContext();

  const saved = await requestJson(context, "PUT", "/osc/assignments/analog-a", {
    expectedScoreRevision: 0,
    label: "Analog A",
    app: "analogsequencer",
    deviceId: "heron",
    oscTargetId: "heron:analogsequencer:main",
    ignoreRecall: true,
    ignoreScale: true
  });
  assert.equal(saved.oscAssignments["analog-a"].ignoreRecall, true);
  assert.equal(saved.oscAssignments["analog-a"].ignoreScale, true);
  assert.equal(saved.assignments["player-1"].deviceId, "");

  const assignments = await requestJson(context, "GET", "/osc/assignments");
  assert.equal(assignments["analog-a"].app, "analogsequencer");

  const stale = await request(context, "PUT", "/osc/assignments/plate-a", {
    expectedScoreRevision: 0,
    app: "plate"
  });
  assert.equal(stale.status, 400);
  assert.match(stale.body, /stale score revision 0; current score revision is 1/);

  const removed = await requestJson(context, "DELETE", "/osc/assignments/analog-a?expectedScoreRevision=1");
  assert.deepEqual(removed.oscAssignments, {});
});

test("OSC assignment status and reconciliation resolve returning instances without changing clips or layers", async () => {
  const controlTarget = {
    id: "rnbo-inst-42:plate",
    localId: "rnbo-inst-42:plate",
    label: "Plate 42",
    host: "192.168.68.101",
    port: 1234,
    baseAddress: "/rnbo/inst/42",
    app: "plate",
    instance: "main",
    hardwareUnitId: "heron",
    deviceId: "heron",
    available: true,
    parameters: [{ name: "Decay", address: "/rnbo/inst/42/params/Decay" }]
  };
  const context = createRouteContext({
    runtime: {
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [controlTarget]; }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/plate-a", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:old"
  });
  await createOscClipLayer(context, "A", "plate-a", "plate-opening", {
    app: "plate",
    params: { Decay: 0.5 },
    inputPorts: {}
  });

  const status = await requestJson(context, "GET", "/osc/assignments?resolved=1");
  assert.equal(status.assignments["plate-a"].oscTargetId, "heron:plate:old");
  assert.equal(status.resolutions["plate-a"].status, "online");
  assert.equal(status.resolutions["plate-a"].targetId, "heron:plate:main");

  const reconciled = await requestJson(context, "POST", "/osc/assignments/reconcile");
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.assignments["plate-a"].oscTargetId, "heron:plate:main");
  assert.equal(reconciled.resolutions["plate-a"].sendable, true);
  assert.equal(reconciled.score.mesostructure.A.oscLayers["plate-a"].clipId, "plate-opening");
  assert.equal(reconciled.score.oscClips["plate-opening"].params.Decay, 0.5);

  const unchanged = await requestJson(context, "POST", "/osc/assignments/reconcile");
  assert.equal(unchanged.changed, false);
});

test("OSC assignment reconciliation reports ambiguous compatible instances without retargeting", async () => {
  const context = createRouteContext({
    runtime: {
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return ["main", "aux"].map((instance, index) => ({
            id: `rnbo-inst-${index + 1}:plate`,
            localId: `rnbo-inst-${index + 1}:plate`,
            host: "192.168.68.101",
            port: 1234,
            baseAddress: `/rnbo/inst/${index + 1}`,
            app: "plate",
            instance,
            hardwareUnitId: "heron",
            deviceId: "heron",
            available: true,
            parameters: [{ name: "Decay", address: `/rnbo/inst/${index + 1}/params/Decay` }]
          }));
        }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/plate-a", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:old"
  });

  const reconciled = await requestJson(context, "POST", "/osc/assignments/reconcile");
  assert.equal(reconciled.resolutions["plate-a"].status, "ambiguous");
  assert.equal(reconciled.assignments["plate-a"].oscTargetId, "heron:plate:old");
  assert.equal(reconciled.assignments["plate-a"].routingStatus, "ambiguous");
});

test("admin reset route clears requested score sections", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);
  await requestJson(context, "POST", "/clips/a-player-1", { notes: [{ pitch: 67 }] });
  await requestJson(context, "POST", "/voices/player-1/assignment", { assignee: "Ari" });

  const reset = await requestJson(context, "POST", "/admin/reset", {
    notes: true,
    assignments: true
  });

  assert.deepEqual(reset.voices["player-1"].notes, []);
  assert.deepEqual(reset.clips["a-player-1"].notes, []);
  assert.equal(reset.assignments["player-1"].assignee, "");
});

test("admin page is served as html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/admin");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Shadowscore Lab Admin/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /Session link/);
  assert.match(response.body, /Download backup/);
  assert.match(response.body, /Saved scores/);
  assert.match(response.body, /id="saved-score-select"/);
  assert.match(response.body, /id="load-saved-score"/);
  assert.match(response.body, /id="remove-saved-score"/);
  assert.doesNotMatch(response.body, /id="saved-scores"/);
  assert.match(response.body, /\/admin\/scores/);
  assert.match(response.body, /New score/);
  assert.match(response.body, /\/admin\/scores\/new/);
  assert.match(response.body, /Refresh routing/);
  assert.match(response.body, /\/assignments\/reconcile/);
  assert.match(response.body, /Live Client/);
  assert.match(response.body, /Routing/);
  assert.match(response.body, /Import voice notes to clips/);
  assert.match(response.body, /\/admin\/import-legacy-voice-notes/);
  assert.match(response.body, /Resend RNBO score/);
  assert.match(response.body, /rnbo-send-state/);
  assert.match(response.body, /RNBO resend in progress/);
  assert.match(response.body, /Last commit/);
  assert.match(response.body, /\/admin\/rnbo\/resend/);
  assert.match(response.body, /previousTargetInventory !== rnboTargetInventory\(discoveredTargets\)/);
  assert.match(response.body, /voice\.assignment\.reconciled/);
  assert.match(response.body, /OSCQuery Devices/);
  assert.match(response.body, /OSC control roles/);
  assert.match(response.body, /id="osc-role-form"/);
  assert.match(response.body, /id="osc-role-form" novalidate/);
  assert.match(response.body, /id="osc-role-status" role="status" aria-live="polite"/);
  assert.match(response.body, /suggestOscRoleFromTarget/);
  assert.match(response.body, /selectOscRoleDevice/);
  assert.match(response.body, /selectedOscRoleTargetId \|\| currentAssignment\.oscTargetId/);
  assert.match(response.body, /selectedOscRoleDeviceId \|\| currentAssignment\.deviceId/);
  assert.match(response.body, /Live OSC instance/);
  assert.match(response.body, /Create role/);
  assert.match(response.body, /Add to current score/);
  assert.match(response.body, /\/osc\/onboard/);
  assert.match(response.body, /Role ID must start with a letter or number/);
  assert.match(response.body, /Ignore Shadowscore recall/);
  assert.match(response.body, /Lock target mapping/);
  assert.match(response.body, /OSC score resources/);
  assert.match(response.body, /\/osc\/resources/);
  assert.match(response.body, /\/osc\/assignments\/reconcile/);
  const inlineScript = response.body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.doesNotThrow(() => new Function(inlineScript));
  assert.match(response.body, /Add device/);
  assert.match(response.body, /\/oscquery\/devices/);
});

test("admin RNBO resend route asks the adapter to resend the current score", async () => {
  let reason = "";
  let version = 0;
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        sendQueueStatus() {
          return {
            inProgress: true,
            queued: false,
            active: { scoreVersion: version, reasons: ["admin"], transactionId: 12 },
            queuedRequest: null
          };
        },
        async resendCurrentScore(nextReason) {
          reason = nextReason;
          version = context.store.getScore().version;
          return { noteCount: 2, patternLength: 64 };
        }
      }
    }
  });

  const result = await requestJson(context, "POST", "/admin/rnbo/resend");

  assert.equal(result.ok, true);
  assert.equal(result.mode, "default");
  assert.equal(reason, "admin");
  assert.equal(version, context.store.getScore().version);
  assert.equal(result.sendQueue.inProgress, true);
  assert.equal(result.sendQueue.active.transactionId, 12);
});

test("admin RNBO resend route can force a full-clear resend", async () => {
  let options;
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async resendCurrentScore(reason, nextOptions) {
          options = { reason, ...nextOptions };
          return { noteCount: 0, transmittedRowCount: 819, forceFullClearRows: true };
        }
      }
    }
  });

  const result = await requestJson(context, "POST", "/admin/rnbo/resend?mode=full-clear");

  assert.equal(result.ok, true);
  assert.equal(result.mode, "full-clear");
  assert.deepEqual(options, { reason: "admin-full-clear", forceFullClearRows: true });
  assert.deepEqual(result.sendQueue, {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  });
});

test("session route exposes host metadata and voice assignments", async () => {
  const context = createRouteContext();
  const session = await requestJson(context, "GET", "/session");

  assert.equal(session.ensembleId, "berklee-b51");
  assert.equal(session.scoreRevision, 0);
  assert.equal(session.structureRevision, 0);
  assert.equal(session.server.role, "host");
  assert.equal(session.endpoints.app, "http://127.0.0.1/");
  assert.equal(session.endpoints.collab, "ws://127.0.0.1/collab");
  assert.equal(session.endpoints.eventList, "http://127.0.0.1/event-list");
  assert.equal(session.endpoints.pianoRoll, "http://127.0.0.1/piano-roll");
  assert.equal(session.endpoints.structureEditor, "http://127.0.0.1/structure-editor");
  assert.equal(session.endpoints.structure, "http://127.0.0.1/structure");
  assert.equal(session.endpoints.structurePlayhead, "http://127.0.0.1/structure/playhead");
  assert.equal(session.endpoints.macroPlayback, "http://127.0.0.1/macrostructure/playback");
  assert.equal(session.endpoints.playbackTimingContracts, "http://127.0.0.1/playback/timing-contracts");
  assert.equal(session.endpoints.transport, "http://127.0.0.1/transport");
  assert.equal(session.endpoints.transportEvents, "http://127.0.0.1/transport/events");
  assert.equal(session.endpoints.transportStatus, "http://127.0.0.1/transport/status");
  assert.equal(session.macroPlayback.running, false);
  assert.equal(session.macroPlayback.compositionBeat, null);
  assert.equal(session.macroPlayback.beatIntoBlock, null);
  assert.equal(session.macroPlayback.macroStartBeat, null);
  assert.equal(session.macroPlayback.witness.source, "none");
  assert.equal(session.transport.status, "unusable");
  assert.equal(session.transport.tempoAuthority, "link");
  assert.equal(session.voices.length, 6);
  assert.equal(session.voices[0].assignment.label, "Player 1");
  assert.equal(session.assignmentPresets[0].id, "six-player-shadowbox");
  assert.equal(session.hardwareUnits.length, 1);
  assert.equal(session.hardwareUnits[0].local, true);
});

test("transport routes store JACK snapshots and report freshness", async () => {
  let now = 1782580000100;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      transport: {
        jack: {
          freshnessMs: 250
        }
      }
    }),
    runtime: {
      jackTransport: createJackTransportState({
        transport: {
          jack: {
            freshnessMs: 250
          }
        }
      }, {
        now: () => now
      })
    }
  });

  const initial = await requestJson(context, "GET", "/transport");
  assert.equal(initial.status, "unusable");
  assert.equal(initial.reason, "no snapshot");
  assert.equal(initial.tempoAuthority, "link");

  const posted = await requestJson(context, "POST", "/transport/jack/snapshot", jackSnapshot());
  assert.equal(posted.ok, true);
  assert.equal(posted.transport.status, "fresh");
  assert.equal(posted.transport.fresh, true);
  assert.equal(posted.transport.tempoAuthority, "link");
  assert.equal(posted.transport.latest.host, "wren");
  assert.equal(posted.transport.latest.receivedAt, 1782580000100);

  now = 1782580000200;
  const fresh = await requestJson(context, "GET", "/transport");
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.ageMs, 100);
  assert.equal(fresh.tempoAuthority, "link");

  now = 1782580000400;
  const stale = await requestJson(context, "GET", "/transport");
  assert.equal(stale.status, "stale");
  assert.equal(stale.stale, true);
  assert.equal(stale.unusable, false);
});

test("external JACK tempo changes do not rewrite beat-relative ClockInterval", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        stagesPerBeat: 16,
        targets: [{
          id: "source-client",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      jackTransport: createJackTransportState(defaultConfig),
      rnboParamWriter: async (write) => writes.push(write)
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "source-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });

  const changed = await requestJson(context, "POST", "/transport/jack/snapshot", jackSnapshot({ beatsPerMinute: 122 }));
  const jitter = await requestJson(context, "POST", "/transport/jack/snapshot", jackSnapshot({ beatsPerMinute: 121.99999 }));

  assert.equal(changed.transport.tempo.live, 122);
  assert.equal(jitter.transport.tempo.live, 122);
  assert.deepEqual(writes, []);
});

test("transport route rejects malformed JACK snapshots", async () => {
  const context = createRouteContext({
    runtime: {
      jackTransport: createJackTransportState(defaultConfig)
    }
  });

  const response = await request(context, "POST", "/transport/jack/snapshot", {
    source: "rnbo",
    host: "wren",
    state: "rolling",
    frame: 1,
    frameRate: 48000,
    bbtValid: false
  });

  assert.equal(response.status, 400);
  assert.match(response.body, /JACK snapshot source must be 'jack'/);
});

test("JACK transport control routes call explicit controller actions", async () => {
  const calls = [];
  const context = createRouteContext({
    runtime: {
      jackController: {
        async start() {
          calls.push(["start"]);
          return { ok: true, action: "start" };
        },
        async stop() {
          calls.push(["stop"]);
          return { ok: true, action: "stop" };
        },
        async locate(frame) {
          calls.push(["locate", frame]);
          return { ok: true, action: "locate", frame };
        },
        async tempo(bpm) {
          calls.push(["tempo", bpm]);
          return { ok: true, action: "tempo", bpm };
        }
      }
    }
  });

  assert.deepEqual(await requestJson(context, "POST", "/transport/jack/start", {}), { ok: true, action: "start" });
  assert.deepEqual(await requestJson(context, "POST", "/transport/jack/stop", {}), { ok: true, action: "stop" });
  assert.deepEqual(await requestJson(context, "POST", "/transport/jack/locate", { frame: 48000 }), {
    ok: true,
    action: "locate",
    frame: 48000
  });
  assert.deepEqual(await requestJson(context, "POST", "/transport/jack/tempo", { bpm: 132.5 }), {
    ok: true,
    action: "tempo",
    bpm: 132.5
  });
  assert.deepEqual(calls, [["start"], ["stop"], ["locate", 48000], ["tempo", 132.5]]);
});

test("JACK transport control routes report unavailable or invalid controls", async () => {
  const unavailable = await request(createRouteContext(), "POST", "/transport/jack/start", {});
  assert.equal(unavailable.status, 501);
  assert.match(unavailable.body, /JACK transport control is not available/);

  const invalidLocate = await request(createRouteContext({
    runtime: {
      jackController: {
        async locate() {
          return { ok: true };
        }
      }
    }
  }), "POST", "/transport/jack/locate", { frame: -1 });
  assert.equal(invalidLocate.status, 400);
  assert.match(invalidLocate.body, /frame must be a non-negative integer/);
});

test("transport events stream sends initial and update snapshots", async () => {
  const context = createRouteContext({
    runtime: {
      jackTransport: createJackTransportState(defaultConfig, { now: () => 1782580000100 })
    }
  });
  const request = createRequest("GET", "/transport/events");
  const response = createResponse();

  await routeRequest(request, response, context.store, context.config, context.runtime);
  assert.equal(response.snapshot().status, 200);
  assert.equal(response.snapshot().headers["Content-Type"], "text/event-stream");
  assert.match(response.snapshot().body, /event: snapshot/);
  assert.match(response.snapshot().body, /"status":"unusable"/);
  assert.match(response.snapshot().body, /"tempoAuthority":"link"/);

  context.runtime.jackTransport.update(jackSnapshot());
  const streamed = response.snapshot().body;
  assert.match(streamed, /"status":"fresh"/);
  assert.match(streamed, /"absoluteBeat":31963\.380208333332/);
  assert.match(streamed, /"tempoAuthority":"link"/);

  request.emit("close");
});

test("RNBO transfer routes expose current progress and stream updates", async () => {
  const transferEvents = new EventEmitter();
  let transfer = {
    observedAt: "2026-08-17T12:00:00.000Z",
    summary: { targetCount: 1, inProgressCount: 1, readyCount: 0, liveCount: 0, failedCount: 0 },
    targets: { finch: { targetId: "finch", state: "sending", expectedRows: 277, sentRows: 120, confirmedRows: 0 } },
    history: []
  };
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        transferEvents,
        transferStatus: () => transfer
      }
    }
  });

  const current = await requestJson(context, "GET", "/rnbo/transfers");
  assert.equal(current.targets.finch.sentRows, 120);

  const request = createRequest("GET", "/rnbo/transfers/events");
  const response = createResponse();
  await routeRequest(request, response, context.store, context.config, context.runtime);
  assert.equal(response.snapshot().headers["Content-Type"], "text/event-stream");
  assert.match(response.snapshot().body, /"sentRows":120/);

  transfer = { ...transfer, targets: { finch: { ...transfer.targets.finch, state: "ready", sentRows: 277, confirmedRows: 277 } } };
  transferEvents.emit("snapshot", transfer);
  assert.match(response.snapshot().body, /"confirmedRows":277/);
  request.emit("close");
});

test("transport status page exposes host transport controls", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/transport/status");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Shadowscore Transport/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /id="start-jack"/);
  assert.match(response.body, /id="start-timer"/);
  assert.match(response.body, /id="reanchor"/);
  assert.match(response.body, /phaseReset: true, forceRestart: true/);
  assert.match(response.body, /id="advance"/);
  assert.match(response.body, /id="reset"/);
  assert.match(response.body, /id="players-play"/);
  assert.match(response.body, /id="players-stop"/);
  assert.match(response.body, /id="arrangement-run"/);
  assert.match(response.body, /id="arrangement-hold"/);
  assert.match(response.body, /id="composition-beat"/);
  assert.match(response.body, /id="beat-into-block"/);
  assert.match(response.body, /transport\.tempo\?\.live/);
  assert.match(response.body, /id="macro-anchor"/);
  assert.match(response.body, /id="phase-reset"/);
  assert.match(response.body, /id="timing-contracts"/);
  assert.match(response.body, /fetchJson\("\/playback\/snapshot"\)/);
  assert.match(response.body, /renderContracts\(snapshot\.timingContracts \|\| \[\]\)/);
  assert.match(response.body, /lastPlaybackGeneration/);
  assert.match(response.body, /Disagrees on/);
  assert.match(response.body, /\/transport\/events/);
  assert.match(response.body, /<details class="toolbar-details" id="transport-diagnostics">/);
  assert.match(response.body, /<details class="toolbar-details" id="recent-transport-events">/);
  assert.match(response.body, /Recent Transport Events/);
  assert.doesNotMatch(response.body, /<details[^>]+id="transport-diagnostics"[^>]+open/);
  assert.doesNotMatch(response.body, /<details[^>]+id="recent-transport-events"[^>]+open/);
  assert.match(response.body, /transport-events-status/);
  assert.match(response.body, /transportEvents\.onerror = \(\) => \{\s+fields\["transport-events-status"\]\.textContent = "Disconnected"/);
  assert.match(response.body, /Cannot reach ShadowScore at/);
  assert.match(response.body, /\/transport\/players\/play/);
  assert.match(response.body, /\/transport\/players\/stop/);
  assert.match(response.body, /\/transport\/arrangement\/run/);
  assert.match(response.body, /\/transport\/arrangement\/hold/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /Join Running Players/);
  assert.match(response.body, /let actionError = ""/);
  assert.match(response.body, /if \(!actionError\) fields\.status\.textContent/);
});

test("playback timing contracts include one entry per playback target", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "left-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          },
          {
            id: "right-client",
            host: "192.168.68.97",
            port: 9000,
            address: "/rnbo/inst/3/messages/in/shadowscore"
          }
        ]
      }
    })
  });

  const contracts = await requestJson(context, "GET", "/playback/timing-contracts");

  assert.equal(contracts.contracts.length, 2);
  assert.deepEqual(contracts.contracts.map((contract) => ({
    targetId: contract.targetId,
    blockId: contract.timing.blockId,
    stagesPerBeat: contract.timing.stagesPerBeat,
    ticksPerStage: contract.timing.ticksPerStage,
    patternLength: contract.timing.patternLength,
    noteCount: contract.noteCount,
    available: contract.available
  })), [
    {
      targetId: "left-client",
      blockId: "A",
      stagesPerBeat: 16,
      ticksPerStage: 30,
      patternLength: 256,
      noteCount: 24,
      available: true
    },
    {
      targetId: "right-client",
      blockId: "A",
      stagesPerBeat: 16,
      ticksPerStage: 30,
      patternLength: 256,
      noteCount: 24,
      available: true
    }
  ]);
});

test("voice routes add and remove arbitrary voices", async () => {
  const context = createRouteContext();

  const added = await requestJson(context, "POST", "/voices", {
    voiceId: "player-12",
    assignment: { label: "Player 12", color: "#2457a6" }
  });
  assert.equal(added.voices["player-12"].version, 0);
  assert.equal(added.assignments["player-12"].label, "Player 12");

  const session = await requestJson(context, "GET", "/session");
  assert.equal(session.voices.some((voice) => voice.id === "player-12"), true);

  const removed = await requestJson(context, "DELETE", "/voices/player-12");
  assert.equal(removed.voices["player-12"], undefined);
});

test("structure routes expose and mutate meso and macro organization", async () => {
  const context = createRouteContext();

  const initial = await requestJson(context, "GET", "/structure");
  assert.equal(initial.scoreRevision, 0);
  assert.equal(initial.structureRevision, 0);
  assert.deepEqual(Object.keys(initial.mesostructure), ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(initial.macrostructure.blocks, ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(initial.structureState, { activeBlockId: "A", macroIndex: 0 });

  const added = await requestJson(context, "POST", "/mesostructure/G", {
    duration: { bars: 12 },
    players: {
      "player-1": { clipId: "clip-a" }
    }
  });
  assert.equal(added.mesostructure.G.duration.bars, 12);
  assert.equal(added.structureRevision, 1);

  const chained = await requestJson(context, "POST", "/macrostructure", {
    expectedVersion: added.version,
    blocks: ["A", "G", "B"]
  });
  assert.deepEqual(chained.macrostructure.blocks, ["A", "G", "B"]);
  assert.equal(chained.structureRevision, 2);
  assert.equal(chained.macrostructure.expectedVersion, undefined);

  const removed = await requestJson(context, "DELETE", "/mesostructure/G");
  assert.equal(removed.mesostructure.G, undefined);
  assert.deepEqual(removed.macrostructure.blocks, ["A", "B"]);
  assert.equal(removed.structureRevision, 3);
});

test("structure routes reject stale expected structure revisions", async () => {
  const context = createRouteContext();

  const updated = await requestJson(context, "POST", "/mesostructure/A", {
    expectedScoreRevision: 0,
    expectedStructureRevision: 0,
    duration: { bars: 8 },
    players: {}
  });
  assert.equal(updated.structureRevision, 1);

  const rejected = await request(context, "POST", "/macrostructure", {
    expectedScoreRevision: 1,
    expectedStructureRevision: 0,
    blocks: ["A", "B"]
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /stale structure revision 0; current structure revision is 1/);
  assert.match(rejected.body, /"currentScoreRevision":1/);
  assert.match(rejected.body, /"currentStructureRevision":1/);
});

test("harmonic routes expose the catalog and keep direct TTID edits separate from destructive scale transforms", async () => {
  const context = createRouteContext();
  const catalog = await requestJson(context, "GET", "/harmonic/scales");
  assert.deepEqual(catalog.scales.ionian, [0, 2, 4, 5, 7, 9, 11]);

  const originalPitch = context.store.getScore().clips["a-player-1"].notes[0].pitch;
  const direct = await requestJson(context, "PUT", "/mesostructure/A/ttid", {
    expectedScoreRevision: 0,
    ttid: 1,
    auditionTargets: []
  });
  assert.equal(direct.score.mesostructure.A.ttid, 1);
  assert.equal(direct.score.clips["a-player-1"].notes[0].pitch, originalPitch);
  assert.equal(Object.hasOwn(direct, "drift"), false);

  const transformed = await requestJson(context, "POST", "/mesostructure/A/scale-transform", {
    expectedScoreRevision: 1,
    expectedStructureRevision: 0,
    scale: { root_note: 0, scale_name: "Aeolian", scale_intervals: [0, 2, 3, 5, 7, 8, 10] }
  });
  assert.equal(transformed.score.mesostructure.A.scale.scale_name, "Aeolian");
  assert.equal(transformed.score.mesostructure.A.ttid, 1453);
  assert.equal(transformed.summary.blockId, "A");
  assert.equal(transformed.score.structureRevision, 1);
});

test("block Swing route stores one shared groove and does not create per-instance OSC state", async () => {
  const context = createRouteContext();
  const result = await requestJson(context, "PUT", "/mesostructure/A/swing", {
    expectedScoreRevision: 0,
    swing: "On",
    swingAmt: 0.625,
    auditionTargets: []
  });
  assert.equal(result.score.mesostructure.A.swing, 1);
  assert.equal(result.score.mesostructure.A.swingAmt, 0.625);
  assert.deepEqual(result.score.oscClips, {});
  assert.equal(result.distribution.attemptedCount, 0);
});

test("block TTID route sends an inactive block mask only to explicitly selected compatible destinations", async () => {
  const sends = [];
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => { sends.push(write); return { ok: true }; },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return [1, 2].map((index) => ({
            id: `rnbo-inst-${index}:quantizer`,
            localId: `rnbo-inst-${index}:quantizer`,
            host: "192.168.68.101",
            port: 1234,
            baseAddress: `/rnbo/inst/${index}`,
            app: "quantizer",
            instance: String(index),
            hardwareUnitId: "rack",
            deviceId: "rack",
            available: true,
            parameters: [{ name: "Scale", address: `/rnbo/inst/${index}/params/Scale`, meta: { editor: "ttid" } }]
          }));
        }
      }
    }
  });
  const result = await requestJson(context, "PUT", "/mesostructure/B/ttid", {
    expectedScoreRevision: 0,
    ttid: 2741,
    destinationTargets: ["rack:quantizer:2"]
  });
  assert.equal(result.distribution.succeededCount, 1);
  assert.equal(result.distribution.attemptedCount, 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].address, /\/rnbo\/inst\/2\/params\/Scale$/);
});

test("block Swing route sends an inactive block groove only to explicitly selected compatible destinations", async () => {
  const sends = [];
  const apps = ["analogsequencer", "listsequencer", "listvelsequencer", "triggersequencer"];
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => { sends.push(write); return { ok: true }; },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return apps.map((app, index) => ({
            id: `rnbo-inst-${index + 1}:${app}`,
            localId: `rnbo-inst-${index + 1}:${app}`,
            host: "192.168.68.101",
            port: 1234,
            baseAddress: `/rnbo/inst/${index + 1}`,
            app,
            instance: "main",
            hardwareUnitId: "rack",
            deviceId: "rack",
            available: true,
            parameters: [
              { name: "Swing", address: `/rnbo/inst/${index + 1}/params/Clock/Swing`, type: "s", values: ["Off", "On"] },
              { name: "SwingAmt", address: `/rnbo/inst/${index + 1}/params/Clock/SwingAmt` }
            ]
          }));
        }
      }
    }
  });
  const result = await requestJson(context, "PUT", "/mesostructure/B/swing", {
    expectedScoreRevision: 0,
    swing: "On",
    swingAmt: 0.625,
    destinationTargets: ["rack:analogsequencer:main", "rack:triggersequencer:main"]
  });
  assert.equal(result.distribution.succeededCount, 2);
  assert.equal(result.distribution.attemptedCount, 2);
  assert.equal(sends.length, 4);
});

test("OSC clip and block layer routes create, reuse, replace, and safely delete state", async () => {
  const context = createRouteContext();
  await requestJson(context, "PUT", "/osc/assignments/list-a", { app: "listsequencer", deviceId: "finch" });

  const clipped = await requestJson(context, "POST", "/osc/clips", {
    clipId: "list-opening",
    schemaVersion: 1,
    app: "listsequencer",
    params: { ClockRate: 2, Clock: 0 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  });
  assert.equal(clipped.oscClips["list-opening"].params.Clock, 0);
  const saved = await requestJson(context, "PUT", "/mesostructure/F/osc-layers/list-a", { clipId: "list-opening" });
  assert.equal(saved.mesostructure.F.oscLayers["list-a"].clipId, "list-opening");
  await requestJson(context, "PUT", "/mesostructure/E/osc-layers/list-a", { clipId: "list-opening" });

  const clips = await requestJson(context, "GET", "/osc/clips");
  assert.deepEqual(clips["list-opening"].inputPorts.Steps, [1, 0, 1, 0]);
  const layers = await requestJson(context, "GET", "/mesostructure/F/osc-layers");
  assert.equal(layers["list-a"].clipId, "list-opening");
  const references = await requestJson(context, "GET", "/osc/clips/list-opening/references");
  assert.deepEqual(references, {
    clipId: "list-opening",
    references: [{ blockId: "E", roleId: "list-a" }, { blockId: "F", roleId: "list-a" }],
    orphan: false
  });
  const referenceReport = await requestJson(context, "GET", "/osc/clips/references");
  assert.deepEqual(referenceReport.orphanClipIds, []);

  const stale = await request(context, "PUT", "/osc/clips/list-opening", {
    expectedStructureRevision: 0,
    app: "listsequencer",
    params: { Clock: 1 },
    inputPorts: {}
  });
  assert.equal(stale.status, 400);
  assert.match(stale.body, /stale structure revision 0; current structure revision is/);

  const referenced = await request(context, "DELETE", "/osc/clips/list-opening");
  assert.equal(referenced.status, 409);
  assert.match(referenced.body, /F\/list-a/);
  assert.deepEqual(JSON.parse(referenced.body).references, [{ blockId: "E", roleId: "list-a" }, { blockId: "F", roleId: "list-a" }]);
  const removed = await requestJson(context, "DELETE", "/mesostructure/F/osc-layers/list-a");
  assert.deepEqual(removed.mesostructure.F.oscLayers, {});
  await requestJson(context, "DELETE", "/mesostructure/E/osc-layers/list-a");
  const orphaned = await requestJson(context, "GET", "/osc/clips/references");
  assert.deepEqual(orphaned.orphanClipIds, ["list-opening"]);
  const clipRemoved = await requestJson(context, "DELETE", "/osc/clips/list-opening");
  assert.deepEqual(clipRemoved.oscClips, {});

  const missing = await request(context, "GET", "/mesostructure/missing/osc-layers");
  assert.equal(missing.status, 404);
});

test("OSC capture creates and assigns one live instance atomically", async () => {
  const sends = [];
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => sends.push(write),
      oscCaptureDelay: async () => {},
      oscCaptureFetch: async (url) => {
        if (url.endsWith("/params")) return jsonFetchResponse(clockParamsBody("On", { GateTime: 0.4 }));
        if (url.endsWith("/StepsAck")) return jsonFetchResponse({ VALUE: [1, 0, 1, 0] });
        return jsonFetchResponse({}, 404);
      },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [captureControlTarget()]; }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/list-a", { app: "listsequencer", deviceId: "heron" });

  const captured = await requestJson(context, "POST", "/osc/clips/capture", {
    targetId: "heron:listsequencer:main",
    clipId: "list-live-opening",
    name: "Live opening",
    blockId: "F",
    roleId: "list-a"
  });
  assert.equal(captured.complete, true);
  assert.deepEqual(captured.clip.params, { Clock: 1, GateTime: 0.4 });
  assert.deepEqual(captured.clip.inputPorts.Steps, [1, 0, 1, 0]);
  assert.equal(captured.score.mesostructure.F.oscLayers["list-a"].clipId, "list-live-opening");
  assert.deepEqual(sends.map(({ address, args }) => [address, args]), [["/rnbo/inst/2/messages/in/Steps", [-999]]]);

  const versionBeforeFailure = context.store.getScore().version;
  const rejected = await request(context, "POST", "/osc/clips/capture", {
    targetIds: ["heron:listsequencer:main", "other"],
    clipId: "should-not-exist"
  });
  assert.equal(rejected.status, 400);
  assert.equal(context.store.getScore().version, versionBeforeFailure);
  assert.equal(context.store.getScore().oscClips["should-not-exist"], undefined);

  context.runtime.oscCaptureFetch = async (url) => url.endsWith("/params")
    ? jsonFetchResponse(clockParamsBody("On", { GateTime: 0.4 }))
    : jsonFetchResponse({}, 404);
  const incomplete = await request(context, "POST", "/osc/clips/capture", {
    targetId: "heron:listsequencer:main",
    clipId: "incomplete-capture",
    blockId: "F",
    roleId: "list-a"
  });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body, /OSC_CAPTURE_INCOMPLETE/);
  assert.equal(context.store.getScore().version, versionBeforeFailure);
  assert.equal(context.store.getScore().oscClips["incomplete-capture"], undefined);
});

test("OSC onboarding atomically creates and idempotently reuses a role, clip, and active-block layer", async () => {
  let gateTime = 0.4;
  const context = createRouteContext({
    runtime: {
      oscSender: async () => {},
      oscCaptureDelay: async () => {},
      oscCaptureFetch: async (url) => {
        if (url.endsWith("/params")) return jsonFetchResponse(clockParamsBody("On", { GateTime: gateTime }));
        if (url.endsWith("/StepsAck")) return jsonFetchResponse({ VALUE: [1, 0, 1, 0] });
        return jsonFetchResponse({}, 404);
      },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [captureControlTarget()]; }
      }
    }
  });

  const first = await requestJson(context, "POST", "/osc/onboard", {
    targetId: "heron:listsequencer:main",
    roleId: "listsequencer-a",
    roleLabel: "List Sequencer A",
    clipId: "a-listsequencer-a",
    clipName: "List Sequencer A · A"
  });
  assert.equal(first.blockId, "A");
  assert.equal(first.assignment.deviceId, "heron");
  assert.equal(first.assignment.oscTargetId, "heron:listsequencer:main");
  assert.equal(first.clip.params.GateTime, 0.4);
  assert.equal(first.score.mesostructure.A.oscLayers["listsequencer-a"].clipId, "a-listsequencer-a");

  gateTime = 0.75;
  const second = await requestJson(context, "POST", "/osc/onboard", {
    targetId: "heron:listsequencer:main",
    roleId: "listsequencer-a",
    roleLabel: "List Sequencer A",
    clipId: "a-listsequencer-a",
    clipName: "List Sequencer A · A"
  });
  assert.equal(Object.keys(second.score.oscAssignments).length, 1);
  assert.equal(Object.keys(second.score.oscClips).length, 1);
  assert.equal(second.clip.params.GateTime, 0.75);
  const resources = await requestJson(context, "GET", "/osc/resources");
  assert.equal(resources.roles[0].status, "mapped");
  assert.equal(resources.resources[0].status, "mapped");

  const versionBeforeFailure = second.score.version;
  const rejected = await request(context, "POST", "/osc/onboard", {
    targetId: "heron:listsequencer:main",
    roleId: "other-role",
    clipId: "other-clip",
    blockId: "missing"
  });
  assert.equal(rejected.status, 400);
  assert.equal(context.store.getScore().version, versionBeforeFailure);
  assert.equal(context.store.getScore().oscAssignments["other-role"], undefined);
  assert.equal(context.store.getScore().oscClips["other-clip"], undefined);
});

test("Block State upsert onboards state just in time and replaces it in place", async () => {
  const firstTarget = captureControlTarget();
  const context = createRouteContext({
    runtime: {
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [firstTarget]; }
      }
    }
  });
  const snapshot = { schemaVersion: 1, app: "listsequencer", params: { Clock: 0, GateTime: 0.4 }, inputPorts: { Steps: [] } };

  const written = await requestJson(context, "PUT", "/osc/block-state", {
    targets: [firstTarget.id],
    blockId: "A",
    expectedStructureRevision: 0,
    snapshot
  });
  assert.equal(written.targetCount, 1);
  assert.equal(written.writes[0].createdRole, true);
  assert.equal(written.writes[0].roleId, "listsequencer-1");
  assert.deepEqual(written.writes[0].clip.params, snapshot.params);
  assert.equal(written.score.oscAssignments[written.writes[0].roleId].oscTargetId, "heron:listsequencer:main");
  assert.equal(written.score.mesostructure.A.oscLayers[written.writes[0].roleId].clipId, written.writes[0].clipId);

  const replaced = await requestJson(context, "PUT", "/osc/block-state", {
    targets: [firstTarget.id],
    blockId: "A",
    expectedStructureRevision: written.score.structureRevision,
    snapshot: { ...snapshot, params: { ...snapshot.params, GateTime: 0.8 } }
  });
  assert.equal(replaced.writes[0].createdRole, false);
  assert.equal(replaced.writes[0].replaced, true);
  assert.equal(replaced.writes[0].clipId, written.writes[0].clipId);
  assert.equal(replaced.writes[0].clip.params.GateTime, 0.8);
  assert.equal(Object.keys(replaced.score.oscClips).length, 1);

  const cleared = await requestJson(context, "POST", "/osc/block-state/clear", {
    scope: "block",
    blockId: "A",
    expectedStructureRevision: replaced.score.structureRevision
  });
  assert.equal(cleared.clearedCount, 1);
  assert.deepEqual(cleared.score.mesostructure.A.oscLayers, {});
  assert.ok(cleared.score.oscAssignments[written.writes[0].roleId]);
  assert.ok(cleared.score.oscClips[written.writes[0].clipId]);

  const legacyRoute = await request(context, "POST", "/osc/block-state/write", {
    targets: [firstTarget.id],
    blockId: "A",
    expectedStructureRevision: cleared.score.structureRevision,
    snapshot
  });
  assert.equal(legacyRoute.status, 404);

  const legacyPayload = await request(context, "PUT", "/osc/block-state", {
    targetId: firstTarget.id,
    blockId: "A",
    expectedStructureRevision: cleared.score.structureRevision,
    draft: snapshot
  });
  assert.equal(legacyPayload.status, 400);
  assert.match(legacyPayload.body, /targets must include at least one checked instance/);
});

test("Block State upsert atomically saves the displayed state to every checked target", async () => {
  const firstTarget = captureControlTarget();
  const secondTarget = {
    ...captureControlTarget(),
    id: "rnbo-inst-3:listsequencer",
    localId: "rnbo-inst-3:listsequencer",
    label: "List Sequencer 3",
    baseAddress: "/rnbo/inst/3",
    instance: "aux",
    parameters: [
      { name: "Clock", address: "/rnbo/inst/3/params/Clock/Clock" },
      { name: "GateTime", address: "/rnbo/inst/3/params/GateTime" }
    ]
  };
  const context = createRouteContext({
    runtime: {
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [firstTarget, secondTarget]; }
      }
    }
  });
  const snapshot = { schemaVersion: 1, app: "listsequencer", params: { Clock: 1, GateTime: 0.4 }, inputPorts: { Steps: [1, 0, 1] } };
  const written = await requestJson(context, "PUT", "/osc/block-state", {
    targets: [firstTarget.id, secondTarget.id],
    blockId: "A",
    expectedStructureRevision: 0,
    snapshot
  });

  assert.equal(written.targetCount, 2);
  assert.deepEqual(written.writes.map((write) => write.targetId), ["heron:listsequencer:main", "heron:listsequencer:aux"]);
  assert.deepEqual(written.writes.map((write) => write.roleId), ["listsequencer-1", "listsequencer-2"]);
  assert.deepEqual(Object.values(written.score.mesostructure.A.oscLayers).map((layer) => layer.clipId).sort(),
    ["a-listsequencer-1", "a-listsequencer-2"]);
  assert.equal(written.score.structureRevision, 1);
  assert.deepEqual(written.writes[0].clip.params, written.writes[1].clip.params);

  const beforeStale = context.store.getScore();
  const stale = await request(context, "PUT", "/osc/block-state", {
    targets: [firstTarget.id, secondTarget.id],
    blockId: "A",
    expectedStructureRevision: 0,
    snapshot: { ...snapshot, params: { ...snapshot.params, GateTime: 0.6 } }
  });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /stale structure revision 0; current structure revision is 1/);
  assert.deepEqual(context.store.getScore(), beforeStale);

  const duplicated = await requestJson(context, "POST", "/osc/block-state/duplicate", {
    targets: [firstTarget.id, secondTarget.id],
    sourceBlockId: "A",
    destinationBlockId: "B",
    expectedStructureRevision: written.score.structureRevision
  });
  assert.equal(duplicated.copiedCount, 2);
  assert.deepEqual(duplicated.copies.map((copy) => copy.sourceClipId).sort(),
    ["a-listsequencer-1", "a-listsequencer-2"]);
  assert.deepEqual(Object.values(duplicated.score.mesostructure.B.oscLayers).map((layer) => layer.clipId).sort(),
    ["b-listsequencer-1", "b-listsequencer-2"]);
  assert.notEqual(duplicated.score.mesostructure.B.oscLayers["listsequencer-1"].clipId,
    duplicated.score.mesostructure.A.oscLayers["listsequencer-1"].clipId);
  assert.deepEqual(duplicated.copies.map((copy) => copy.clip.params), [snapshot.params, snapshot.params]);
  assert.equal(duplicated.score.structureRevision, 2);

  const beforeRejectedDuplicate = context.store.getScore();
  const duplicateRejected = await request(context, "POST", "/osc/block-state/duplicate", {
    targets: [firstTarget.id, secondTarget.id],
    sourceBlockId: "A",
    destinationBlockId: "B",
    expectedStructureRevision: beforeRejectedDuplicate.structureRevision
  });
  assert.equal(duplicateRejected.status, 409);
  assert.deepEqual(context.store.getScore(), beforeRejectedDuplicate);

  const duplicateReplaced = await requestJson(context, "POST", "/osc/block-state/duplicate", {
    targets: [firstTarget.id, secondTarget.id],
    sourceBlockId: "A",
    destinationBlockId: "B",
    expectedStructureRevision: beforeRejectedDuplicate.structureRevision,
    replace: true
  });
  assert.equal(duplicateReplaced.copiedCount, 2);
  assert.equal(duplicateReplaced.score.structureRevision, 3);

  const beforeReplace = context.store.getScore();
  const replaced = await requestJson(context, "PUT", "/osc/block-state", {
    targets: [firstTarget.id, secondTarget.id],
    blockId: "A",
    expectedStructureRevision: beforeReplace.structureRevision,
    snapshot: { ...snapshot, params: { ...snapshot.params, GateTime: 0.8 } }
  });
  assert.equal(replaced.score.structureRevision, 4);
  assert.deepEqual(replaced.writes.map((write) => write.clip.params.GateTime), [0.8, 0.8]);
  assert.deepEqual(replaced.writes.map((write) => write.replaced), [true, true]);
});

test("Block State upsert leaves compatible unresolved roles untouched for Admin resolution", async () => {
  const context = createRouteContext({
    runtime: {
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [captureControlTarget()]; }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/list-existing", {
    app: "listsequencer",
    deviceId: "heron",
    oscTargetId: "heron:listsequencer:offline"
  });
  const before = context.store.getScore();
  const rejected = await request(context, "PUT", "/osc/block-state", {
    targets: ["heron:listsequencer:main"],
    blockId: "A",
    expectedStructureRevision: before.structureRevision,
    snapshot: { schemaVersion: 1, app: "listsequencer", params: { Clock: 0 }, inputPorts: { Steps: [] } }
  });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body, /require assignment in Admin/);
  assert.deepEqual(context.store.getScore(), before);
});

test("automatic OSC onboarding endpoint obeys configured stable role templates", async () => {
  const config = mergeConfig(defaultConfig, { osc: { onboarding: { automatic: { enabled: true, roles: [
    { roleId: "list-auto", label: "List Auto", app: "listsequencer", deviceId: "heron" }
  ] } } } });
  const context = createRouteContext({
    config,
    runtime: {
      oscSender: async () => {},
      oscCaptureDelay: async () => {},
      oscCaptureFetch: async (url) => {
        if (url.endsWith("/params")) return jsonFetchResponse(clockParamsBody("On", { GateTime: 0.5 }));
        if (url.endsWith("/StepsAck")) return jsonFetchResponse({ VALUE: [1, 1, 0, 0] });
        return jsonFetchResponse({}, 404);
      },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() { return [captureControlTarget()]; }
      }
    }
  });

  const result = await requestJson(context, "POST", "/osc/onboard/automatic", {});
  assert.equal(result.enabled, true);
  assert.equal(result.onboarded[0].roleId, "list-auto");
  assert.equal(result.onboarded[0].clipId, "a-list-auto");
  assert.equal(context.store.getScore().mesostructure.A.oscLayers["list-auto"].clipId, "a-list-auto");
});

test("hardware registration triggers enabled automatic OSC onboarding", async () => {
  const config = mergeConfig(defaultConfig, { osc: { onboarding: { automatic: { enabled: true, roles: [
    { roleId: "analog-auto", label: "Analog Auto", app: "analogsequencer", deviceId: "heron" }
  ] } } } });
  const context = createRouteContext({
    config,
    runtime: {
      peerRegistry: createPeerRegistry(config),
      oscCaptureFetch: async () => jsonFetchResponse(clockParamsBody("Off", { Glide: 12 }, 4))
    }
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    advertisedName: "Heron",
    targets: [],
    oscTargets: [{
      id: "analog-main",
      label: "Analog Sequencer",
      host: "heron.local",
      port: 1234,
      baseAddress: "/rnbo/inst/4",
      app: "analogsequencer",
      parameters: [
        { name: "Clock", address: "/rnbo/inst/4/params/Clock/Clock", type: "s", values: ["Off", "On"] },
        { name: "Glide", address: "/rnbo/inst/4/params/Glide" }
      ]
    }]
  });

  assert.equal(registered.automaticOscOnboarding.enabled, true);
  assert.equal(registered.automaticOscOnboarding.onboarded[0].roleId, "analog-auto");
  assert.equal(context.store.getScore().oscClips["a-analog-auto"].params.Glide, 12);
});

test("block OSC recall route dry-runs and dispatches ordered semantic writes with bounded status", async () => {
  const sends = [];
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => { sends.push({ targetId: write.targetId, address: write.address, args: write.args }); },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return [{
            id: "rnbo-inst-42:listsequencer",
            localId: "rnbo-inst-42:listsequencer",
            label: "List Sequencer 42",
            host: "192.168.68.101",
            port: 1234,
            baseAddress: "/rnbo/inst/42",
            app: "listsequencer",
            instance: "main",
            hardwareUnitId: "heron",
            deviceId: "heron",
            available: true,
            parameters: [
              { name: "Clock", address: "/rnbo/inst/42/params/Clock/Clock" },
              { name: "GateTime", address: "/rnbo/inst/42/params/GateTime" }
            ],
            inputPorts: [
              { name: "Steps", address: "/rnbo/inst/42/messages/in/Steps" },
              { name: "rtz", address: "/rnbo/inst/42/messages/in/rtz" }
            ]
          }];
        }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/list-a", {
    app: "listsequencer",
    deviceId: "heron",
    oscTargetId: "heron:listsequencer:main"
  });
  await requestJson(context, "PUT", "/osc/assignments/plate-offline", {
    app: "plate",
    deviceId: "raven",
    oscTargetId: "raven:plate:main"
  });
  await createOscClipLayer(context, "F", "list-a", "list-opening", {
    app: "listsequencer",
    params: { Clock: 0, GateTime: 0.45, FutureMode: 1 },
    inputPorts: { Steps: [1, 0, 1, 0], rtz: [1] }
  });
  await createOscClipLayer(context, "F", "plate-offline", "plate-offline-state", {
    app: "plate",
    params: { Decay: 0.5 },
    inputPorts: {}
  });
  const versionBeforeRecall = context.store.getScore().version;

  const dryRun = await requestJson(context, "POST", "/mesostructure/F/osc-layers/recall", {
    roles: ["list-a"],
    dryRun: true
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plannedWriteCount, 3);
  assert.equal(dryRun.attemptedWriteCount, 0);
  assert.deepEqual(dryRun.roles[0].writes.map((write) => write.name), ["GateTime", "Steps", "Clock"]);
  assert.deepEqual(dryRun.roles[0].missingControls, [{ kind: "param", name: "FutureMode", reason: "missing-live-control" }]);
  assert.deepEqual(dryRun.roles[0].excludedControls, [{ kind: "inputPort", name: "rtz", reason: "momentary-control" }]);
  assert.deepEqual(sends, []);

  const recalled = await requestJson(context, "POST", "/mesostructure/F/osc-layers/recall", {});
  assert.equal(recalled.ok, true);
  assert.equal(recalled.attemptedWriteCount, 3);
  assert.equal(recalled.skippedRoleCount, 1);
  assert.equal(recalled.roles.find((role) => role.roleId === "plate-offline").skippedReason, "offline");
  assert.deepEqual(sends.map((write) => write.address), [
    "/rnbo/inst/42/params/GateTime",
    "/rnbo/inst/42/messages/in/Steps",
    "/rnbo/inst/42/params/Clock/Clock"
  ]);
  assert.equal(context.store.getScore().version, versionBeforeRecall);

  const blockStatus = await requestJson(context, "GET", "/mesostructure/F/osc-layers/recall");
  assert.equal(blockStatus.last.id, recalled.id);
  assert.equal(blockStatus.history.length, 2);
  const globalStatus = await requestJson(context, "GET", "/osc/recalls");
  assert.equal(globalStatus.last.id, recalled.id);
  assert.equal(globalStatus.historyLimit, 20);
});

test("block OSC recall validates role filters and unknown blocks", async () => {
  const context = createRouteContext();
  const invalidRoles = await request(context, "POST", "/mesostructure/A/osc-layers/recall", { roles: "all", dryRun: true });
  assert.equal(invalidRoles.status, 400);
  assert.match(invalidRoles.body, /roles must be an array/);

  const missingBlock = await request(context, "POST", "/mesostructure/missing/osc-layers/recall", { dryRun: true });
  assert.equal(missingBlock.status, 400);
  assert.match(missingBlock.body, /unknown mesostructural block 'missing'/);
});

test("active block route changes automatically recall snapshots once and expose playback diagnostics", async () => {
  const sends = [];
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => { sends.push(write); },
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return [{
            id: "rnbo-inst-42:listsequencer",
            localId: "rnbo-inst-42:listsequencer",
            label: "List Sequencer 42",
            host: "192.168.68.101",
            port: 1234,
            baseAddress: "/rnbo/inst/42",
            app: "listsequencer",
            instance: "main",
            hardwareUnitId: "heron",
            deviceId: "heron",
            available: true,
            parameters: [
              { name: "GateTime", address: "/rnbo/inst/42/params/GateTime" },
              { name: "Clock", address: "/rnbo/inst/42/params/Clock/Clock" }
            ],
            inputPorts: [{ name: "Steps", address: "/rnbo/inst/42/messages/in/Steps" }]
          }];
        }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/list-a", {
    app: "listsequencer",
    deviceId: "heron",
    oscTargetId: "heron:listsequencer:main"
  });
  await createOscClipLayer(context, "B", "list-a", "list-b-state", {
    app: "listsequencer",
    params: { GateTime: 0.25, Clock: 1 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  });
  const automatic = createOscSnapshotAutoRecall(context.store, {
    recall: ({ blockId }) => recallOscSnapshotsForBlock(context.store, context.config, context.runtime, blockId)
  });
  context.runtime.oscSnapshotAutoRecall = automatic;

  await requestJson(context, "POST", "/structure/playhead", { activeBlockId: "B", macroIndex: 1 });
  await automatic.flush();
  assert.deepEqual(sends.map((write) => write.address), [
    "/rnbo/inst/42/params/GateTime",
    "/rnbo/inst/42/messages/in/Steps",
    "/rnbo/inst/42/params/Clock/Clock"
  ]);

  await requestJson(context, "POST", "/structure/playhead", { activeBlockId: "B", macroIndex: 1 });
  await automatic.flush();
  assert.equal(sends.length, 3);

  const playback = await requestJson(context, "GET", "/macrostructure/playback");
  assert.equal(playback.oscSnapshotRecall.pending, false);
  assert.equal(playback.oscSnapshotRecall.last.blockId, "B");
  assert.equal(playback.oscSnapshotRecall.last.attemptedWriteCount, 3);
  automatic.close();
});

test("automatic OSC recall can use cached targets without refreshing discovery on the block boundary", async () => {
  const sends = [];
  const target = {
    id: "rnbo-inst-42:analogsequencer",
    localId: "rnbo-inst-42:analogsequencer",
    label: "Analog Sequencer 42",
    host: "127.0.0.1",
    port: 1234,
    baseAddress: "/rnbo/inst/42",
    app: "analogsequencer",
    instance: "main",
    hardwareUnitId: "wren",
    deviceId: "wren",
    available: true,
    parameters: [{ name: "Clock", address: "/rnbo/inst/42/params/Clock/Clock" }],
    inputPorts: [{ name: "rtz", address: "/rnbo/inst/42/messages/in/rtz" }]
  };
  const context = createRouteContext({
    runtime: {
      oscSender: async (write) => { sends.push(write); },
      sessionRuntimeCache: { rnboTargets: [], oscTargets: [target] },
      manualOscQueryDevices: {
        async rnboTargets() { throw new Error("discovery should not run"); },
        async rnboDevices() { throw new Error("discovery should not run"); },
        async oscTargets() { throw new Error("discovery should not run"); }
      }
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/analog-a", {
    app: "analogsequencer",
    deviceId: "wren",
    oscTargetId: "rnbo-inst-42:analogsequencer"
  });
  await createOscClipLayer(context, "B", "analog-a", "analog-b-state", {
    app: "analogsequencer",
    params: { Clock: 1 },
    inputPorts: {},
    recall: { rtzBeforePlay: true }
  });

  const result = await recallOscSnapshotsForBlock(context.store, context.config, context.runtime, "B", {
    preferCachedTargets: true
  });
  await distributeTtidForBlock(context.store.getScore(), context.config, context.runtime, "B", {
    preferCachedTargets: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sends.map((write) => write.address), [
    "/rnbo/inst/42/messages/in/rtz",
    "/rnbo/inst/42/params/Clock/Clock"
  ]);
});

test("structure playhead routes select, advance, and reset active blocks", async () => {
  const context = createRouteContext();

  const selected = await requestJson(context, "POST", "/structure/playhead", {
    activeBlockId: "C"
  });
  assert.equal(selected.structureState.activeBlockId, "C");
  assert.equal(selected.structureState.macroIndex, 2);

  const playhead = await requestJson(context, "GET", "/structure/playhead");
  assert.deepEqual(playhead, selected.structureState);

  const advanced = await requestJson(context, "POST", "/macrostructure/advance", {
    expectedVersion: selected.version
  });
  assert.equal(advanced.structureState.activeBlockId, "D");
  assert.equal(advanced.structureState.macroIndex, 3);

  const reset = await requestJson(context, "POST", "/macrostructure/reset", {
    expectedVersion: advanced.version
  });
  assert.deepEqual(reset.structureState, { activeBlockId: "A", macroIndex: 0 });

  await requestJson(context, "POST", "/macrostructure", { blocks: ["F", "B", "A"] });
  const resetToFirstBlock = await requestJson(context, "POST", "/macrostructure/reset", {});
  assert.deepEqual(resetToFirstBlock.structureState, { activeBlockId: "F", macroIndex: 0 });

  const rejected = await request(context, "POST", "/structure/playhead", {
    activeBlockId: "missing"
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /unknown mesostructural block 'missing'/);
});

test("running Cue Section queues a coordinated transition without moving the playhead", async () => {
  const cues = [];
  const context = createRouteContext({
    runtime: {
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: "jack",
          activeBlockId: "A",
          macroIndex: 0,
          witness: { source: "jack", usable: true, fresh: true }
        }),
        cue(request) {
          cues.push(request);
          return {
            ...this.snapshot(),
            cue: {
              blockId: request.blockId,
              macroIndex: request.macroIndex,
              boundary: "end-of-section",
              state: "preparing"
            }
          };
        }
      }
    }
  });

  const result = await requestJson(context, "POST", "/structure/playhead", { activeBlockId: "C" });

  assert.equal(result.structureState.activeBlockId, "A");
  assert.equal(result.cue.blockId, "C");
  assert.equal(result.cue.state, "preparing");
  assert.deepEqual(cues, [{ blockId: "C", macroIndex: 2, source: "cue-section" }]);
});

test("held Cue Section activates required note clients before committing the playhead", async () => {
  const sequence = [];
  let context;
  context = createRouteContext({
    runtime: {
      performanceTransport: { playersPlaying: false, arrangementRequestedMode: "hold" },
      rnboAdapter: {
        enabled: true,
        async applyBlockUpdate(blockId, options) {
          sequence.push(`apply:${blockId}:${options.activationMode}`);
          assert.equal(context.store.getScore().structureState.activeBlockId, "A");
          assert.equal(options.reusePrepared, true);
          return { state: "active", blockId };
        }
      }
    }
  });

  const result = await requestJson(context, "POST", "/structure/playhead", { activeBlockId: "C" });

  sequence.push(`commit:${context.store.getScore().structureState.activeBlockId}`);
  assert.deepEqual(sequence, ["apply:C:now", "commit:C"]);
  assert.equal(result.cue.state, "active");
  assert.equal(result.cue.boundary, "now");
});

test("macro playback routes expose, start, and stop the chain runner", async () => {
  let running = false;
  let startOptions = null;
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      },
      macroPlayback: {
        snapshot: () => ({
          running,
          activeBlockId: "A",
          macroIndex: 0,
          nextAdvanceAt: running ? 1000 : null,
          currentBlockDurationMs: running ? 16000 : 0
        }),
        start: (options) => {
          startOptions = options;
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  const initial = await requestJson(context, "GET", "/macrostructure/playback");
  assert.equal(initial.running, false);

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "jack" });
  assert.equal(started.ok, true);
  assert.equal(started.playback.running, true);
  assert.equal(started.playback.currentBlockDurationMs, 16000);
  assert.equal(startOptions.mode, "jack");
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.deepEqual(started.clockWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      targetId: "source-client",
      value: "On"
    }
  ]);
  assert.deepEqual(started.phaseWrites, []);

  const stopped = await requestJson(context, "POST", "/macrostructure/playback/stop", {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.playback.running, false);
  assert.deepEqual(writes.at(-1), {
    host: "192.168.68.96",
    port: 9000,
    path: "/rnbo/inst/2/params/Clock/Clock",
    value: "Off"
  });
  assert.deepEqual(stopped.clockWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      targetId: "source-client",
      value: "Off"
    }
  ]);
});

test("transport facade play and stop wrap macro playback with aggregate status", async () => {
  const writes = [];
  let running = false;
  let startOptions = null;
  const jackCalls = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      },
      jackController: {
        async start() {
          jackCalls.push(["start"]);
          return { ok: true, action: "start" };
        },
        async stop() {
          jackCalls.push(["stop"]);
          return { ok: true, action: "stop" };
        },
        async tempo(bpm) {
          jackCalls.push(["tempo", bpm]);
          return { ok: true, action: "tempo", bpm };
        }
      },
      macroPlayback: {
        snapshot: () => ({
          running,
          mode: startOptions?.mode ?? "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          beatIntoBlock: running ? 0 : null,
          witness: {
            source: startOptions?.mode === "jack" ? "jack" : "timer",
            usable: true,
            fresh: true
          }
        }),
        start: (options) => {
          startOptions = options;
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "source-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  const started = await requestJson(context, "POST", "/transport/play", { mode: "timer" });
  assert.equal(started.ok, true);
  assert.equal(started.action, "play");
  assert.deepEqual(started.jackStart, { ok: true, action: "start" });
  assert.deepEqual(started.jackTempo, { ok: true, action: "tempo", bpm: 120 });
  assert.equal(started.transport.playing, true);
  assert.equal(started.transport.activeBlockId, "A");
  assert.equal(started.transport.sync.label, "Timer");
  assert.deepEqual(started.transport.clients, { assigned: 1, online: 1, ready: true });
  assert.equal(startOptions.sourceClientId, "transport");
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/ClockInterval",
      value: 30
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "Off"
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.equal(started.clockWrites.length, 1);
  assert.equal(started.phaseClockStopWrites.length, 1);
  assert.equal(started.phaseWrites.length, 1);

  const stopped = await requestJson(context, "POST", "/transport/stop", {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.action, "stop");
  assert.deepEqual(stopped.jackStop, { ok: true, action: "stop" });
  assert.equal(stopped.transport.playing, false);
  assert.equal(stopped.clockWrites.length, 1);
  assert.deepEqual(writes.at(-1), {
    host: "192.168.68.96",
    port: 9000,
    path: "/rnbo/inst/2/params/Clock/Clock",
    value: "Off"
  });
  assert.deepEqual(jackCalls, [["tempo", 120], ["start"], ["stop"]]);
});

test("player and arrangement controls remain distinct and idempotent", async () => {
  const writes = [];
  const oscWrites = [];
  const jackCalls = [];
  let running = false;
  let mode = "stopped";
  let startCount = 0;
  let stopCount = 0;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "source-client",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      jackController: {
        async tempo(bpm) {
          jackCalls.push(["tempo", bpm]);
          return { ok: true, bpm };
        },
        async start() {
          jackCalls.push(["start"]);
          return { ok: true };
        },
        async stop() {
          jackCalls.push(["stop"]);
          return { ok: true };
        }
      },
      rnboParamWriter: async (write) => writes.push(write),
      oscSender: async (write) => oscWrites.push(write),
      manualOscQueryDevices: {
        async rnboTargets() { return []; },
        async rnboDevices() { return []; },
        async oscTargets() {
          return ["analogsequencer", "listvelsequencer", "listsequencer", "triggerseq", "plate"].map((app, index) => ({
            id: `rnbo-inst-${index + 10}:${app}`,
            localId: `rnbo-inst-${index + 10}:${app}`,
            host: "192.168.68.101",
            port: 1234,
            baseAddress: `/rnbo/inst/${index + 10}`,
            app,
            instance: "main",
            hardwareUnitId: "rack",
            deviceId: "rack",
            available: true,
            parameters: [{
              name: "Clock",
              address: `/rnbo/inst/${index + 10}/params/Clock/Clock`,
              type: "s",
              values: ["Off", "On"]
            }]
          }));
        }
      },
      macroPlayback: {
        snapshot: () => ({
          running,
          mode,
          activeBlockId: "A",
          macroIndex: 0,
          witness: { source: mode, usable: running }
        }),
        start: (options) => {
          startCount += 1;
          running = true;
          mode = options.mode;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          stopCount += 1;
          running = false;
          mode = "stopped";
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });
  for (const app of ["analogsequencer", "listvelsequencer", "listsequencer", "triggerseq", "plate"]) {
    context.store.replaceOscAssignment(`role-${app}`, {
      app,
      deviceId: "rack",
      oscTargetId: `rack:${app}:main`
    });
  }

  const blocked = await request(context, "POST", "/transport/arrangement/run", {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body, /Players are stopped/);

  const played = await requestJson(context, "POST", "/transport/players/play", { mode: "timer" });
  assert.equal(played.transport.players.playing, true);
  assert.equal(played.transport.arrangement.running, true);
  assert.equal(played.transport.stateText, "Players playing · Arrangement running");
  assert.equal(played.oscClockWrites.length, 4);
  assert.deepEqual(oscWrites.map(({ targetId, args }) => [targetId, args]), [
    ["rack:analogsequencer:main", ["On"]],
    ["rack:listvelsequencer:main", ["On"]],
    ["rack:listsequencer:main", ["On"]],
    ["rack:triggerseq:main", ["On"]]
  ]);

  const writesAfterPlay = writes.length;
  const jackAfterPlay = jackCalls.length;
  const held = await requestJson(context, "POST", "/transport/arrangement/hold", {});
  assert.equal(held.transport.players.playing, true);
  assert.equal(held.transport.arrangement.running, false);
  assert.equal(held.transport.stateText, "Players playing · Arrangement held on A");
  assert.equal(writes.length, writesAfterPlay);
  assert.equal(jackCalls.length, jackAfterPlay);

  const repeatedPlay = await requestJson(context, "POST", "/transport/players/play", {});
  assert.equal(repeatedPlay.idempotent, true);
  assert.equal(repeatedPlay.transport.arrangement.running, false);
  assert.equal(writes.length, writesAfterPlay);

  const resumed = await requestJson(context, "POST", "/transport/arrangement/run", { mode: "timer" });
  assert.equal(resumed.transport.arrangement.running, true);
  assert.equal(writes.length, writesAfterPlay);

  const stopped = await requestJson(context, "POST", "/transport/players/stop", {});
  assert.equal(stopped.transport.players.playing, false);
  assert.equal(stopped.transport.arrangement.running, false);
  assert.equal(stopped.oscClockWrites.length, 4);
  assert.deepEqual(oscWrites.slice(-4).map(({ targetId, args }) => [targetId, args]), [
    ["rack:analogsequencer:main", ["Off"]],
    ["rack:listvelsequencer:main", ["Off"]],
    ["rack:listsequencer:main", ["Off"]],
    ["rack:triggerseq:main", ["Off"]]
  ]);
  const writesAfterStop = writes.length;
  const jackAfterStop = jackCalls.length;

  const repeatedStop = await requestJson(context, "POST", "/transport/players/stop", {});
  assert.equal(repeatedStop.idempotent, true);
  assert.equal(writes.length, writesAfterStop);
  assert.equal(jackCalls.length, jackAfterStop);
  assert.equal(startCount, 2);
  assert.ok(stopCount >= 2);
});

test("Players Play respects a held arrangement mode", async () => {
  let running = false;
  const context = createRouteContext({
    runtime: {
      macroPlayback: {
        snapshot: () => ({
          running,
          mode: running ? "timer" : "stopped",
          activeBlockId: "A",
          macroIndex: 0
        }),
        start: () => {
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  await requestJson(context, "POST", "/transport/arrangement/hold", {});
  const played = await requestJson(context, "POST", "/transport/players/play", { mode: "timer" });

  assert.equal(played.transport.players.playing, true);
  assert.equal(played.transport.arrangement.running, false);
  assert.equal(played.transport.arrangement.requestedMode, "hold");
});

test("Players Play ignores stale readiness failures for deleted playback targets", async () => {
  let running = false;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "current-client",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/23/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      rnboAdapter: {
        enabled: true,
        async prepareBlock() {},
        async waitForIdle() {},
        sendStatus() {
          return [
            { targetId: "deleted-client", ack: { ok: false, status: "unreachable" } },
            { targetId: "current-client", ack: { ok: true, status: "prepared" } }
          ];
        },
        sendQueueStatus() {
          return { inProgress: false, queued: false };
        }
      },
      rnboParamWriter: async () => {},
      macroPlayback: {
        snapshot: () => ({
          running,
          mode: running ? "timer" : "stopped",
          activeBlockId: "A",
          macroIndex: 0
        }),
        start: () => {
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "current-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/23/messages/in/shadowscore"
  });

  const played = await requestJson(context, "POST", "/transport/players/play", { mode: "timer" });

  assert.equal(played.transport.players.playing, true);
  assert.equal(played.transport.arrangement.running, true);
});

test("Players Play ignores a failed redundant prepare when the desired payload is already active", async () => {
  let prepareCount = 0;
  let applyCount = 0;
  let running = false;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: { targets: [{ id: "finch", host: "finch.local", port: 1234, address: "/rnbo/inst/2/messages/in/shadowscore" }] }
    }),
    runtime: {
      rnboAdapter: {
        enabled: true,
        async waitForIdle() {},
        async prepareBlock() { prepareCount += 1; },
        async applyBlockUpdate() { applyCount += 1; },
        async playbackUpdates() {
          return { targets: { finch: { targetId: "finch", state: "active", activeTransaction: 1005 } } };
        },
        sendStatus: () => [{ targetId: "finch", ack: { ok: false, status: "rejected", transactionId: 1010 } }],
        sendQueueStatus: () => ({ inProgress: false, queued: false })
      },
      rnboParamWriter: async () => {},
      macroPlayback: {
        snapshot: () => ({ running, mode: running ? "timer" : "stopped", activeBlockId: "A", macroIndex: 0 }),
        start: () => { running = true; return context.runtime.macroPlayback.snapshot(); },
        stop: () => { running = false; return context.runtime.macroPlayback.snapshot(); }
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "finch",
    rnboHost: "finch.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });

  const played = await requestJson(context, "POST", "/transport/players/play", { mode: "timer" });
  assert.equal(played.transport.players.playing, true);
  assert.equal(prepareCount, 0);
  assert.equal(applyCount, 0);
  assert.equal(played.rnboReadiness.source, "playback-updates");
  assert.equal(played.rnboReadiness.allActive, true);
});

test("Transport Play adopts externally moving active players without reset or payload writes", async () => {
  let startOptions;
  let prepareCount = 0;
  let applyCount = 0;
  let jackStartCount = 0;
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "finch",
          host: "finch.local",
          port: 1234,
          address: "/rnbo/inst/2/messages/in/shadowscore",
          currentStage: 40,
          stageMovement: "moving"
        }]
      }
    }),
    runtime: {
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: 40,
          stageMovement: "moving",
          stageReadbackStatus: "fresh"
        }))
      },
      rnboAdapter: {
        enabled: true,
        async waitForIdle() {},
        async prepareBlock() { prepareCount += 1; },
        async applyBlockUpdate() { applyCount += 1; },
        async playbackUpdates() {
          return { targets: { finch: { targetId: "finch", state: "saved-not-active", activeTransaction: null } } };
        },
        sendStatus: () => [],
        sendQueueStatus: () => ({ inProgress: false, queued: false })
      },
      rnboParamWriter: async (write) => { writes.push(write); },
      jackController: { async start() { jackStartCount += 1; return { ok: true }; } },
      macroPlayback: {
        snapshot: () => ({
          running: Boolean(startOptions),
          mode: startOptions?.mode ?? "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: startOptions ? { source: "rnbo-client", usable: true, fresh: true } : { source: "none", usable: false }
        }),
        start: (options) => { startOptions = options; return context.runtime.macroPlayback.snapshot(); },
        stop: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "finch",
    rnboHost: "finch.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });

  const played = await requestJson(context, "POST", "/transport/play", {});
  assert.equal(played.adopted, true);
  assert.equal(played.payloadVerified, false);
  assert.equal(startOptions.mode, "jack");
  assert.equal(startOptions.anchorOffsetBeats, 2.5);
  assert.equal(startOptions.reset, false);
  assert.equal(prepareCount, 0);
  assert.equal(applyCount, 0);
  assert.equal(writes.length, 0);
  assert.equal(jackStartCount, 1);
  assert.equal(played.clockWrites.length, 0);
  assert.equal(played.phaseWrites.length, 0);
  assert.equal(played.transport.players.controlOrigin, "adopted");
  assert.equal(played.transport.players.payloadVerified, false);
  assert.match(played.transport.warnings.join(" "), /preserved without server-side hash verification/);
});

test("Shadowbox transport intent starts and stops arrangement ownership without payload or clock writes", async () => {
  let startOptions = null;
  let running = false;
  let prepareCount = 0;
  let applyCount = 0;
  const writes = [];
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async prepareBlock() { prepareCount += 1; },
        async applyBlockUpdate() { applyCount += 1; },
        sendStatus: () => [],
        sendQueueStatus: () => ({ inProgress: false, queued: false })
      },
      rnboParamWriter: async (write) => { writes.push(write); },
      macroPlayback: {
        snapshot: () => ({
          running,
          mode: running ? "jack" : "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: running
            ? { source: "jack", usable: true, fresh: true }
            : { source: "none", usable: false, reason: "macro playback stopped" }
        }),
        start: (options) => {
          startOptions = options;
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  const started = await requestJson(context, "POST", "/transport/external", {
    source: "shadowbox",
    unitId: "wren",
    rolling: true
  });
  assert.equal(started.adopted, true);
  assert.equal(startOptions, null);
  assert.equal(started.arrangementHeld, true);
  assert.equal(started.arrangementSynchronized, false);
  assert.equal(started.phaseAlignment.reason, "source-stage-unavailable");
  assert.equal(prepareCount, 0);
  assert.equal(applyCount, 0);
  assert.equal(writes.length, 0);
  assert.equal(started.transport.players.playing, true);
  assert.equal(started.transport.players.controlOrigin, "shadowbox");
  assert.deepEqual(
    started.transport.players.lastExternalIntent,
    { source: "shadowbox", unitId: "wren", rolling: true, receivedAt: started.transport.players.lastExternalIntent.receivedAt }
  );

  const stopped = await requestJson(context, "POST", "/transport/external", {
    source: "shadowbox",
    unitId: "wren",
    rolling: false
  });
  assert.equal(stopped.released, true);
  assert.equal(stopped.transport.players.playing, false);
  assert.equal(stopped.transport.arrangement.running, false);
  assert.equal(writes.length, 0);
});

test("Shadowbox transport intent anchors arrangement to the initiating unit's RNBO stage", async () => {
  let startOptions = null;
  const config = mergeConfig(defaultConfig, {
    server: { hostIdentity: "wren", advertisedName: "wren" },
    rnbo: {
      enabled: true,
      phaseAlignment: { verifyTimeoutMs: 0 },
      oscQuery: { enabled: false },
      targets: [{
        id: "wren-client",
        host: "127.0.0.1",
        port: 1234,
        address: "/rnbo/inst/2/messages/in/shadowscore",
        currentStagePath: "/rnbo/inst/2/messages/out/current_stage"
      }]
    }
  });
  const currentStages = new Map([
    ["wren-client", 40],
    ["heron-client", 80]
  ]);
  const context = createRouteContext({
    config,
    runtime: {
      rnboParamWriter: async () => {},
      peerRegistry: {
        snapshot: () => [{ id: "heron", advertisedName: "heron", status: "online" }],
        targets: () => [{
          id: "heron-client",
          host: "heron.local",
          port: 1234,
          address: "/rnbo/inst/7/messages/in/shadowscore",
          currentStagePath: "/rnbo/inst/7/messages/out/current_stage",
          hardwareUnitId: "heron",
          hardwareUnitName: "heron",
          available: true
        }],
        oscTargets: () => [],
        rnboDevices: () => []
      },
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: currentStages.get(target.id),
          stageMovement: "moving",
          stageReadbackStatus: "fresh"
        }))
      },
      macroPlayback: {
        snapshot: () => ({
          running: Boolean(startOptions),
          mode: startOptions ? "jack" : "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: startOptions ? { source: "jack", usable: true, fresh: true } : { source: "none", usable: false }
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "wren-client",
    rnboHost: "127.0.0.1",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "heron-client",
    rnboHost: "heron.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/7/messages/in/shadowscore"
  });

  const started = await requestJson(context, "POST", "/transport/external", {
    source: "shadowbox",
    unitId: "wren",
    rolling: true
  });

  assert.equal(startOptions.anchorOffsetBeats, 2.5);
  assert.equal(startOptions.witnessContext.rnboTargets.length, 2);
  assert.deepEqual(started.anchor, {
    beatIntoBlock: 2.5,
    source: "rnbo-client",
    unitId: "wren",
    targetId: "wren-client"
  });
  assert.equal(started.phaseAlignment.applied, false);
  assert.equal(started.phaseAlignment.reason, "skew-exceeds-one-beat");
});

test("Shadowbox transport intent restarts assigned peers from the initiating unit's current address", async () => {
  let startOptions = null;
  const writes = [];
  const config = mergeConfig(defaultConfig, {
    server: { hostIdentity: "wren", advertisedName: "wren" },
    rnbo: {
      enabled: true,
      phaseAlignment: { verifyTimeoutMs: 0, clockOffSettleMs: 0, setStageSettleMs: 0 },
      oscQuery: { enabled: false },
      targets: [{
        id: "wren-client",
        host: "127.0.0.1",
        port: 1234,
        address: "/rnbo/inst/2/messages/in/shadowscore",
        currentStagePath: "/rnbo/inst/2/messages/out/current_stage",
        clockPath: "/rnbo/inst/2/params/Clock",
        clockStartAckPath: "/rnbo/inst/2/messages/out/clock_start_ack"
      }]
    }
  });
  const currentStages = new Map([
    ["wren-client", 40],
    ["heron-client", 40]
  ]);
  const clockStartCounters = new Map([
    ["wren-client", 4],
    ["heron-client", 8]
  ]);
  const context = createRouteContext({
    config,
    runtime: {
      peerRegistry: {
        snapshot: () => [{ id: "heron", advertisedName: "heron", status: "online" }],
        targets: () => [{
          id: "heron-client",
          host: "heron.local",
          port: 1234,
          address: "/rnbo/inst/7/messages/in/shadowscore",
          currentStagePath: "/rnbo/inst/7/messages/out/current_stage",
          clockPath: "/rnbo/inst/7/params/Clock",
          clockStartAckPath: "/rnbo/inst/7/messages/out/clock_start_ack",
          hardwareUnitId: "heron",
          hardwareUnitName: "heron",
          available: true
        }],
        oscTargets: () => [],
        rnboDevices: () => []
      },
      rnboParamWriter: async (write) => {
        writes.push(write);
        if (write.path.endsWith("/SetStage")) {
          const targetId = write.host === "127.0.0.1" ? "wren-client" : "heron-client";
          currentStages.set(targetId, Number(write.value));
        }
        if (write.path.endsWith("/Clock") && write.value === "On") {
          const targetId = write.host === "127.0.0.1" ? "wren-client" : "heron-client";
          clockStartCounters.set(targetId, clockStartCounters.get(targetId) + 1);
        }
      },
      rnboStageFetch: async (url) => ({
        ok: true,
        async json() {
          const targetId = url.includes("/inst/2/") ? "wren-client" : "heron-client";
          return url.endsWith("/clock_start_ack")
            ? { VALUE: [clockStartCounters.get(targetId), currentStages.get(targetId)] }
            : { VALUE: [currentStages.get(targetId)] };
        }
      }),
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: currentStages.get(target.id),
          stateAgeMs: 0,
          stageMovement: "moving",
          stageReadbackStatus: "fresh"
        }))
      },
      macroPlayback: {
        snapshot: () => ({
          running: Boolean(startOptions),
          mode: startOptions ? "jack" : "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: startOptions ? { source: "jack", usable: true, fresh: true } : { source: "none", usable: false }
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "wren-client",
    rnboHost: "127.0.0.1",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "heron-client",
    rnboHost: "heron.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/7/messages/in/shadowscore"
  });

  const started = await requestJson(context, "POST", "/transport/external", {
    source: "shadowbox",
    unitId: "wren",
    rolling: true
  });

  assert.equal(started.phaseAlignment.applied, true);
  assert.equal(started.phaseAlignment.verified, true);
  assert.equal(started.phaseAlignment.reason, "coordinated-clock-restart");
  assert.equal(started.phaseAlignment.value, 40);
  assert.equal(startOptions.anchorOffsetBeats, 2.5);
  assert.equal(started.anchor.phaseAligned, true);
  assert.equal(started.arrangementSynchronized, true);
  assert.equal(started.phaseAlignment.clockStartAcknowledgement.verified, true);
  assert.deepEqual(
    started.phaseAlignment.clockStartAcknowledgement.acknowledgements.map(({ targetId, baselineCounter, counter, stage }) =>
      ({ targetId, baselineCounter, counter, stage })),
    [
      { targetId: "wren-client", baselineCounter: 4, counter: 5, stage: 40 },
      { targetId: "heron-client", baselineCounter: 8, counter: 9, stage: 40 }
    ]
  );
  assert.deepEqual(started.phaseAlignment.offsets, [
    { targetId: "wren-client", stage: 40, offsetStages: 0 },
    { targetId: "heron-client", stage: 40, offsetStages: 0 }
  ]);
  assert.deepEqual(writes.map((write) => [write.path, write.value]), [
    ["/rnbo/inst/2/params/Clock", "Off"],
    ["/rnbo/inst/7/params/Clock", "Off"],
    ["/rnbo/inst/2/messages/in/SetStage", 40],
    ["/rnbo/inst/7/messages/in/SetStage", 40],
    ["/rnbo/inst/2/params/Clock", "On"],
    ["/rnbo/inst/7/params/Clock", "On"]
  ]);
  assert.deepEqual(started.phaseAlignment.writes.map((write) => write.phase), [
    "clock-off", "clock-off", "set-stage", "set-stage", "clock-on", "clock-on"
  ]);
});

test("Shadowbox transport intent does not phase-write when an assigned peer lacks a fresh stage", async () => {
  let startOptions = null;
  const writes = [];
  const config = mergeConfig(defaultConfig, {
    server: { hostIdentity: "wren", advertisedName: "wren" },
    rnbo: {
      enabled: true,
      phaseAlignment: { verifyTimeoutMs: 0 },
      oscQuery: { enabled: false },
      targets: [{
        id: "wren-client",
        host: "127.0.0.1",
        port: 1234,
        address: "/rnbo/inst/2/messages/in/shadowscore"
      }]
    }
  });
  const context = createRouteContext({
    config,
    runtime: {
      peerRegistry: {
        snapshot: () => [{ id: "heron", advertisedName: "heron", status: "online" }],
        targets: () => [{
          id: "heron-client",
          host: "heron.local",
          port: 1234,
          address: "/rnbo/inst/7/messages/in/shadowscore",
          hardwareUnitId: "heron",
          hardwareUnitName: "heron",
          available: true
        }],
        oscTargets: () => [],
        rnboDevices: () => []
      },
      rnboParamWriter: async (write) => { writes.push(write); },
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: target.id === "wren-client" ? 40 : null,
          stateAgeMs: target.id === "wren-client" ? 0 : 5000,
          stageMovement: target.id === "wren-client" ? "moving" : "unknown",
          stageReadbackStatus: target.id === "wren-client" ? "fresh" : "stale"
        }))
      },
      macroPlayback: {
        snapshot: () => ({
          running: Boolean(startOptions),
          mode: startOptions ? "jack" : "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: startOptions ? { source: "jack", usable: true, fresh: true } : { source: "none", usable: false }
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "wren-client",
    rnboHost: "127.0.0.1",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "heron-client",
    rnboHost: "heron.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/7/messages/in/shadowscore"
  });

  const started = await requestJson(context, "POST", "/transport/external", {
    source: "shadowbox",
    unitId: "wren",
    rolling: true
  });

  assert.equal(started.phaseAlignment.applied, false);
  assert.equal(started.phaseAlignment.reason, "incomplete-comparable-targets");
  assert.deepEqual(started.phaseAlignment.unavailableTargetIds, ["heron-client"]);
  assert.equal(started.arrangementSynchronized, false);
  assert.equal(startOptions.anchorOffsetBeats, 2.5);
  assert.equal(writes.length, 0);
});

test("external transport intent rejects an ambiguous rolling value", async () => {
  const context = createRouteContext();
  const response = await request(context, "POST", "/transport/external", {
    source: "shadowbox",
    rolling: "true"
  });
  assert.equal(response.status, 400);
  assert.match(response.body, /rolling must be a boolean/);
});

test("playback snapshot reports externally running RNBO players before adoption", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: { targets: [{ id: "finch", host: "finch.local", port: 1234, address: "/rnbo/inst/2/messages/in/shadowscore" }] }
    }),
    runtime: {
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: 48,
          stageMovement: "moving",
          stageReadbackStatus: "fresh"
        }))
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "finch",
    rnboHost: "finch.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  context.runtime.macroPlayback = createMacroPlayback(context.store, context.config);

  const snapshot = await requestJson(context, "GET", "/playback/snapshot");
  assert.equal(snapshot.playback.running, false);
  assert.equal(snapshot.playback.witness.source, "none");
  assert.equal(snapshot.playback.externalPlayback.running, true);
  assert.equal(snapshot.playback.externalPlayback.witness.source, "rnbo-client");
  assert.equal(snapshot.controls.players.playing, false);
  assert.equal(snapshot.controls.players.externallyPlaying, true);
  context.runtime.macroPlayback.close();
});

test("transport auto mode selects JACK after the controller starts rolling", async () => {
  let now = 1000;
  let startOptions = null;
  const jackTransport = createJackTransportState(defaultConfig, { now: () => now });
  const context = createRouteContext({
    runtime: {
      jackTransport,
      jackController: {
        async tempo(bpm) {
          return { ok: true, action: "tempo", bpm };
        },
        async start() {
          jackTransport.update(jackSnapshot({ absoluteBeat: 16, state: "rolling" }));
          now = 1010;
          return { ok: true, action: "start" };
        }
      },
      macroPlayback: {
        snapshot: () => ({
          running: Boolean(startOptions),
          mode: startOptions?.mode ?? "stopped",
          activeBlockId: "A",
          macroIndex: 0,
          witness: { source: startOptions?.mode ?? "none", usable: Boolean(startOptions), fresh: true }
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  const started = await requestJson(context, "POST", "/transport/play", { mode: "auto" });

  assert.equal(started.ok, true);
  assert.equal(started.mode, "jack");
  assert.equal(startOptions.mode, "jack");
});

test("transport play reconciles Finch prepared data after SetStage then Clock", async () => {
  const sequence = [];
  let running = false;
  const activationRequest = {
    targetId: "finch-client",
    transactionId: 1104,
    expectedClientId: 90,
    url: "http://finch.local:5678/rnbo/inst/20/messages/out/shadowscore_ack",
    initialStage: 0
  };
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "finch-client",
          host: "finch.local",
          port: 1234,
          address: "/rnbo/inst/20/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        sequence.push(write.path.endsWith("/SetStage")
          ? "SetStage"
          : write.path.endsWith("/ClockInterval") ? "ClockInterval" : "Clock");
      },
      rnboAdapter: {
        enabled: true,
        async waitForIdle() {},
        sendStatus: () => [{ targetId: "finch-client", ack: { ok: true, status: "prepared" } }],
        sendQueueStatus: () => ({ inProgress: false, queued: false }),
        schedulePreparedActivations(options) {
          sequence.push("activation_scheduled");
          assert.deepEqual(options, { targetId: "", initialStage: 0 });
          return [activationRequest];
        },
        async confirmPreparedActivations(requests, options) {
          sequence.push("activation_completed");
          assert.deepEqual(requests, [activationRequest]);
          assert.equal(options.tempo, 120);
          return [{
            targetId: "finch-client",
            transactionId: 1104,
            acknowledgement: { ok: true, status: "active" }
          }];
        },
        lifecycleEvents: () => []
      },
      macroPlayback: {
        snapshot: () => ({
          running,
          activeBlockId: "A",
          macroIndex: 0,
          witness: { source: "timer", usable: true, fresh: true }
        }),
        start: () => {
          sequence.push("playback_started");
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => {
          running = false;
        }
      }
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "finch-client",
    rnboHost: "finch.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/20/messages/in/shadowscore"
  });
  const started = await requestJson(context, "POST", "/transport/play", { mode: "timer" });

  assert.deepEqual(sequence, [
    "ClockInterval",
    "Clock",
    "SetStage",
    "activation_scheduled",
    "Clock",
    "playback_started",
    "activation_completed"
  ]);
  assert.equal(started.activations[0].acknowledgement.status, "active");
});

test("transport start refreshes the clock ACK cohort after JACK starts", async () => {
  let peerAvailable = false;
  let running = false;
  const clockCounters = new Map([["local", 0], ["peer", 0]]);
  const phaseCounters = new Map([["local", 0], ["peer", 0]]);
  const stages = new Map([["local", -1], ["peer", -1]]);
  const acknowledgedStages = new Map([["local", -1], ["peer", -1]]);
  const peerTarget = {
    id: "peer-client",
    host: "peer.local",
    port: 1234,
    address: "/rnbo/inst/7/messages/in/shadowscore",
    currentStagePath: "/rnbo/inst/7/messages/out/current_stage",
    clockPath: "/rnbo/inst/7/params/Clock",
    clockStartAckPath: "/rnbo/inst/7/messages/out/clock_start_ack",
    clockPhaseResetPath: "/rnbo/inst/7/messages/in/clock_phase_reset",
    clockPhaseAckPath: "/rnbo/inst/7/messages/out/clock_phase_ack",
    available: true
  };
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        phaseAlignment: { startAckTimeoutMs: 0 },
        oscQuery: { enabled: false },
        targets: [{
          id: "local-client",
          host: "127.0.0.1",
          port: 1234,
          address: "/rnbo/inst/2/messages/in/shadowscore",
          currentStagePath: "/rnbo/inst/2/messages/out/current_stage",
          clockPath: "/rnbo/inst/2/params/Clock",
          clockStartAckPath: "/rnbo/inst/2/messages/out/clock_start_ack",
          clockPhaseResetPath: "/rnbo/inst/2/messages/in/clock_phase_reset",
          clockPhaseAckPath: "/rnbo/inst/2/messages/out/clock_phase_ack"
        }]
      }
    }),
    runtime: {
      peerRegistry: {
        snapshot: () => [],
        targets: () => peerAvailable ? [peerTarget] : [],
        oscTargets: () => [],
        rnboDevices: () => []
      },
      jackController: {
        async start() {
          peerAvailable = true;
          return { ok: true, action: "start" };
        }
      },
      rnboParamWriter: async (write) => {
        const key = write.host === "127.0.0.1" ? "local" : "peer";
        if (write.path.endsWith("/SetStage")) {
          stages.set(key, Number(write.value));
          acknowledgedStages.set(key, Number(write.value));
        }
        if (write.path.endsWith("/Clock") && write.value === "On") {
          clockCounters.set(key, clockCounters.get(key) + 1);
          stages.set(key, key === "local" ? 3 : 11);
        }
        if (write.path.endsWith("/clock_phase_reset")) {
          phaseCounters.set(key, phaseCounters.get(key) + 1);
        }
      },
      rnboAckFetch: async (url) => {
        const key = url.includes("/inst/2/") ? "local" : "peer";
        return {
          ok: true,
          async json() {
            return { VALUE: [
              url.endsWith("/clock_phase_ack") ? phaseCounters.get(key) : clockCounters.get(key),
              acknowledgedStages.get(key)
            ] };
          }
        };
      },
      rnboStageFetch: async (url) => {
        const key = url.includes("/inst/2/") ? "local" : "peer";
        return {
          ok: true,
          async json() { return { VALUE: [stages.get(key)] }; }
        };
      },
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage: 0,
          stageMovement: "stopped",
          stageReadbackStatus: "fresh"
        }))
      },
      macroPlayback: {
        snapshot: () => ({ running, activeBlockId: "A", macroIndex: 0 }),
        start: () => {
          running = true;
          return context.runtime.macroPlayback.snapshot();
        },
        stop: () => { running = false; }
      }
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "local-client",
    rnboHost: "127.0.0.1",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "peer-client",
    rnboHost: "peer.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/7/messages/in/shadowscore"
  });

  const started = await requestJson(context, "POST", "/transport/play", {
    mode: "timer",
    forceRestart: true,
    phaseReset: true
  });

  assert.equal(started.clockStartAcknowledgement.verified, true);
  assert.equal(started.clockStartAcknowledgement.targetCount, 2);
  assert.deepEqual(
    started.clockStartAcknowledgement.acknowledgements.map(({ targetId }) => targetId),
    ["local-client", "peer-client"]
  );
  assert.equal(started.clockStartCorrectionWrites.length, 2);
  assert.equal(started.clockPhaseResetWrites.length, 2);
  assert.equal(started.clockPhaseAcknowledgement.verified, true);
  assert.equal(
    started.clockStartPhaseVerification.verified,
    true,
    JSON.stringify(started.clockStartPhaseVerification)
  );
  assert.deepEqual([...stages.values()], [0, 0]);
});

test("continuing arrangements reject per-section ClockInterval changes", () => {
  const score = createInitialScore(defaultConfig);
  score.assignments["player-1"] = {
    ...score.assignments["player-1"],
    rnboTargetId: "client-1",
    rnboHost: "client.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/1/messages/in/shadowscore"
  };
  score.clips["a-player-1"].notes[0].start_time = 0.25;
  score.clips["a-player-1"].notes[0].duration = 0.25;
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "hybrid",
        candidateStagesPerBeat: [1, 2, 4, 8, 16],
        defaultStagesPerBeat: 4,
        quantizationErrorTargetBeats: 0
      }
    }
  });
  const result = continuingClockContractForArrangement(score, config, [{
    id: "client-1",
    host: "client.local",
    port: 1234,
    address: "/rnbo/inst/1/messages/in/shadowscore",
    capabilities: {
      continuingScoreActivation: true,
      maxStages: 4096,
      maxNoteRows: 819
    }
  }]);

  assert.equal(result.applies, true);
  assert.equal(result.stable, false);
  assert.deepEqual([...new Set(result.variants.map(({ ticksPerStage }) => ticksPerStage))], [120, 480]);
});

test("transport play prefers atomic block activation for continuing clients", async () => {
  const sequence = [];
  let running = false;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "finch-client",
          host: "finch.local",
          port: 1234,
          address: "/rnbo/inst/20/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        sequence.push(write.path.endsWith("/SetStage")
          ? "SetStage"
          : write.path.endsWith("/ClockInterval") ? "ClockInterval" : "Clock");
      },
      rnboAdapter: {
        enabled: true,
        async prepareBlock(blockId, reason) {
          sequence.push(`prepare:${blockId}:${reason}`);
        },
        async waitForIdle() {},
        sendStatus: () => [{ targetId: "finch-client", ack: { ok: true, status: "prepared" } }],
        sendQueueStatus: () => ({ inProgress: false, queued: false }),
        async applyBlockUpdate(blockId, options) {
          sequence.push(`apply:${blockId}:${options.activationMode}`);
          assert.equal(typeof options.expectedScoreRevision, "number");
          return {
            blockId,
            action: "active",
            activations: [{
              targetId: "finch-client",
              transactionId: 1105,
              acknowledgement: { ok: true, status: "active" }
            }]
          };
        },
        schedulePreparedActivations() {
          assert.fail("legacy activation scheduling must not run when applyBlockUpdate is available");
        },
        lifecycleEvents: () => []
      },
      macroPlayback: {
        snapshot: () => ({
          running,
          activeBlockId: "A",
          macroIndex: 0,
          witness: { source: "timer", usable: true, fresh: true }
        }),
        start: () => {
          sequence.push("playback_started");
          running = true;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "finch-client",
    rnboHost: "finch.local",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/20/messages/in/shadowscore"
  });
  const started = await requestJson(context, "POST", "/transport/play", { mode: "timer" });

  assert.deepEqual(sequence, [
    "prepare:A:transport-start",
    "apply:A:now",
    "ClockInterval",
    "Clock",
    "SetStage",
    "Clock",
    "playback_started"
  ]);
  assert.equal(started.playbackUpdate.action, "active");
  assert.equal(started.activations[0].acknowledgement.status, "active");
});

test("written block tempo save does not silently change live JACK tempo", async () => {
  const jackCalls = [];
  const context = createRouteContext({
    runtime: {
      jackController: {
        async tempo(bpm) {
          jackCalls.push(["tempo", bpm]);
          return { ok: true, action: "tempo", bpm };
        }
      }
    }
  });

  const current = context.store.getScore();
  const score = await requestJson(context, "POST", "/mesostructure/A", {
    ...current.mesostructure.A,
    tempo: 137.25
  });

  assert.equal(score.mesostructure.A.tempo, 137.25);
  assert.equal(score.macrostructure.tempo, undefined);
  assert.deepEqual(jackCalls, []);
});

test("live tempo routes expose manual, follow-block, and explicit recall policy", async () => {
  const jackCalls = [];
  const context = createRouteContext({
    runtime: {
      jackController: {
        async tempo(bpm) {
          jackCalls.push(bpm);
          return { ok: true, bpm };
        }
      }
    }
  });
  context.store.replaceMesoBlock("B", {
    ...context.store.getScore().mesostructure.B,
    tempo: 96
  });

  const manual = await requestJson(context, "POST", "/transport/tempo", { bpm: 108 });
  assert.equal(manual.transport.tempo.live, 108);
  assert.equal(manual.transport.tempo.source, "manual");

  await requestJson(context, "POST", "/transport/tempo/follow-block", { follow: false });
  context.store.advanceStructurePlayhead();
  assert.equal(context.runtime.tempoPolicy.snapshot().live, 108);
  assert.equal(context.runtime.tempoPolicy.snapshot().written, 96);

  const enabled = await requestJson(context, "POST", "/transport/tempo/follow-block", { follow: true });
  assert.equal(enabled.tempo.live, 108);
  const recalled = await requestJson(context, "POST", "/transport/tempo/use-block", {});
  assert.equal(recalled.tempo.live, 96);
  assert.equal(recalled.tempo.source, "block");

  await requestJson(context, "POST", "/transport/tempo", { bpm: 104 });
  context.store.resetStructurePlayhead();
  await context.runtime.tempoPolicy.flush();
  assert.equal(context.runtime.tempoPolicy.snapshot().live, 120);
  assert.deepEqual(jackCalls, [108, 96, 104, 120]);

  const snapshot = await requestJson(context, "GET", "/playback/snapshot");
  assert.equal(snapshot.tempo.live, 120);
  assert.equal(snapshot.transport.tempo, 120);
});

test("live tempo routes reject invalid tempo policy requests", async () => {
  const context = createRouteContext();

  const tempo = await request(context, "POST", "/transport/tempo", { bpm: 0 });
  const follow = await request(context, "POST", "/transport/tempo/follow-block", { follow: "yes" });

  assert.equal(tempo.status, 400);
  assert.match(tempo.body, /bpm must be a positive number/);
  assert.equal(follow.status, 400);
  assert.match(follow.body, /follow must be boolean/);
});

test("server tempo authority sends live tempo to RNBO message inports", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      transport: { tempoAuthority: "server" },
      rnbo: {
        targets: [{
          id: "source-client",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore"
        }]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => writes.push(write)
    }
  });

  await requestJson(context, "POST", "/transport/tempo", { bpm: 111 });

  assert.equal(context.config.rnbo.transport.Tempo, 111);
  assert.deepEqual(writes, [{
    host: "192.168.68.96",
    port: 9000,
    path: "/rnbo/inst/2/messages/in/Tempo",
    value: 111
  }]);
});

test("transport return-to-start resets the macro playhead and phase", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      },
      macroPlayback: {
        snapshot: () => ({
          running: false,
          mode: "stopped",
          activeBlockId: context.store.getScore().structureState.activeBlockId,
          macroIndex: context.store.getScore().structureState.macroIndex
        })
      }
    }
  });

  await requestJson(context, "POST", "/macrostructure/advance", {});
  assert.equal(context.store.getScore().structureState.activeBlockId, "B");

  const returned = await requestJson(context, "POST", "/transport/return-to-start", {});
  assert.equal(returned.ok, true);
  assert.equal(returned.action, "return-to-start");
  assert.equal(returned.transport.activeBlockId, "A");
  assert.equal(returned.transport.macroIndex, 0);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    }
  ]);
});

test("macro playback start auto mode uses internal clock without a beat witness", async () => {
  let startOptions = null;
  const context = createRouteContext({
    runtime: {
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: startOptions?.mode ?? "stopped",
          activeBlockId: "A",
          macroIndex: 0
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", {});

  assert.equal(started.ok, true);
  assert.equal(startOptions.mode, "timer");
  assert.equal(started.playback.mode, "timer");
});

test("macro playback start auto mode uses beat-derived playback with a fresh JACK witness", async () => {
  let now = 1000;
  let startOptions = null;
  const jackTransport = createJackTransportState(defaultConfig, { now: () => now });
  const context = createRouteContext({
    runtime: {
      jackTransport,
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: startOptions?.mode ?? "stopped",
          activeBlockId: "A",
          macroIndex: 0
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  jackTransport.update(jackSnapshot({ absoluteBeat: 8 }));
  now = 1050;
  const started = await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "auto" });

  assert.equal(started.ok, true);
  assert.equal(startOptions.mode, "jack");
  assert.equal(started.playback.mode, "jack");
});

test("macro playback route reports RNBO client readback as beat witness", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore",
            currentStage: 40
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });
  context.runtime.macroPlayback = createMacroPlayback(context.store, context.config);

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "jack" });

  assert.equal(started.playback.running, true);
  assert.deepEqual(started.playback.witness, {
    source: "rnbo-client",
    usable: true,
    absoluteBeat: 2.5,
    tempo: null,
    fresh: true,
    targetId: "source-client",
    currentStage: 40,
    stagesPerBeat: 16,
    cycleBeats: 16,
    skewBeats: 0,
    targetCount: 1,
    reason: "RNBO current_stage readback"
  });
});

test("playback snapshot is versioned and reports authoritative and execution positions atomically", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "finch",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore",
          voiceId: "player-1",
          currentStage: 60
        }]
      }
    }),
    runtime: {
      rnboAdapter: {
        sendStatus: () => [{
          targetId: "finch",
          transactionId: 1103,
          scoreRevision: 4,
          payloadRevision: "4:A",
          payloadHash: "payload-hash",
          blockId: "A",
          noteCount: 392,
          transmittedRowCount: 392,
          preparationDurationMs: 2800,
          ack: { ok: true, transactionId: 1103 }
        }],
        sendQueueStatus: () => ({ inProgress: false, queued: false, active: null, queuedRequest: null }),
        lifecycleEvents: () => [{ type: "prepare_completed", targetId: "finch" }]
      },
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: "jack",
          activeBlockId: "A",
          macroIndex: 0,
          beatIntoBlock: 4,
          compositionBeat: 4,
          witness: { source: "jack", usable: true, fresh: true }
        })
      },
      jackTransport: {
        snapshot: () => ({
          source: "jack",
          status: "fresh",
          fresh: true,
          ageMs: 10,
          latest: { beatsPerMinute: 100, absoluteBeat: 4 }
        })
      }
    }
  });

  const first = await requestJson(context, "GET", "/playback/snapshot");
  const second = await requestJson(context, "GET", "/playback/snapshot");

  assert.equal(second.generation, first.generation + 1);
  assert.equal(first.transport.authority, "jack");
  assert.equal(first.transport.beatIntoBlock, 4);
  assert.equal(first.targets.finch.currentStage, 60);
  assert.equal(first.targets.finch.beatIntoBlock, 3.75);
  assert.equal(first.targets.finch.phaseErrorBeats, -0.25);
  assert.equal(first.targets.finch.activeTransaction, 1103);
  assert.equal(first.targets.finch.noteCount, 392);
  assert.equal(first.lifecycleEvents[0].type, "prepare_completed");
});

test("transport object path resolves to one revisioned musician-facing authority", async () => {
  const context = createRouteContext({
    runtime: {
      performanceTransport: {
        playersPlaying: true,
        playerControlOrigin: "shadowscore",
        adoptionPayloadVerified: null,
        arrangementRequestedMode: "run",
        lastExternalIntent: null,
        lastExternalPhaseAlignment: null
      },
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: "jack",
          activeBlockId: "A",
          macroIndex: 0,
          beatIntoBlock: 2,
          compositionBeat: 2,
          witness: { source: "jack", usable: true, fresh: true }
        })
      },
      jackTransport: {
        snapshot: () => ({
          source: "jack",
          status: "fresh",
          fresh: true,
          ageMs: 10,
          latest: { state: "rolling", beatsPerMinute: 120, absoluteBeat: 2 }
        })
      }
    }
  });

  const resolved = await requestJson(context, "GET", "/api/v1/objects/resolve?path=shadow_score%20transport");
  assert.equal(resolved.object.id, "transport");
  assert.ok(resolved.object.methods.includes("re_sync"));

  const first = await requestJson(context, "GET", "/api/v1/objects/transport");
  const second = await requestJson(context, "GET", "/api/v1/objects/transport");
  assert.equal(first.object.authority, "server");
  assert.equal(first.object.clock_source, "jack");
  assert.equal(first.object.position_beats, 2);
  assert.equal(second.object.revision, first.object.revision + 1);
  assert.equal(first.object.capabilities.can_locate, false);
});

test("transport object rejects unknown operations and advertises deferred continuous locate", async () => {
  const context = createRouteContext();
  const unknown = await request(context, "POST", "/api/v1/objects/transport", { operation: "launch_confetti" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body, /unknown transport operation/);

  const locate = await request(context, "POST", "/api/v1/objects/transport", {
    operation: "locate_fraction",
    args: { fraction: 0.5 }
  });
  assert.equal(locate.status, 501);
  assert.match(locate.body, /continuous arrangement locate is not yet available/);
});

test("playback snapshot timestamps its boundary after peer stage collection", async () => {
  let stateObservedAt = null;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [{
          id: "finch",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore",
          voiceId: "player-1"
        }]
      }
    }),
    runtime: {
      rnboStageCollector: {
        async refresh() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          stateObservedAt = Date.now() - 5;
        },
        targets(targets) {
          return targets.map((target) => ({
            ...target,
            currentStage: 64,
            stateObservedAt
          }));
        }
      }
    }
  });

  const snapshot = await requestJson(context, "GET", "/playback/snapshot");

  assert.ok(snapshot.targets.finch.stateAgeMs >= 5);
});

test("playback snapshots consume server-owned stage observations without forcing refresh", async () => {
  let ensureCalls = 0;
  let updateTargets;
  const timingContractReferences = [];
  const cachedTarget = {
    id: "cached-player",
    voiceId: "player-1",
    available: true,
    currentStage: 8,
    currentStagePath: "/rnbo/inst/1/messages/out/current_stage"
  };
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        async playbackUpdates(blockId, options) {
          updateTargets = options.targets;
          return { blockId, targets: {} };
        }
      },
      macroPlayback: {
        snapshot(context) {
          timingContractReferences.push(context.timingContracts);
          return {
            running: false,
            mode: "stopped",
            activeBlockId: "A",
            macroIndex: 0,
            witness: { source: "none", usable: false, fresh: false }
          };
        }
      },
      rnboStageCollector: {
        currentTargets() {
          return [cachedTarget];
        },
        async ensureObservations() {
          ensureCalls += 1;
        },
        async refresh() {
          throw new Error("snapshot request forced a peer refresh");
        },
        targets(targets) {
          return targets;
        }
      }
    }
  });

  await requestJson(context, "GET", "/playback/snapshot");
  await requestJson(context, "GET", "/playback/snapshot");
  assert.equal(ensureCalls, 2);
  assert.deepEqual(updateTargets, [cachedTarget]);
  assert.equal(timingContractReferences[0], timingContractReferences[1]);
});

test("playback updates route exposes the adapter's shared live-edit state", async () => {
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async playbackUpdates(blockId) {
          return {
            blockId,
            scoreRevision: 12,
            state: "saved-not-active",
            affectedTargetCount: 1,
            targets: { finch: { state: "saved-not-active" } }
          };
        }
      }
    }
  });

  const updates = await requestJson(context, "GET", "/playback/updates?blockId=A");
  assert.equal(updates.blockId, "A");
  assert.equal(updates.state, "saved-not-active");
  assert.equal(updates.targets.finch.state, "saved-not-active");
});

test("playback update actions choose continue while running and now while stopped", async () => {
  const calls = [];
  const adapter = {
    enabled: true,
    async playbackUpdates() { return {}; },
    async applyBlockUpdate(blockId, options) {
      calls.push({ blockId, options });
      return { blockId, action: "active", activationMode: options.activationMode };
    }
  };
  const running = createRouteContext({
    runtime: { rnboAdapter: adapter, macroPlayback: { snapshot: () => ({ running: true, activeBlockId: "A" }) } }
  });
  const applied = await requestJson(running, "POST", "/playback/updates/apply-next-beat", {
    blockId: "A",
    expectedScoreRevision: 0
  });
  assert.equal(applied.activationMode, "continue");

  const stopped = createRouteContext({
    runtime: { rnboAdapter: adapter, macroPlayback: { snapshot: () => ({ running: false, activeBlockId: "A" }) } }
  });
  const updated = await requestJson(stopped, "POST", "/playback/updates/update-now", {
    blockId: "A",
    expectedScoreRevision: 0
  });
  assert.equal(updated.activationMode, "now");
  assert.deepEqual(calls.map((call) => call.options.activationMode), ["continue", "now"]);
});

test("Apply next beat refuses to overwrite an imminent macro transition", async () => {
  let applyCount = 0;
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async playbackUpdates() { return {}; },
        async applyBlockUpdate() { applyCount += 1; }
      },
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: "jack",
          activeBlockId: "A",
          activeBlockEndBeat: 104,
          beatsRemaining: 0.5,
          activationArm: { pending: true, last: null }
        })
      }
    }
  });

  const response = await request(context, "POST", "/playback/updates/apply-next-beat", {
    blockId: "A",
    expectedScoreRevision: 0
  });

  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.body).code, "BLOCK_TRANSITION_RESERVED");
  assert.equal(applyCount, 0);
});

test("macro playback route derives macro index from updated JACK witness beat", async () => {
  let now = 1000;
  const jackTransport = createJackTransportState(defaultConfig, { now: () => now });
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore",
            currentStage: 0
          }
        ]
      }
    }),
    runtime: {
      jackTransport,
      rnboParamWriter: async () => {}
    }
  });
  context.store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  context.store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  context.store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  context.runtime.macroPlayback = createMacroPlayback(context.store, context.config, { jackTransport });

  jackTransport.update(jackSnapshot({ absoluteBeat: 100 }));
  await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "jack" });
  now = 1100;
  jackTransport.update(jackSnapshot({ absoluteBeat: 104 }));
  const playback = await requestJson(context, "GET", "/macrostructure/playback");

  assert.equal(playback.macroIndex, 1);
  assert.equal(playback.activeBlockId, "B");
  assert.equal(playback.macroStartBeat, 100);
  assert.equal(playback.macroStartIndex, 0);
  assert.equal(playback.macroStartOffsetBeats, 0);
  assert.equal(playback.compositionBeat, 4);
  assert.equal(playback.beatIntoBlock, 0);
});

test("RNBO current_stage witness treats stage 63 as just before a 64-stage boundary", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore",
            currentStage: 0
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async () => {}
    }
  });
  context.store.replaceMesoBlock("A", { duration: { beats: 4 }, players: {} });
  context.store.replaceMesoBlock("B", { duration: { beats: 4 }, players: {} });
  context.store.updateMacrostructure({ tempo: 120, blocks: ["A", "B"] });
  context.runtime.macroPlayback = createMacroPlayback(context.store, context.config);

  await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "jack" });
  context.config.rnbo.targets[0].currentStage = 63;
  const playback = await requestJson(context, "GET", "/macrostructure/playback");

  assert.equal(playback.macroIndex, 0);
  assert.equal(playback.activeBlockId, "A");
  assert.equal(playback.witness.absoluteBeat, 63 / 16);
  assert.equal(playback.compositionBeat, 63 / 16);
  assert.equal(playback.beatIntoBlock, 63 / 16);
});

test("macro playback route rejects skewed RNBO client readback witness", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "left-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore",
            voiceId: "player-1",
            currentStage: 32
          },
          {
            id: "right-client",
            host: "192.168.68.97",
            port: 9000,
            address: "/rnbo/inst/3/messages/in/shadowscore",
            voiceId: "player-2",
            currentStage: 40
          }
        ]
      },
      transport: {
        rnboClient: {
          maxSkewBeats: 0.25
        }
      }
    }),
    runtime: {
      rnboParamWriter: async () => {}
    }
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "left-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "right-client",
    rnboHost: "192.168.68.97",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/3/messages/in/shadowscore"
  });
  context.runtime.macroPlayback = createMacroPlayback(context.store, context.config);

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", { mode: "jack" });

  assert.equal(started.playback.running, true);
  assert.equal(started.playback.macroIndex, 0);
  assert.equal(started.playback.witness.source, "rnbo-client");
  assert.equal(started.playback.witness.usable, false);
  assert.equal(started.playback.witness.reason, "RNBO current_stage skew 0.5 beats exceeds 0.25");
  assert.equal(started.playback.witness.skewBeats, 0.5);
});

test("macro phase reset writes SetStage to available RNBO targets", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          },
          {
            id: "other-client",
            host: "192.168.68.97",
            port: 9001,
            address: "/rnbo/inst/3/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });

  const result = await requestJson(context, "POST", "/macrostructure/phase-reset", {});

  assert.equal(result.ok, true);
  assert.equal(result.action, "SetStage");
  assert.equal(result.value, 0);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    },
    {
      host: "192.168.68.97",
      port: 9001,
      path: "/rnbo/inst/3/messages/in/SetStage",
      value: 0
    }
  ]);
  assert.deepEqual(result.phaseWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      targetId: "source-client",
      value: 0
    },
    {
      host: "192.168.68.97",
      port: 9001,
      path: "/rnbo/inst/3/messages/in/SetStage",
      targetId: "other-client",
      value: 0
    }
  ]);
});

test("macro playback start can include an immediate phase reset", async () => {
  const writes = [];
  let currentStage = 0;
  let startOptions = null;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      performanceTransport: { playersPlaying: true, arrangementRequestedMode: "run" },
      rnboParamWriter: async (write) => {
        writes.push(write);
        if (write.path.endsWith("/SetStage")) currentStage = Number(write.value);
        if (write.path.endsWith("/Clock/Clock") && write.value === "On") currentStage = 12;
      },
      rnboStageCollector: {
        async ensureObservations() {},
        targets: (targets) => targets.map((target) => ({
          ...target,
          currentStage,
          fresh: true,
          stateAgeMs: 0,
          stageMovement: "moving",
          stageReadbackStatus: "fresh"
        }))
      },
      macroPlayback: {
        snapshot: () => ({
          running: true,
          activeBlockId: "A",
          macroIndex: 0,
          nextAdvanceAt: 1000,
          currentBlockDurationMs: 16000
        }),
        start: (options) => {
          startOptions = options;
          return context.runtime.macroPlayback.snapshot();
        }
      }
    }
  });

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", {
    mode: "jack",
    phaseReset: true,
    forceRestart: true
  });

  assert.equal(started.ok, true);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "Off"
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.deepEqual(started.phaseClockStopWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      targetId: "source-client",
      value: "Off"
    }
  ]);
  assert.deepEqual(started.phaseWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      targetId: "source-client",
      value: 0
    }
  ]);
  assert.equal(started.idempotent, undefined);
  assert.equal(started.phaseAnchor.usable, true);
  assert.equal(started.phaseAnchor.currentStage, 12);
  assert.equal(started.phaseAnchor.absoluteBeat, 12 / started.phaseAnchor.stagesPerBeat);
  assert.equal(startOptions.anchorOffsetBeats, started.phaseAnchor.absoluteBeat);
});

test("forced Re-sync waits for delayed remote clock-off before resetting any stage", async () => {
  const clocksOff = new Set();
  const resetBarrierSizes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "wren-client",
            host: "127.0.0.1",
            port: 1234,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          },
          {
            id: "raven-client",
            host: "raven.local",
            port: 1234,
            address: "/rnbo/inst/9/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      performanceTransport: { playersPlaying: true, arrangementRequestedMode: "run" },
      rnboParamWriter: async (write) => {
        if (write.path.endsWith("/Clock/Clock") && write.value === "Off") {
          if (write.host === "raven.local") await new Promise((resolve) => setTimeout(resolve, 15));
          clocksOff.add(write.host);
        }
        if (write.path.endsWith("/SetStage")) resetBarrierSizes.push(clocksOff.size);
      },
      macroPlayback: {
        snapshot: () => ({ running: true, activeBlockId: "A", macroIndex: 0 }),
        start: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", {
    mode: "timer",
    phaseReset: true,
    forceRestart: true
  });

  assert.equal(started.ok, true);
  assert.equal(started.phaseClockStopWrites.length, 2);
  assert.equal(started.phaseWrites.length, 2);
  assert.deepEqual(resetBarrierSizes, [2, 2]);
});

test("transport object Re-sync preserves the current block stage", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      performanceTransport: { playersPlaying: true, arrangementRequestedMode: "run" },
      rnboParamWriter: async (write) => writes.push(write),
      macroPlayback: {
        snapshot: () => ({
          running: true,
          mode: "jack",
          activeBlockId: "A",
          macroIndex: 0,
          beatIntoBlock: 5.25,
          compositionBeat: 5.25,
          witness: { source: "jack", usable: true, fresh: true }
        }),
        start: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });

  const response = await requestJson(context, "POST", "/api/v1/objects/transport", {
    operation: "re_sync"
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.rnboReadiness.phaseOnly, true);
  assert.equal(response.result.phaseStage, 84);
  assert.deepEqual(
    writes.filter((write) => write.path.endsWith("/SetStage")).map((write) => write.value),
    [84]
  );
});

test("macro playback start can scope clock writes to a selected RNBO target", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          },
          {
            id: "other-client",
            host: "192.168.68.97",
            port: 9001,
            address: "/rnbo/inst/3/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      },
      macroPlayback: {
        snapshot: () => ({
          running: true,
          activeBlockId: "A",
          macroIndex: 0,
          nextAdvanceAt: 1000,
          currentBlockDurationMs: 16000
        }),
        start: () => context.runtime.macroPlayback.snapshot()
      }
    }
  });

  const started = await requestJson(context, "POST", "/macrostructure/playback/start", {
    targetId: "other-client"
  });

  assert.equal(started.ok, true);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.97",
      port: 9001,
      path: "/rnbo/inst/3/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.deepEqual(started.clockWrites, [
    {
      host: "192.168.68.97",
      port: 9001,
      path: "/rnbo/inst/3/params/Clock/Clock",
      targetId: "other-client",
      value: "On"
    }
  ]);
});

test("clip routes expose and mutate reusable clips", async () => {
  const context = createRouteContext();

  const added = await requestJson(context, "POST", "/clips/bass-a", {
    notes: [{ pitch: 48, start_time: 0, duration: 1, velocity: 100 }],
    duration: { bars: 1 }
  });
  assert.equal(added.clips["bass-a"].notes[0].pitch, 48);
  assert.deepEqual(added.clips["bass-a"].duration, { bars: 1 });
  assert.equal(added.clips["bass-a"].playbackType, "looped");

  await requestJson(context, "POST", "/clips/bass-a", {
    notes: [{ pitch: 48, start_time: 0, duration: 1, velocity: 100 }],
    duration: { beats: 2 },
    playbackType: "one-shot"
  });
  const clips = await requestJson(context, "GET", "/clips");
  assert.equal(clips["bass-a"].notes[0].pitch, 48);
  assert.deepEqual(clips["bass-a"].duration, { beats: 2 });
  assert.equal(clips["bass-a"].playbackType, "one-shot");

  const renamed = await requestJson(context, "POST", "/clips/bass-a/rename", {
    clipId: "bass-main"
  });
  assert.equal(renamed.clips["bass-a"], undefined);
  assert.equal(renamed.clips["bass-main"].notes[0].pitch, 48);

  await requestJson(context, "POST", "/mesostructure/A", {
    duration: { bars: 8 },
    players: { "player-1": { clipId: "bass-main" } }
  });
  const rejected = await request(context, "DELETE", "/clips/bass-main");
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /clip 'bass-main' is assigned in A\/player-1/);
});

test("Piano Roll orchestration route moves a note atomically", async () => {
  const context = createRouteContext();
  const result = await requestJson(context, "POST", "/clips/actions/move-note", {
    blockId: "A",
    sourcePlayerId: "player-1",
    sourceClipId: "a-player-1",
    noteIndex: 0,
    noteId: 1,
    destinationPlayerId: "player-2",
    expectedVersion: 0
  });

  assert.equal(result.score.version, 1);
  assert.equal(result.score.clips["a-player-1"].notes.length, 1);
  assert.equal(result.score.clips["a-player-2"].notes.length, 3);
  assert.equal(result.move.destinationPlayerId, "player-2");

  const stale = await request(context, "POST", "/clips/actions/move-note", {
    blockId: "A",
    sourcePlayerId: "player-1",
    sourceClipId: "a-player-1",
    noteIndex: 0,
    noteId: 2,
    destinationPlayerId: "player-3",
    expectedVersion: 0
  });
  assert.equal(stale.status, 400);
  assert.match(stale.body, /stale score version 0; current version is 1/);
});

test("Piano Roll MIDI import route maps normalized lanes to players atomically", async () => {
  const context = createRouteContext();
  const result = await requestJson(context, "POST", "/clips/actions/import-midi-to-players", {
    blockId: "A",
    sourceName: "demo.mid",
    format: 0,
    ppq: 96,
    durationBeats: 4,
    tempo: 120,
    timeSignature: { numerator: 3, denominator: 4 },
    expectedVersion: 0,
    expectedStructureRevision: 0,
    lanes: [{
      playerId: "player-1",
      label: "Demo · ch 1",
      trackIndex: 0,
      trackName: "Demo",
      channel: 1,
      notes: [{ pitch: 60, start_time: 0, duration: 2, velocity: 100 }]
    }]
  });

  assert.equal(result.score.version, 1);
  assert.equal(result.import.noteCount, 1);
  assert.equal(result.score.mesostructure.A.players["player-1"].clipId, "a-player-1-midi");
  assert.deepEqual(result.score.clips["a-player-1-midi"].context.clip.TimeSignature, { numerator: 3, denominator: 4 });
});

test("mesostructure duplicate route copies assigned clips for the new block", async () => {
  const context = createRouteContext();

  const duplicated = await requestJson(context, "POST", "/mesostructure/A/duplicate", {
    blockId: "G"
  });

  assert.equal(duplicated.mesostructure.G.players["player-1"].clipId, "g-player-1");
  assert.deepEqual(duplicated.clips["g-player-1"], duplicated.clips["a-player-1"]);
  assert.equal(duplicated.macrostructure.blocks.includes("G"), false);

  const edited = await requestJson(context, "POST", "/clips/g-player-1", {
    ...duplicated.clips["g-player-1"],
    notes: [{ pitch: 35, start_time: 0, duration: 1, velocity: 100 }]
  });
  assert.equal(edited.clips["g-player-1"].notes[0].pitch, 35);
  assert.notEqual(edited.clips["a-player-1"].notes[0].pitch, 35);
});

test("admin reset route can restore seeded structure", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/mesostructure/G", { duration: { bars: 12 }, players: {} });
  await requestJson(context, "POST", "/macrostructure", { blocks: ["G"] });

  const reset = await requestJson(context, "POST", "/admin/reset", {
    structure: true
  });

  assert.equal(reset.mesostructure.G, undefined);
  assert.deepEqual(Object.keys(reset.mesostructure), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(Object.keys(reset.clips).length, 36);
  assert.deepEqual(reset.mesostructure.A.duration, { bars: 4 });
  assert.equal(reset.mesostructure.A.players["player-1"].clipId, "a-player-1");
  assert.deepEqual(reset.clips["a-player-1"].duration, { bars: 2 });
  assert.ok(reset.clips["a-player-1"].notes.length > 0);
  assert.deepEqual(reset.macrostructure.blocks, ["A", "B", "C", "D", "E", "F"]);
});

test("admin new score route restores configured score defaults", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices", {
    voiceId: "guest",
    assignment: { label: "Guest" }
  });
  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);
  await requestJson(context, "POST", "/mesostructure/G", { duration: { bars: 12 }, players: {} });
  await requestJson(context, "POST", "/macrostructure", { blocks: ["G"] });

  const created = await requestJson(context, "POST", "/admin/scores/new");

  assert.equal(created.voices.guest, undefined);
  assert.deepEqual(created.voices["player-1"].notes, []);
  assert.deepEqual(Object.keys(created.mesostructure), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(Object.keys(created.clips).length, 36);
  assert.equal(created.mesostructure.A.players["player-1"].clipId, "a-player-1");
  assert.deepEqual(created.macrostructure.blocks, ["A", "B", "C", "D", "E", "F"]);
});

test("admin new score route immediately activates the empty replacement on RNBO clients", async () => {
  const calls = [];
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async applyBlockUpdate(blockId, options) {
          calls.push({ blockId, options });
          return { state: "active" };
        }
      }
    }
  });

  const created = await requestJson(context, "POST", "/admin/scores/new");

  assert.equal(created.scoreRevision, 1);
  assert.deepEqual(calls, [{
    blockId: "A",
    options: { activationMode: "now", expectedScoreRevision: 1 }
  }]);
});

test("admin new score route reports a client update failure without hiding the created score", async () => {
  const context = createRouteContext({
    runtime: {
      rnboAdapter: {
        enabled: true,
        async applyBlockUpdate() {
          throw new Error("READY acknowledgement timed out");
        }
      }
    }
  });

  const response = await request(context, "POST", "/admin/scores/new");
  const body = JSON.parse(response.body);

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.match(body.error, /New score was created, but clients could not be updated/);
  assert.equal(body.score.scoreRevision, 1);
  assert.equal(context.store.getScore().scoreRevision, 1);
});

test("admin new score route ignores persisted boot mutations", async () => {
  const defaultScore = createInitialScore(defaultConfig);
  const persistedScore = structuredClone(defaultScore);
  persistedScore.version = 8;
  persistedScore.clips["a-player-2"].notes.push({ pitch: 37, start_time: 1.1875, duration: 0.25, velocity: 100 });
  persistedScore.mesostructure.A.players["player-1"] = { clipId: "a-player-2" };
  persistedScore.structureState = { activeBlockId: "E", macroIndex: 4 };
  const context = createRouteContext({ initialScore: persistedScore, defaultScore });

  const created = await requestJson(context, "POST", "/admin/scores/new");

  assert.equal(created.version, 9);
  assert.deepEqual(created.clips["a-player-2"].notes, defaultScore.clips["a-player-2"].notes);
  assert.equal(created.mesostructure.A.players["player-1"].clipId, "a-player-1");
  assert.deepEqual(created.structureState, { activeBlockId: "A", macroIndex: 0 });
});

test("score initialization previews and atomically creates a device-free score skeleton", async () => {
  const context = createRouteContext();
  const requestDocument = JSON.parse(await fs.readFile(new URL("../config/score-initialization.four-player.json", import.meta.url), "utf8"));
  const before = await requestJson(context, "GET", "/score");

  const preview = await requestJson(context, "POST", "/admin/scores/initialize/preview", requestDocument);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.summary.playerCount, 4);
  assert.equal(preview.summary.blockCount, 6);
  assert.equal(preview.summary.clipCount, 24);
  assert.equal(preview.summary.oscRoleCount, 3);
  assert.equal(preview.summary.emptyOscLayerSlotCount, 18);
  assert.equal(preview.summary.deviceMappingCount, 0);
  assert.deepEqual(preview.summary.macroOrder, ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(await requestJson(context, "GET", "/score"), before);

  const initialized = await requestJson(context, "POST", "/admin/scores/initialize", {
    ...requestDocument,
    expectedVersion: preview.base.version,
    expectedScoreRevision: preview.base.scoreRevision,
    expectedStructureRevision: preview.base.structureRevision
  });
  assert.equal(initialized.dryRun, false);
  assert.deepEqual(Object.keys(initialized.score.voices), ["player-1", "player-2", "player-3", "player-4"]);
  assert.deepEqual(initialized.score.scoreInitialization, { schemaVersion: 1, name: "Four-player six-section loops", exactPlayers: true });
  assert.deepEqual(Object.keys(initialized.score.mesostructure), ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(initialized.score.mesostructure.A.duration, { bars: 1 });
  assert.equal(initialized.score.mesostructure.F.players["player-4"].clipId, "f-player-4");
  assert.equal(initialized.score.clips["f-player-4"].playbackType, "looped");
  assert.equal(initialized.score.oscAssignments["analog-1"].oscTargetId, "");
  assert.deepEqual(initialized.score.mesostructure.A.oscLayers, {});
  assert.deepEqual(initialized.score.oscClips, {});
});

test("score initialization rejects invalid and stale requests without partial mutation", async () => {
  const context = createRouteContext();
  const before = await requestJson(context, "GET", "/score");
  const invalid = await request(context, "POST", "/admin/scores/initialize", {
    players: [{ id: "player-1" }],
    clips: [],
    blocks: [{ id: "A", players: { "player-1": "missing" } }]
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body, /references unknown clip 'missing'/);
  assert.deepEqual(await requestJson(context, "GET", "/score"), before);

  await requestJson(context, "POST", "/context", { seed: 42 });
  const stale = await request(context, "POST", "/admin/scores/initialize", {
    expectedScoreRevision: before.scoreRevision,
    players: [{ id: "player-1" }],
    clips: [],
    blocks: [{ id: "A", players: {} }]
  });
  assert.equal(stale.status, 400);
  assert.match(stale.body, /stale score revision/);
  const after = await requestJson(context, "GET", "/score");
  assert.equal(after.context.seed, 42);
  assert.equal(Object.keys(after.voices).length, Object.keys(before.voices).length);
});

test("admin assignment preset applies friendly shadowbox labels", async () => {
  const context = createRouteContext();

  const score = await requestJson(context, "POST", "/admin/assignment-preset", {
    presetId: "six-player-shadowbox"
  });

  assert.equal(score.assignments["player-1"].label, "Shadowbox A / Source");
  assert.equal(score.assignments["player-6"].deviceId, "shadowbox-f");
});

test("admin backup downloads and restore replaces score snapshot", async () => {
  const context = createRouteContext();
  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);
  await requestJson(context, "PUT", "/osc/assignments/list-a", { app: "listsequencer", deviceId: "finch" });
  await createOscClipLayer(context, "F", "list-a", "list-opening", {
    app: "listsequencer",
    params: { Clock: 1 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  });
  const backup = await request(context, "GET", "/admin/backup");

  assert.equal(backup.status, 200);
  assert.match(backup.headers["Content-Disposition"], /shadowscore-berklee-b51/);
  const snapshot = JSON.parse(backup.body);
  assert.equal(snapshot.oscAssignments["list-a"].deviceId, "finch");
  assert.equal(snapshot.mesostructure.F.oscLayers["list-a"].clipId, "list-opening");
  assert.deepEqual(snapshot.oscClips["list-opening"].inputPorts.Steps, [1, 0, 1, 0]);
  snapshot.voices["player-1"].notes = [{ pitch: 72 }];

  const restored = await requestJson(context, "POST", "/admin/restore", snapshot);
  assert.deepEqual(restored.voices["player-1"].notes, [{ pitch: 72 }]);
  assert.equal(restored.ensembleId, "berklee-b51");
  assert.equal(restored.oscAssignments["list-a"].deviceId, "finch");
  assert.equal(restored.oscClips["list-opening"].params.Clock, 1);
  assert.equal(restored.version > snapshot.version, true);
});

test("admin saved score library saves, loads, lists, and deletes score files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-scores-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      persistence: {
        libraryPath: directory
      }
    })
  });
  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);

  const saved = await requestJson(context, "POST", "/admin/scores", { name: "First Sketch" });
  assert.equal(saved.ok, true);
  assert.equal(saved.score.name, "First Sketch");
  assert.match(saved.score.id, /^first-sketch-/);

  const listed = await requestJson(context, "GET", "/admin/scores");
  assert.equal(listed.scores.length, 1);
  assert.equal(listed.scores[0].name, "First Sketch");

  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 72 }]);
  const loaded = await requestJson(context, "POST", `/admin/scores/${encodeURIComponent(saved.score.id)}/load`);
  assert.deepEqual(loaded.voices["player-1"].notes, [{ pitch: 60 }]);
  assert.equal(loaded.version > listed.scores[0].version, true);

  const deleted = await requestJson(context, "DELETE", `/admin/scores/${encodeURIComponent(saved.score.id)}`);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.scores, []);
});

test("admin import route migrates legacy voice notes into block clips", async () => {
  const context = createRouteContext();
  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60, start_time: 0, duration: 1, velocity: 100 }]);
  await requestJson(context, "POST", "/voices/player-3/notes", [{ pitch: 72, start_time: 4, duration: 1, velocity: 90 }]);

  const imported = await requestJson(context, "POST", "/admin/import-legacy-voice-notes", {
    blockId: "A"
  });

  assert.equal(imported.clips["player-1-main"].notes[0].pitch, 60);
  assert.equal(imported.clips["player-3-main"].notes[0].pitch, 72);
  assert.equal(imported.mesostructure.A.players["player-1"].clipId, "player-1-main");
  assert.equal(imported.mesostructure.A.players["player-3"].clipId, "player-3-main");
  assert.equal(imported.clips["player-2-main"], undefined);
  assert.equal(imported.voices["player-1"].notes[0].pitch, 60);
});

test("hardware registration appears in session and RNBO targets", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "shadowbox-b",
    advertisedName: "Shadowbox B",
    targets: [
      {
        id: "b-source",
        name: "ShadowScoreClient / shadowscore",
        host: "192.168.68.71",
        port: 9000,
        address: "/rnbo/inst/2/messages/in/shadowscore"
      }
    ]
  });
  assert.equal(registered.unit.status, "online");

  const session = await requestJson(context, "GET", "/session");
  const peer = session.hardwareUnits.find((unit) => unit.id === "shadowbox-b");
  assert.equal(peer.advertisedName, "Shadowbox B");
  assert.equal(peer.status, "online");
  assert.equal(session.rnbo.targets.some((target) => target.hardwareUnitId === "shadowbox-b"), true);

  const targets = await requestJson(context, "GET", "/rnbo/targets");
  const target = targets.targets.find((target) => target.id === "shadowbox-b:b-source");
  assert.equal(Boolean(target), true);
  assert.equal(target.capabilities.maxStages, 4096);
  assert.equal(target.capabilities.maxNoteRows, 819);
  assert.equal(target.capabilities.noteDataFloatCount, 16384);
  assert.equal(target.capabilities.stagedScoreActivation, true);
  assert.deepEqual(targets.sendQueue, {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  });
});

test("hardware registration automatically reconciles returning OSC control roles", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });
  await requestJson(context, "PUT", "/osc/assignments/plate-a", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:old"
  });
  await createOscClipLayer(context, "A", "plate-a", "plate-opening", {
    app: "plate",
    params: { Decay: 0.65 },
    inputPorts: {}
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-44:plate",
      label: "Plate 44",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/44",
      app: "plate",
      instance: "main",
      parameters: [{ name: "Decay", address: "/rnbo/inst/44/params/Decay" }]
    }]
  });

  assert.equal(registered.oscAssignmentReconciliation.changed, true);
  assert.equal(registered.oscAssignmentReconciliation.assignments["plate-a"].oscTargetId, "heron:plate:main");
  assert.equal(registered.oscAssignmentReconciliation.score.oscClips["plate-opening"].params.Decay, 0.65);
});

test("RNBO targets route exposes resend queue and per-target commit status", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "127.0.0.1",
            port: 1234,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboAdapter: {
        sendStatus() {
          return [
            {
              targetId: "source-client",
              voiceId: "player-1",
              at: "2026-07-08T20:53:50.401Z",
              noteCount: 4,
              transmittedRowCount: 819,
              ack: {
                ok: true,
                status: "committed",
                transactionId: 1001
              }
            }
          ];
        },
        sendQueueStatus() {
          return {
            inProgress: true,
            queued: true,
            active: {
              scoreVersion: 12,
              scoreRevision: 12,
              structureRevision: 2,
              reasons: ["admin"],
              forceFullClearRows: false,
              startedAt: "2026-07-08T20:53:49.000Z",
              transactionId: 1002
            },
            queuedRequest: {
              scoreVersion: 13,
              scoreRevision: 13,
              structureRevision: 2,
              reasons: ["macro-playback"],
              forceFullClearRows: false
            }
          };
        }
      }
    }
  });

  const targets = await requestJson(context, "GET", "/rnbo/targets");

  assert.equal(targets.sendQueue.inProgress, true);
  assert.equal(targets.sendQueue.queued, true);
  assert.equal(targets.sendQueue.active.transactionId, 1002);
  assert.equal(targets.targets[0].sendStatus.ack.status, "committed");

  const session = await requestJson(context, "GET", "/session");
  assert.equal(session.rnbo.sendQueue.active.transactionId, 1002);
});

test("hardware registration exposes RNBO devices separately from ShadowScore targets", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/hardware/register", {
    id: "wren",
    advertisedName: "wren",
    rnboDevices: [
      {
        id: "runner",
        name: "wren",
        host: "wren.local",
        oscQueryUrl: "http://wren.local:5678",
        graphEditorUrl: "http://wren.local:3000",
        runnerVersion: "1.4.4-9"
      }
    ],
    targets: []
  });

  const devices = await requestJson(context, "GET", "/rnbo/devices");
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].id, "wren:runner");
  assert.equal(devices.devices[0].graphEditorUrl, "http://wren.local:3000");

  const targets = await requestJson(context, "GET", "/rnbo/targets");
  assert.deepEqual(targets.targets, []);

  const session = await requestJson(context, "GET", "/session");
  assert.equal(session.rnbo.devices[0].hardwareUnitId, "wren");
  assert.equal(session.rnbo.targets.length, 0);
});

test("hardware registration reconciles stale assignment endpoints by device identity", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    assignee: "Ari",
    deviceId: "heron",
    clientId: "stable-client",
    label: "Lead",
    color: "#256f86",
    rnboTargetId: "heron:rnbo-inst-9:shadowscore",
    rnboHost: "192.168.68.90",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/9/messages/in/shadowscore"
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    advertisedName: "Heron",
    targets: [
      {
        id: "rnbo-inst-7:shadowscore",
        host: "192.168.68.101",
        port: 1234,
        address: "/rnbo/inst/7/messages/in/shadowscore"
      }
    ]
  });

  const assignment = context.store.getScore().assignments["player-1"];
  assert.equal(registered.assignmentReconciliation.changed, true);
  assert.deepEqual(registered.assignmentReconciliation.reconciled, [
    { voiceId: "player-1", deviceId: "heron", rnboTargetId: "heron:rnbo-inst-7:shadowscore" }
  ]);
  assert.equal(assignment.rnboTargetId, "heron:rnbo-inst-7:shadowscore");
  assert.equal(assignment.rnboHost, "192.168.68.101");
  assert.equal(assignment.rnboPort, 1234);
  assert.equal(assignment.rnboAddress, "/rnbo/inst/7/messages/in/shadowscore");
  assert.equal(assignment.assignee, "Ari");
  assert.equal(assignment.deviceId, "heron");
  assert.equal(assignment.clientId, "stable-client");
  assert.equal(assignment.label, "Lead");
  assert.equal(assignment.color, "#256f86");
  assert.equal(assignment.locked, false);
  assert.equal(assignment.routingStatus, "");
});

test("hardware registration does not reconcile locked or device-less assignments", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    deviceId: "heron",
    locked: true,
    rnboTargetId: "heron:old",
    rnboHost: "192.168.68.90",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/9/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "heron:old-device-less",
    rnboHost: "192.168.68.91",
    rnboPort: 9001,
    rnboAddress: "/rnbo/inst/8/messages/in/shadowscore"
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    targets: [
      {
        id: "rnbo-inst-7:shadowscore",
        host: "192.168.68.101",
        port: 1234,
        address: "/rnbo/inst/7/messages/in/shadowscore"
      }
    ]
  });

  const assignments = context.store.getScore().assignments;
  assert.equal(registered.assignmentReconciliation.changed, false);
  assert.equal(assignments["player-1"].rnboTargetId, "heron:old");
  assert.equal(assignments["player-2"].rnboTargetId, "heron:old-device-less");
});

test("hardware registration marks matching assignments ambiguous when a client advertises multiple ShadowScore targets", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    deviceId: "heron",
    rnboTargetId: "heron:old",
    rnboHost: "192.168.68.90",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/9/messages/in/shadowscore"
  });

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    targets: [
      { id: "a:shadowscore", host: "192.168.68.101", port: 1234, address: "/rnbo/inst/1/messages/in/shadowscore" },
      { id: "b:shadowscore", host: "192.168.68.101", port: 1234, address: "/rnbo/inst/2/messages/in/shadowscore" }
    ]
  });

  const assignment = context.store.getScore().assignments["player-1"];
  assert.equal(registered.assignmentReconciliation.changed, true);
  assert.deepEqual(registered.assignmentReconciliation.ambiguous, [
    { voiceId: "player-1", deviceId: "heron", targetCount: 2 }
  ]);
  assert.equal(assignment.rnboTargetId, "heron:old");
  assert.equal(assignment.routingStatus, "ambiguous");
  assert.match(assignment.routingMessage, /advertised 2 ShadowScore RNBO targets/);
});

test("hardware registration is a no-op when assignment endpoint already matches", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    deviceId: "heron",
    rnboTargetId: "heron:rnbo-inst-7:shadowscore",
    rnboHost: "192.168.68.101",
    rnboPort: 1234,
    rnboAddress: "/rnbo/inst/7/messages/in/shadowscore"
  });
  const beforeVersion = context.store.getScore().version;

  const registered = await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    targets: [
      {
        id: "rnbo-inst-7:shadowscore",
        host: "192.168.68.101",
        port: 1234,
        address: "/rnbo/inst/7/messages/in/shadowscore"
      }
    ]
  });

  assert.equal(registered.assignmentReconciliation.changed, false);
  assert.equal(context.store.getScore().version, beforeVersion);
});

test("assignment reconcile route refreshes stale endpoints from registered hardware", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    deviceId: "heron",
    rnboTargetId: "heron:old",
    rnboHost: "192.168.68.90",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/9/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/hardware/register", {
    id: "heron",
    targets: [
      {
        id: "rnbo-inst-7:shadowscore",
        host: "192.168.68.101",
        port: 1234,
        address: "/rnbo/inst/7/messages/in/shadowscore"
      }
    ]
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    deviceId: "heron",
    rnboTargetId: "heron:old",
    rnboHost: "192.168.68.90",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/9/messages/in/shadowscore"
  });

  const reconciled = await requestJson(context, "POST", "/assignments/reconcile");
  const assignment = reconciled.score.assignments["player-1"];

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.changed, true);
  assert.deepEqual(reconciled.reconciled, [
    { voiceId: "player-1", deviceId: "heron", rnboTargetId: "heron:rnbo-inst-7:shadowscore" }
  ]);
  assert.deepEqual(reconciled.ambiguous, []);
  assert.equal(assignment.rnboTargetId, "heron:rnbo-inst-7:shadowscore");
  assert.equal(assignment.rnboHost, "192.168.68.101");
  assert.equal(assignment.rnboPort, 1234);
  assert.equal(assignment.rnboAddress, "/rnbo/inst/7/messages/in/shadowscore");
});

test("playback timing contract route exposes target-specific compiled contracts", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fit",
        maxStages: 1024,
        candidateStagesPerBeat: [16, 24, 30, 48, 60, 80, 96, 120, 160, 240, 480]
      },
      targets: [
        {
          id: "source-client",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/shadowscore"
        }
      ]
    }
  });
  const context = createRouteContext({ config });

  await requestJson(context, "POST", "/context?replace=1", {
    clip: {
      time_selection_start: 0,
      time_selection_end: 4
    },
    scale: {},
    grid: {},
    seed: 0
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "source-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-1/notes", [
    {
      pitch: 60,
      start_time: 0,
      duration: 0.25,
      velocity: 100
    }
  ]);

  const result = await requestJson(context, "GET", "/playback/timing-contracts");

  assert.equal(result.contracts.length, 1);
  const [contract] = result.contracts;
  assert.equal(contract.targetId, "source-client");
  assert.equal(contract.targetType, "rnbo");
  assert.equal(contract.contractTransport, "rnbo-osc");
  assert.equal(contract.available, true);
  assert.equal(contract.assignedVoiceId, "player-1");
  assert.deepEqual(contract.timing, {
    blockId: "A",
    stagesPerBeat: 240,
    ticksPerStage: 2,
    patternLength: 960,
    maxStages: 1024,
    maxNoteRows: 819,
    resolutionMode: "fit",
    quantizationError: null
  });
  assert.equal(contract.noteCount, 4);
  assert.equal(contract.transmittedRowCount, 4);
  assert.equal(contract.replacementMode, "compact");
  assert.equal(contract.compactScoreReplace, true);
  assert.equal(contract.targetCapabilities.compactScoreReplace, true);
  assert.equal(contract.targetCapabilities.supportsBeginReplaceClear, true);
  assert.equal(contract.targetCapabilities.activeRowCountCommit, true);
  assert.equal(contract.targetCapabilities.stagedScoreActivation, true);
});

test("playback timing contracts honor per-target registered stage capacity", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      resolution: {
        mode: "fit",
        maxStages: 4096,
        candidateStagesPerBeat: [16, 60, 120, 240, 480]
      }
    }
  });
  const context = createRouteContext({
    config,
    runtime: {
      peerRegistry: createPeerRegistry(config)
    }
  });

  await requestJson(context, "POST", "/hardware/register", {
    id: "shadowbox-b",
    advertisedName: "Shadowbox B",
    targets: [
      {
        id: "old-client",
        host: "192.168.68.71",
        port: 9000,
        address: "/rnbo/inst/2/messages/in/shadowscore",
        capabilities: {
          maxStages: 1024,
          maxNoteRows: 256
        }
      },
      {
        id: "expanded-client",
        host: "192.168.68.72",
        port: 9000,
        address: "/rnbo/inst/3/messages/in/shadowscore",
        capabilities: {
          maxStages: 4096,
          maxNoteRows: 819
        }
      }
    ]
  });
  await requestJson(context, "POST", "/context?replace=1", {
    clip: {
      time_selection_start: 0,
      time_selection_end: 16
    },
    scale: {},
    grid: {},
    seed: 0
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "shadowbox-b:old-client",
    rnboHost: "192.168.68.71",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-2/assignment", {
    rnboTargetId: "shadowbox-b:expanded-client",
    rnboHost: "192.168.68.72",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/3/messages/in/shadowscore"
  });

  const result = await requestJson(context, "GET", "/playback/timing-contracts");
  const oldClient = result.contracts.find((contract) => contract.targetId === "shadowbox-b:old-client");
  const expandedClient = result.contracts.find((contract) => contract.targetId === "shadowbox-b:expanded-client");

  assert.equal(oldClient.assignedVoiceId, "player-1");
  assert.equal(oldClient.timing.maxStages, 1024);
  assert.equal(oldClient.timing.maxNoteRows, 256);
  assert.equal(oldClient.timing.stagesPerBeat, 60);
  assert.equal(oldClient.timing.patternLength, 960);
  assert.equal(expandedClient.assignedVoiceId, "player-2");
  assert.equal(expandedClient.timing.maxStages, 4096);
  assert.equal(expandedClient.timing.maxNoteRows, 819);
  assert.equal(expandedClient.timing.stagesPerBeat, 240);
  assert.equal(expandedClient.timing.patternLength, 3840);
});

test("hardware units expire offline without removing voice assignments", async () => {
  let currentTime = 1000;
  const config = mergeConfig(defaultConfig, {
    registration: {
      heartbeatTtlMs: 5000
    }
  });
  const context = createRouteContext({
    config,
    runtime: {
      peerRegistry: createPeerRegistry(config, { now: () => currentTime })
    }
  });

  await requestJson(context, "POST", "/voices/player-1/assignment", {
    assignee: "Ari",
    rnboTargetId: "shadowbox-b:b-source",
    rnboHost: "192.168.68.71",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/hardware/register", {
    id: "shadowbox-b",
    rnboDevices: [{ id: "runner", host: "shadowbox-b.local", graphEditorUrl: "http://shadowbox-b.local:3000" }],
    targets: [{ id: "b-source", host: "192.168.68.71", port: 9000, address: "/rnbo/inst/2/messages/in/shadowscore" }]
  });

  currentTime = 7000;
  const session = await requestJson(context, "GET", "/session");
  const peer = session.hardwareUnits.find((unit) => unit.id === "shadowbox-b");
  const target = session.rnbo.targets.find((entry) => entry.id === "shadowbox-b:b-source");
  const device = session.rnbo.devices.find((entry) => entry.id === "shadowbox-b:runner");

  assert.equal(peer.status, "offline");
  assert.equal(peer.available, false);
  assert.equal(target.available, false);
  assert.equal(device.available, false);
  assert.equal(device.unitStatus, "offline");
  assert.equal(session.assignments["player-1"].rnboTargetId, "shadowbox-b:b-source");

  const devices = await requestJson(context, "GET", "/rnbo/devices");
  assert.equal(devices.devices[0].available, false);
  assert.equal(devices.devices[0].unitStatus, "offline");
});

test("hardware heartbeat refreshes a registered unit", async () => {
  let currentTime = 1000;
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig, { now: () => currentTime })
    }
  });

  await requestJson(context, "POST", "/hardware/register", { id: "shadowbox-b" });
  currentTime = 2000;
  const heartbeat = await requestJson(context, "POST", "/hardware/units/shadowbox-b/heartbeat", {});

  assert.equal(heartbeat.unit.status, "online");
  assert.match(heartbeat.unit.lastSeenAt, /1970-01-01T00:00:02.000Z/);
});

test("hardware session flags numeric RNBO target host mismatches", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/hardware/register", {
    id: "finch",
    advertisedName: "finch",
    targets: [{ id: "rnbo-inst-7:shadowscore", host: "192.168.68.88", port: 1234, address: "/rnbo/inst/7/messages/in/shadowscore" }]
  });

  const session = await requestJson(context, "GET", "/session");
  const unit = session.hardwareUnits.find((entry) => entry.id === "finch");
  const target = session.rnbo.targets.find((entry) => entry.id === "finch:rnbo-inst-7:shadowscore");

  assert.equal(unit.remoteAddress, "192.168.68.92");
  assert.equal(target.host, "192.168.68.88");
  assert.equal(target.transportHost, "192.168.68.92");
  assert.equal(target.diagnostics[0].type, "target-host-mismatch");
  assert.equal(target.diagnostics[0].advertisedHost, "192.168.68.88");
  assert.equal(target.diagnostics[0].observedHost, "192.168.68.92");
  assert.equal(unit.diagnostics[0].targetId, "finch:rnbo-inst-7:shadowscore");
});

test("hardware target repair uses observed peer address for registered RNBO target", async () => {
  const context = createRouteContext({
    runtime: {
      peerRegistry: createPeerRegistry(defaultConfig)
    }
  });

  await requestJson(context, "POST", "/hardware/register", {
    id: "finch",
    advertisedName: "finch",
    targets: [{ id: "rnbo-inst-7:shadowscore", host: "192.168.68.88", port: 1234, address: "/rnbo/inst/7/messages/in/shadowscore" }]
  });
  const repair = await requestJson(context, "POST", "/hardware/units/finch/targets/finch%3Arnbo-inst-7%3Ashadowscore/use-observed-host");
  const session = await requestJson(context, "GET", "/session");
  const target = session.rnbo.targets.find((entry) => entry.id === "finch:rnbo-inst-7:shadowscore");

  assert.equal(repair.unit.targets[0].host, "192.168.68.92");
  assert.equal(repair.unit.targets[0].advertisedHost, "192.168.68.88");
  assert.equal(target.host, "192.168.68.92");
  assert.equal(target.advertisedHost, "192.168.68.88");
  assert.equal(target.hostOverride.source, "observed-remote-address");
  assert.equal(target.diagnostics, undefined);
});

test("RNBO target transport controls route writes playback transport controls", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/transport-controls", {
    controls: {
      Clock: 1,
      Tempo: 120,
      MaxSteps: 32,
      ClockInterval: 125,
      SetStage: 0,
      Stage: 0
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/Tempo",
      value: 120
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/MaxSteps",
      value: 32
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/ClockInterval",
      value: 125
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/Stage",
      value: 0
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 32);
  assert.equal(context.config.rnbo.transport.Clock, undefined);
});

test("transport controls fan out concurrently across targets", async () => {
  let activeWriters = 0;
  let maxActiveWriters = 0;
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          { id: "client-a", host: "192.168.68.70", port: 1234, address: "/rnbo/inst/2/messages/in/shadowscore" },
          { id: "client-b", host: "192.168.68.71", port: 1234, address: "/rnbo/inst/3/messages/in/shadowscore" }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async () => {
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWriters -= 1;
      }
    }
  });

  const result = await requestJson(context, "POST", "/macrostructure/phase-reset", {});

  assert.equal(result.ok, true);
  assert.equal(maxActiveWriters, 2);
});

test("legacy RNBO target params route aliases transport controls", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/params", {
    params: {
      Clock: 0
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes.map((write) => write.path), [
    "/rnbo/inst/2/params/Clock/Clock"
  ]);
});

test("RNBO target transport controls route derives MaxSteps for assigned targets and starts clock last", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        stagesPerBeat: 16,
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });
  await requestJson(context, "POST", "/context?replace=1", {
    clip: {
      time_selection_start: 0,
      time_selection_end: 4
    },
    scale: {},
    grid: {},
    seed: 0
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "source-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });
  await requestJson(context, "POST", "/voices/player-1/notes", [
    {
      pitch: 60,
      start_time: 3.75,
      duration: 0.25,
      velocity: 100
    }
  ]);

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/transport-controls", {
    controls: {
      MaxSteps: 16,
      Clock: 1
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/MaxSteps",
      value: 64
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/ClockInterval",
      value: 30
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock/Clock",
      value: "On"
    }
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 64);
  assert.equal(context.config.rnbo.transport.ClockInterval, 30);
});

test("RNBO target transport controls route derives adaptive ClockInterval for assigned targets", async () => {
  const writes = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        resolution: {
          mode: "fit",
          maxStages: 1024,
          candidateStagesPerBeat: [16, 24, 30, 48, 60, 80, 96, 120, 160, 240, 480]
        },
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    }),
    runtime: {
      rnboParamWriter: async (write) => {
        writes.push(write);
      }
    }
  });
  await requestJson(context, "POST", "/context?replace=1", {
    clip: {
      time_selection_start: 0,
      time_selection_end: 4
    },
    scale: {},
    grid: {},
    seed: 0
  });
  await requestJson(context, "POST", "/voices/player-1/assignment", {
    rnboTargetId: "source-client",
    rnboHost: "192.168.68.96",
    rnboPort: 9000,
    rnboAddress: "/rnbo/inst/2/messages/in/shadowscore"
  });

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/transport-controls", {
    controls: {
      Clock: 1
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes.map((write) => [write.path, write.value]), [
    ["/rnbo/inst/2/messages/in/MaxSteps", 960],
    ["/rnbo/inst/2/messages/in/ClockInterval", 2],
    ["/rnbo/inst/2/params/Clock/Clock", "On"]
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 960);
  assert.equal(context.config.rnbo.transport.ClockInterval, 2);
});

test("RNBO target transport controls route rejects unsupported controls", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      rnbo: {
        targets: [
          {
            id: "source-client",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/shadowscore"
          }
        ]
      }
    })
  });

  const response = await request(context, "POST", "/rnbo/targets/source-client/transport-controls", {
    Gain: 1
  });

  assert.equal(response.status, 400);
  assert.match(response.body, /unsupported RNBO transport control 'Gain'/);
});

test("matrix edit route serves static app html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/matrix-edit");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Matrix Edit/);
  assert.match(response.body, /id="start-transport"/);
  assert.match(response.body, /id="stop-transport"/);
  assert.match(response.body, /id="return-start"/);
  assert.match(response.body, /performance-toolbar/);
  assert.match(response.body, /advanced-panel/);
  assert.doesNotMatch(response.body, /\/macrostructure\/playback\/\$\{running \? "start" : "stop"\}/);
  assert.doesNotMatch(response.body, /\/rnbo\/targets\/\$\{encodeURIComponent\(targetId\)\}\/params/);
});

test("matrix edit route works with legacy generated static config", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      static: {
        apps: {
          matrixEdit: {
            root: "public/matrix-edit",
            index: "index.html",
            routes: ["/", "/app"]
          }
        }
      }
    })
  });
  const response = await request(context, "GET", "/matrix-edit");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Matrix Edit/);
});

test("piano roll route serves the autosaving clip editor", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/piano-roll");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Piano Roll/);
  assert.doesNotMatch(response.body, /id="save"/);
  assert.match(response.body, /save automatically/);
  assert.match(response.body, /id="roll"/);
});

test("root route serves view index", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Views/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /\/editors/);
  assert.match(response.body, /ShadowScore Editors/);
  assert.match(response.body, /OSC Generators/);
  assert.match(response.body, /href="\/tools\/osc-volume"/);
  assert.match(response.body, /href="\/tools\/osc-macros"/);
  const rootNav = response.body.match(/<nav class="ss-route-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.doesNotMatch(rootNav, /\/tools\/osc-volume/);
  assert.doesNotMatch(rootNav, /\/tools\/osc-macros/);
  assert.match(response.body, /\/structure-editor/);
  assert.match(response.body, /\/matrix-edit/);
  assert.match(response.body, /<a href="\/piano-roll">ShadowScore<\/a>/);
  assert.match(response.body, /\/event-list/);
  assert.match(response.body, /\/admin/);
  assert.match(response.body, /\/transport\/status/);
  assert.match(response.body, /\/rnbo\/devices/);
  assert.match(response.body, /:3000/);
  assert.match(response.body, /Online Hardware Units/);
  assert.match(response.body, /device\.available === false \|\| device\.unitStatus === "offline"/);
  assert.match(response.body, /Ensemble Coordinator/);
  assert.match(response.body, /\/coordinator\/claim/);
  assert.match(response.body, /\/coordinator\/select/);
  assert.match(response.body, /discovered via Bonjour/);
});

test("editor manifest route lists registered instrument editors", async () => {
  const context = createRouteContext();
  const response = await requestJson(context, "GET", "/editors/manifest");

  assert.equal(response.editors.length, 12);
  assert.deepEqual(response.editors, [
    {
      id: "poland",
      label: "Poland",
      route: "/editors/poland",
      targetFilter: {
        app: "poland"
      }
    },
    {
      id: "ttid",
      label: "Block Attributes",
      route: "/editors/ttid",
      targetFilter: {
        capability: "block-attributes-edit"
      }
    },
    {
      id: "plate",
      label: "Plate",
      route: "/editors/plate",
      targetFilter: {
        app: "plate"
      }
    },
    {
      id: "softpiano",
      label: "SoftPiano",
      route: "/editors/softpiano",
      targetFilter: {
        app: "softpiano"
      }
    },
    {
      id: "element",
      label: "Element",
      route: "/editors/element",
      targetFilter: {
        app: "element"
      }
    },
    {
      id: "vantor",
      label: "Vantor",
      route: "/editors/vantor",
      targetFilter: {
        app: "vantor"
      }
    },
    {
      id: "drumbox",
      label: "Drumbox",
      route: "/editors/drumbox",
      targetFilter: {
        app: "drumbox"
      }
    },
    {
      id: "listsequencer",
      label: "ListSequencer",
      route: "/editors/listsequencer",
      targetFilter: {
        app: "listsequencer"
      }
    },
    {
      id: "listvelsequencer",
      label: "ListVelSequencer",
      route: "/editors/listvelsequencer",
      targetFilter: {
        app: "listvelsequencer"
      }
    },
    {
      id: "analogsequencer",
      label: "AnalogSequencer",
      route: "/editors/analogsequencer",
      targetFilter: {
        app: "analogsequencer"
      }
    },
    {
      id: "triggersequencer",
      label: "TriggerSequencer",
      route: "/editors/triggersequencer",
      targetFilter: {
        app: "triggersequencer"
      }
    },
    {
      id: "singlehalfkrell",
      label: "SingleHalfKrell",
      route: "/editors/singlehalfkrell",
      targetFilter: {
        app: "singlehalfkrell"
      }
    }
  ]);
});

test("editor manifest route normalizes custom editor config", async () => {
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      editors: [
        {
          id: "Element Synth",
          label: "Element",
          route: "editors/element",
          targetFilter: {
            app: "Element",
            capability: "Editor",
            status: "Online"
          }
        }
      ]
    })
  });
  const response = await requestJson(context, "GET", "/editors/manifest");

  assert.deepEqual(response.editors, [{
    id: "element-synth",
    label: "Element",
    route: "/editors/element",
    targetFilter: {
      app: "element",
      capability: "editor",
      status: "online"
    }
  }]);
});

test("editor index route serves registered editor browser", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore OSC Generators/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /OSC Generators/);
  assert.match(response.body, /\/editors\/manifest/);
  assert.match(response.body, /\/osc\/targets/);
  assert.match(response.body, /filterText/);
  assert.match(response.body, /href="\/tools\/osc-volume"/);
  assert.match(response.body, /href="\/tools\/osc-macros"/);
  const editorNav = response.body.match(/<nav class="ss-route-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.doesNotMatch(editorNav, /\/tools\/osc-volume/);
  assert.doesNotMatch(editorNav, /\/tools\/osc-macros/);
});

test("event list route serves server-bundled editor html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/event-list");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Event List/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /id="clip"/);
  assert.match(response.body, /id="new-clip"/);
  assert.match(response.body, /id="rename-clip"/);
  assert.match(response.body, /id="delete-clip"/);
  assert.match(response.body, /id="clip-playback-type"/);
  assert.match(response.body, /id="clip-time-numerator"/);
  assert.match(response.body, /id="clip-time-denominator"/);
  assert.match(response.body, /TimeSignature/);
  assert.match(response.body, /id="clip-save-state"/);
  assert.match(response.body, /Commit Bulk Edit/);
  assert.match(response.body, /queueAutosave/);
  assert.match(response.body, /playbackType/);
  assert.match(response.body, /duration/);
  assert.match(response.body, /one-shot/);
  assert.match(response.body, /id="server-select"/);
  assert.match(response.body, /id="discover"/);
  assert.match(response.body, /pt5\.local:8790/);
  assert.match(response.body, /\/session/);
  assert.match(response.body, /id="ableton-notes"/);
  assert.match(response.body, /id="replace-array"/);
  assert.match(response.body, /id="add-array"/);
  assert.match(response.body, /POST/);
  assert.match(response.body, /\/clips\/\$\{encodeURIComponent\(clipId\)\}/);
  assert.match(response.body, /createShadowScoreClientState/);
  assert.match(response.body, /clipDraftKey/);
  assert.match(response.body, /expectedScoreRevision/);
});

test("structure editor route serves server-bundled editor html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/structure-editor");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Arrange/);
  assert.doesNotMatch(response.body, /<header(?:\s|>)/);
  assert.match(response.body, /Block Assignments/);
  assert.match(response.body, /Assigned Clip/);
  assert.match(response.body, /Duplicate Block/);
  assert.match(response.body, /Arrangement/);
  assert.match(response.body, /Add to Arrangement/);
  assert.match(response.body, /Cue Section/);
  assert.match(response.body, /class="performance-group" aria-label="Players"/);
  assert.match(response.body, /id="players-play" type="button">Play/);
  assert.match(response.body, /class="performance-group" aria-label="Arrangement"/);
  assert.match(response.body, /id="arrangement-hold" type="button">Hold/);
  assert.match(response.body, /Follow Block Tempo/);
  assert.match(response.body, /id="block-swing-amt" type="number" min="0\.5" max="1"/);
  assert.match(response.body, /Math\.max\(0\.5, Math\.min\(1, numberValue\(els\.blockSwingAmt\.value, 0\.5\)\)\)/);
  assert.match(response.body, /liveTempoDirty: false/);
  assert.match(response.body, /els\.liveTempo\.addEventListener\("input", \(\) => \{\s+state\.liveTempoDirty = true/);
  assert.match(response.body, /if \(!state\.liveTempoDirty\) \{\s+els\.liveTempo\.value = String\(state\.tempoPolicy\.live \?\? 120\)/);
  assert.match(response.body, /state\.liveTempoDirty = false;\s+renderMacroPlaybackStatus\(\)/);
  assert.match(response.body, /draggable = true/);
  assert.match(response.body, /reorderChain/);
  assert.match(response.body, /drop-before/);
  assert.match(response.body, /drop-after/);
  assert.match(response.body, /event\.clientX < bounds\.left \+ \(bounds\.width \/ 2\)/);
  assert.doesNotMatch(response.body, /drag-target/);
  assert.match(response.body, /Press Backspace or Delete to remove/);
  assert.match(response.body, /removeChainEntry/);
  assert.doesNotMatch(response.body, /occurrence-actions/);
  assert.doesNotMatch(response.body, /Alt plus arrow keys/);
  assert.match(response.body, /data-selected/);
  assert.match(response.body, /updateArrangementSelection/);
  assert.match(response.body, /createWiperEstimator/);
  assert.match(response.body, /requestAnimationFrame/);
  assert.match(response.body, /setInterval\(\(\) => void refreshPerformanceSnapshot\(\), 250\)/);
  assert.match(response.body, /sameOriginDiscoveryTimeoutMs = 10000/);
  assert.match(response.body, /url === sameOrigin \? sameOriginDiscoveryTimeoutMs : discoveryTimeoutMs/);
  assert.match(response.body, /bindEvents\(\);\s+renderAll\(\);\s+await discoverServers\(\)/);
  assert.match(response.body, /state\.score \? "No blocks\." : "No score loaded\."/);
  assert.match(response.body, /els\.macroPlaybackState\.textContent = "No score loaded"/);
  assert.match(response.body, /activeBlockDurationBeats/);
  assert.match(response.body, /id="block-list"/);
  assert.match(response.body, /id="players"/);
  assert.match(response.body, /id="duplicate-block"/);
  assert.match(response.body, /id="chain"/);
  assert.match(response.body, /id="active-block"/);
  assert.match(response.body, /id="set-active-block"/);
  assert.match(response.body, /id="advance-block"/);
  assert.match(response.body, /id="reset-block"/);
  assert.match(response.body, />Return to Start<\/button>/);
  assert.doesNotMatch(response.body, /Return to A/);
  assert.match(response.body, /id="players-play"/);
  assert.match(response.body, /id="players-stop"/);
  assert.match(response.body, /id="arrangement-run"/);
  assert.match(response.body, /id="arrangement-hold"/);
  assert.match(response.body, /id="macro-playback-status"/);
  assert.match(response.body, /id="macro-playback-state"/);
  assert.match(response.body, /id="macro-playback-detail"/);
  assert.match(response.body, /repeat\(auto-fit, minmax\(120px, 1fr\)\)/);
  assert.match(response.body, /\.panel-body > \* \{\s+min-width: 0;/);
  assert.match(response.body, /formatRemaining/);
  assert.match(response.body, /Create new clip/);
  assert.match(response.body, /row\.style\.flexGrow = String\(blockDurationBeats/);
  assert.match(response.body, /blocks: chainRows\(\)\.map\(\(row\) => row\.dataset\.blockId\)/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(sourceBlockId\)\}\/duplicate/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(nextId\)\}/);
  assert.match(response.body, /\/clips\/\$\{encodeURIComponent\(clipId\)\}/);
  assert.match(response.body, /\/macrostructure/);
  assert.match(response.body, /\/structure\/playhead/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /\/transport\/players\/play/);
  assert.match(response.body, /\/transport\/players\/stop/);
  assert.match(response.body, /\/transport\/arrangement\/run/);
  assert.match(response.body, /\/transport\/arrangement\/hold/);
  assert.match(response.body, /\/transport\/tempo\/follow-block/);
  assert.match(response.body, /createShadowScoreClientState/);
  assert.match(response.body, /blockDraftKey/);
  assert.match(response.body, /withExpectedStructureRevision/);
  assert.match(response.body, /expectedStructureRevision/);
  assert.match(response.body, /id="block-save-state"/);
  assert.match(response.body, /id="macro-save-state"/);
  assert.match(response.body, /queueStructureAutosave/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(nextId\)\}\/ttid/);
  assert.doesNotMatch(response.body, /Runtime TTID differs/);
  assert.doesNotMatch(response.body, /Save Assignments|Save Song Form/);
  assert.doesNotMatch(response.body, /scoreWithLocalDrafts/);
});

test("Poland editor route serves the OSC target integration page", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/poland");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Poland Editor/);
  assert.match(response.body, /\/osc\/targets\?app=poland/);
  assert.match(response.body, /param/);
  assert.match(response.body, /POLAND_GROUPS/);
  assert.match(response.body, /title: "OSC A"/);
  assert.match(response.body, /data-group="oscillator-a"/);
  assert.match(response.body, /VolA/);
  assert.match(response.body, /FilterKeyTracking/);
  assert.match(response.body, /HPFFreq: "High Pass"/);
  assert.match(response.body, /Portamento: "Glide"/);
  assert.match(response.body, /FilterAttack: "Attack"/);
  assert.match(response.body, /FilterRelease: "Release"/);
  assert.match(response.body, /WavetableA: "Wave"/);
  assert.match(response.body, /function shouldCurve/);
  assert.match(response.body, /function valueToSliderPosition/);
  assert.match(response.body, /addEventListener\("input", \(\) => scheduleParamSend/);
  assert.match(response.body, /bindRangeCommit/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, /async function getData/);
  assert.match(response.body, /OSCQuery parameter read failed/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("Block Attributes editor route serves the mixed-capability OSC target integration page", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/ttid");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Block Attributes Editor/);
  assert.match(response.body, /\/osc\/targets\?capability=block-attributes-edit/);
  assert.match(response.body, /ChromaticTranspose/);
  assert.match(response.body, /ScalarTranspose/);
  assert.match(response.body, /editor: ttid/);
  assert.match(response.body, /SCALES/);
  assert.match(response.body, /ionian/);
  assert.match(response.body, /formatMask/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, />Read Instance</);
  assert.match(response.body, /id="get-state"/);
  assert.match(response.body, /async function getState/);
  assert.match(response.body, /OSCQuery parameter read failed/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
  assert.match(response.body, /snapshotClient\?\.syncScore\(body\.score\)/);
  assert.match(response.body, /Block Attributes/);
  assert.match(response.body, /Send Swing To Selected/);
  assert.match(response.body, /id="block-swing-amt" type="number" min="0\.5" max="1"/);
  assert.match(response.body, /Swing Amount must be from 0\.5 through 1/);
  assert.match(response.body, /Not all selected destinations support all the data/);
  assert.match(response.body, /destinationTargets: selected/);
  assert.doesNotMatch(response.body, /Runtime TTID differs/);
});

test("Plate editor route serves the OSC target integration page", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/plate");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Plate Editor/);
  assert.match(response.body, /\/osc\/targets\?app=plate/);
  assert.match(response.body, /param/);
  assert.match(response.body, /PLATE_GROUPS/);
  assert.match(response.body, /data-group="time"/);
  assert.match(response.body, /PreDelay/);
  assert.match(response.body, /function shouldCurve/);
  assert.match(response.body, /function valueToSliderPosition/);
  assert.match(response.body, /plate-choice/);
  assert.match(response.body, /scheduleParamSend/);
  assert.match(response.body, /flushParamSend/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, /async function getData/);
  assert.match(response.body, /OSCQuery parameter read failed/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("SoftPiano editor route serves the compact OSC control panel", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/softpiano");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /SoftPiano Editor/);
  assert.match(response.body, /\/osc\/targets\?app=softpiano/);
  assert.match(response.body, /SOFTPIANO_GROUPS/);
  assert.doesNotMatch(response.body, /TransposeSoftPiano/);
  assert.match(response.body, /title: "Output", controls: \["OutputVolume", "HPFFreq"\]/);
  assert.match(response.body, /FilterKeyTracking/);
  assert.match(response.body, /HPFFreq: "High Pass"/);
  assert.match(response.body, /Amp Env/);
  assert.match(response.body, /function shouldCurve/);
  assert.match(response.body, /function valueToSliderPosition/);
  assert.match(response.body, /scheduleSend/);
  assert.match(response.body, /flushSend/);
  assert.match(response.body, /renderChoice/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, /async function getData/);
  assert.match(response.body, /OSCQuery parameter read failed/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("Element editor route serves the current nested OSC control panel", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/element");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Element Editor/);
  assert.match(response.body, /\/osc\/targets\?app=element/);
  assert.match(response.body, /ELEMENT_GROUPS/);
  assert.match(response.body, /OutputVolume/);
  assert.match(response.body, /LFOShape/);
  assert.match(response.body, /SawLevel/);
  assert.match(response.body, /FilterMode/);
  assert.match(response.body, /FilterEnvAttack/);
  assert.match(response.body, /VCAEnvRelease/);
  assert.match(response.body, /parameterNodesByAddress/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("Vantor editor route follows the live nested oscillator and envelope structure", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/vantor");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Vantor Editor/);
  assert.match(response.body, /\/osc\/targets\?app=vantor/);
  assert.match(response.body, /VANTOR_GROUPS/);
  assert.match(response.body, /prefix: "OscA\/"/);
  assert.match(response.body, /prefix: "OscB\/"/);
  assert.match(response.body, /prefix: "OscC\/"/);
  assert.match(response.body, /prefix: "FilterEnv\/"/);
  assert.match(response.body, /prefix: "AmpEnv\/"/);
  assert.match(response.body, /title: "Mixer"/);
  assert.match(response.body, /\["OscA\/Level", "OscB\/Level", "OscC\/Level", "Noise", "RingMod"\]/);
  assert.match(response.body, /"OscA\/Level": "OSC A"/);
  assert.match(response.body, /parameterKey/);
  assert.match(response.body, /targetParam\.address/);
  assert.match(response.body, /parameterNodesByAddress/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("Drumbox editor route follows the live nested drum voice structure", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/drumbox");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Drumbox Editor/);
  assert.match(response.body, /\/osc\/targets\?app=drumbox/);
  assert.match(response.body, /DRUMBOX_GROUPS/);
  assert.match(response.body, /prefix: "SynthDrum1\/"/);
  assert.match(response.body, /prefix: "SynthDrum2\/"/);
  assert.match(response.body, /prefix: `Sample\$\{number\}\/`/);
  assert.match(response.body, /const SAMPLE_CONTROLS = \["PlayMode", "Note", "Sample", "Transpose", "Attack", "Hold", "Release", "Level", "Pan", "AuxSend"\]/);
  assert.match(response.body, /"AuxSend"/);
  assert.match(response.body, /"AmpModEnvHoldTime"/);
  assert.match(response.body, /prefix: "RnboPlateReverb\/"/);
  assert.match(response.body, /parameterPath\(param\)\.startsWith\(group\.prefix\)/);
  assert.match(response.body, /return param\?\.meta\?\.label \|\| LABELS\[param\?\.name\]/);
  assert.match(response.body, /\.controls \{[^}]*min-width: 0; width: 100%;/);
  assert.match(response.body, /\.control \{[^}]*flex: 1 1 0;[^}]*min-width: 0;/);
  assert.match(response.body, /\.control-readout \{[^}]*height: 14px;[^}]*white-space: nowrap;/);
  assert.match(response.body, /\.panel\[data-group\^="sample-"\] \.control-label \{[^}]*font-size: 9px;[^}]*white-space: nowrap;/);
  assert.match(response.body, /Array\.isArray\(param\.values\) && param\.values\.length/);
  assert.match(response.body, /function renderChoice\(param\)/);
  assert.match(response.body, /function renderSwitch\(param\)/);
  assert.match(response.body, /input\.setAttribute\("role", "switch"\)/);
  assert.match(response.body, /return "SHOT"/);
  assert.match(response.body, /newestTarget\(\)\?\.id/);
  assert.match(response.body, /syncParamsToReadSource\(\{ preserve: false \}\)/);
  assert.match(response.body, /refresh\(\)\.then\(\(\) => snapshotClient\.init\(\)\)/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("ListSequencer editor route serves the OSC target integration page", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/listsequencer");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ListSequencer Editor/);
  assert.match(response.body, /\/osc\/targets\?app=listsequencer/);
  assert.match(response.body, /inputPorts/);
  assert.match(response.body, /parseArgs/);
  assert.match(response.body, /compact TTID/);
  assert.match(response.body, /formatMask/);
  assert.match(response.body, /Steps \(0\/1\)/);
  assert.match(response.body, /Secondary Steps \(0\/1\)/);
  assert.match(response.body, /Primary Rotation \(-60 60\)/);
  assert.match(response.body, /Secondary Rotation \(-60 60\)/);
  assert.match(response.body, /Octave/);
  assert.match(response.body, /Velocity \(0-127\)/);
  assert.match(response.body, /Duration \(ticks\)/);
  assert.match(response.body, /Clock Mode/);
  assert.match(response.body, /Arb Beats/);
  assert.match(response.body, /Return to Zero/);
  assert.match(response.body, /isMomentaryInputPort/);
  assert.match(response.body, /!isMomentaryInputPort\(inputPort\)/);
  assert.match(response.body, /createNumberObject/);
  assert.match(response.body, /chromatictranspose/);
  assert.match(response.body, /scalartranspose/);
  assert.match(response.body, /rootParams/);
  assert.match(response.body, /genericParams/);
  assert.match(response.body, /renderGenericParam/);
  assert.match(response.body, /param\.values/);
  assert.match(response.body, /isToggleParam/);
  assert.match(response.body, /Instance focus/);
  assert.doesNotMatch(response.body, />Read Instance</);
  assert.match(response.body, /refresh\(\{ hydrate: true \}\)/);
  assert.match(response.body, /if \(hydrate && targets\.length\) await populateFields\(\)/);
  assert.match(response.body, /readOnBlockChange: true/);
  assert.match(response.body, /args: \[-999\]/);
  assert.match(response.body, /messages\/out\/\$\{encodeURIComponent\(inputPortName\)\}Ack/);
  assert.match(response.body, /formatAckValue/);
  assert.match(response.body, /data-rotate="left"/);
  assert.match(response.body, /data-rotate="right"/);
  assert.match(response.body, /async function rotateInputPort/);
  assert.match(response.body, /function rotateList/);
  assert.match(response.body, /inputPortState = new Map/);
  assert.match(response.body, /inputPortState\.set\(input\.dataset\.inport, input\.value\)/);
  assert.match(response.body, /inputPortState\.set\(inputPort\.name, input\.value\)/);
  assert.match(response.body, /\[values\.at\(-1\), \.\.\.values\.slice\(0, -1\)\]/);
  assert.match(response.body, /\[\.\.\.values\.slice\(1\), values\[0\]\]/);
  assert.match(response.body, /hydrateParameters/);
  assert.match(response.body, /readOscQueryParameterValues/);
  assert.match(response.body, /id="snapshot-mount"/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.doesNotMatch(response.body, /Write snapshot to|Save Snapshot/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /createOscEditorSnapshot/);
  assert.match(response.body, /snapshotClient\?\.syncScore\(body\.score\)/);
  assert.match(response.body, /20260806-block-swing1/);
});

test("ListVelSequencer editor route serves row-level get and multi-target send controls", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/listvelsequencer");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ListVelSequencer Editor/);
  assert.match(response.body, /\/osc\/targets\?app=listvelsequencer/);
  assert.match(response.body, /ROW_COUNT = 8/);
  assert.match(response.body, /0 = rest/);
  assert.match(response.body, /Pitch map · auto/);
  assert.match(response.body, />Send Row</);
  assert.match(response.body, /args: GET_REQUEST/);
  assert.match(response.body, /messages\/out\/\$\{row\.number\}rowAck/);
  assert.match(response.body, /inputPort: inputPort\.name/);
  assert.match(response.body, /param: mapParam\.name/);
  assert.match(response.body, /sendPitchMap/);
  assert.match(response.body, /data-row-mute/);
  assert.match(response.body, /function muteNumber/);
  assert.match(response.body, /async function sendRowMute/);
  assert.match(response.body, /param: param\.name, args: \[value\]/);
  assert.match(response.body, /muteIsOn\(current, sourceParam\) \? muteOffValue\(sourceParam\) : muteOnValue\(sourceParam\)/);
  assert.match(response.body, /String\(value\)\.toLowerCase\(\) === "on"/);
  assert.match(response.body, /String\(value\)\.toLowerCase\(\) === "off"/);
  assert.match(response.body, /mapNumber\(param\.name\) \|\| muteNumber\(param\.name\)/);
  assert.doesNotMatch(response.body, /schedulePitchMap|flushPitchMap/);
  assert.match(response.body, /parseVelocityList/);
  assert.match(response.body, /data-rotate-row="left"/);
  assert.match(response.body, /data-rotate-row="right"/);
  assert.match(response.body, /async function rotateRow/);
  assert.match(response.body, /function rotateList/);
  assert.match(response.body, /\[values\.at\(-1\), \.\.\.values\.slice\(0, -1\)\]/);
  assert.match(response.body, /\[\.\.\.values\.slice\(1\), values\[0\]\]/);
  assert.match(response.body, /collectGlobalParams/);
  assert.match(response.body, /renderGlobalParams/);
  assert.match(response.body, /param\.values/);
  assert.match(response.body, /isToggleParam/);
  assert.match(response.body, /sendGlobalParam/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, /async function getData/);
  assert.doesNotMatch(response.body, />Read Instance</);
  assert.match(response.body, /refresh\(\{ hydrate: true \}\)/);
  assert.match(response.body, /if \(hydrate && targets\.length\) await getData\(\)/);
  assert.match(response.body, /readOnBlockChange: true/);
  assert.match(response.body, /readOscQueryParameterValues/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
  assert.match(response.body, /20260806-block-swing1/);
});

test("AnalogSequencer editor route serves the 16-stage OSC control surface", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/analogsequencer");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /AnalogSequencer Editor/);
  assert.match(response.body, /\/osc\/targets\?app=analogsequencer/);
  assert.match(response.body, /StageValue/);
  assert.match(response.body, /StageStep/);
  assert.match(response.body, /repeat\(16/);
  assert.match(response.body, /midiNote/);
  assert.match(response.body, /Slider Pitch Range/);
  assert.match(response.body, /id="pitch-range-min"/);
  assert.match(response.body, /id="pitch-range-max"/);
  assert.match(response.body, /pitchRange = \{ min: 24, max: 72 \}/);
  assert.match(response.body, /populatePitchRangeControls/);
  assert.match(response.body, /applyPitchRange/);
  assert.match(response.body, /stagePitchBounds/);
  assert.match(response.body, /clipped \$\{changed\.length\} stage/);
  assert.match(response.body, /id="mutate"/);
  assert.match(response.body, /mutateSequence/);
  assert.match(response.body, /mutationFallback/);
  assert.match(response.body, /Math\.random\(\) < 0\.125/);
  assert.match(response.body, /Mutated \$\{summary\}/);
  assert.match(response.body, /type = "checkbox"/);
  assert.match(response.body, /messages\/out\/current_stage/);
  assert.match(response.body, /setPlayingStage/);
  assert.match(response.body, /oscPlaybackWiperVisible/);
  assert.match(response.body, /stagePollGeneration/);
  assert.match(response.body, /isCurrentStagePoll/);
  assert.match(response.body, /\.stage\.playing/);
  assert.match(response.body, /RTZ Selected/);
  assert.match(response.body, /Clock Selected Off/);
  assert.match(response.body, /Clock Selected On/);
  assert.match(response.body, /inputPort: "rtz"/);
  assert.match(response.body, /setAllClocks/);
  assert.match(response.body, /setAllClocks\("Off"\)/);
  assert.match(response.body, /setAllClocks\("On"\)/);
  assert.match(response.body, /Quantizer TTID/);
  assert.match(response.body, /id="ttid-keys"/);
  assert.match(response.body, /\/harmonic\/scales/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(state\.blockId\)\}\/ttid/);
  assert.match(response.body, /auditionTargets: selected/);
  assert.match(response.body, /snapshotClient\?\.syncScore\(body\.score\)/);
  assert.match(response.body, /isTtidParam/);
  assert.match(response.body, /encodeScale/);
  assert.match(response.body, /Voltage Shift/);
  assert.match(response.body, /Middle C = 0 V/);
  assert.match(response.body, /portamento/);
  assert.match(response.body, /Number\(param\.steps\)/);
  assert.match(response.body, /span \/ \(steps - 1\)/);
  assert.match(response.body, /\$\{formatted\} ms/);
  assert.match(response.body, /param: "Clock"/);
  assert.match(response.body, /renderParameters/);
  assert.match(response.body, /function shouldCurve/);
  assert.match(response.body, /function valueToSliderPosition/);
  assert.match(response.body, /applyMaxCount/);
  assert.match(response.body, /isMaxCountParam/);
  assert.match(response.body, /maxcnt/);
  assert.match(response.body, /maxCountParamValue/);
  assert.match(response.body, /maxCountWireValue/);
  assert.match(response.body, /normalizeMaxCountParam/);
  assert.match(response.body, /function maxCountWireValue\(stageCount\) \{ return String\(clamp\(integerValue\(stageCount, 16\), 1, 16\)\); \}/);
  assert.match(response.body, /function normalizeMaxCountParam\(param\) \{ return isMaxCountParam\(param\) \? \{ \.\.\.param, value: String\(clamp\(integerValue\(param\.value, 16\), 1, 16\)\) \} : param; \}/);
  assert.match(response.body, /uniqueParameterValues/);
  assert.match(response.body, /Max Count/);
  assert.match(response.body, /\.stage\.unused/);
  assert.match(response.body, /Instance focus/);
  assert.match(response.body, /type="checkbox"/);
  assert.match(response.body, /selectedTargetIds/);
  assert.match(response.body, /readSourceId/);
  assert.match(response.body, /hydrateReadSource/);
  assert.match(response.body, /readOscQueryParameterValues/);
  assert.match(response.body, /isToggleParam/);
  assert.match(response.body, /parameter-toggle/);
  assert.match(response.body, /id="snapshot-mount"/);
  assert.match(response.body, /mountOscSnapshotPanel/);
  assert.doesNotMatch(response.body, /Write snapshot to|Save Snapshot/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
  assert.match(response.body, /bindRangeCommit/);
  assert.match(response.body, /pointerdown/);
  assert.match(response.body, /pointerup/);
  assert.match(response.body, /commitGesture/);
  assert.match(response.body, /commitEdit/);
  assert.doesNotMatch(response.body, /draftChanged/);
  assert.match(response.body, /20260806-block-swing1/);
  assert.match(response.body, /dataset\.snapshotValue/);
  assert.match(response.body, /id="rtz-before-play"/);
  assert.match(response.body, /On block change, send RTZ before play/);
  assert.match(response.body, /recall: \{ rtzBeforePlay: rtzBeforePlayInput\.checked \}/);
});

test("TriggerSequencer editor route serves the 16-bit block-recall surface", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/triggersequencer");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /TriggerSequencer Editor/);
  assert.match(response.body, /\/osc\/targets\?app=triggersequencer/);
  assert.match(response.body, /Steps is stored and recalled as one unsigned 16-bit integer/);
  assert.match(response.body, /repeat\(16/);
  assert.match(response.body, /1 << index/);
  assert.match(response.body, /messages\/out\/current_stage/);
  assert.match(response.body, /TriggerDuration/);
  assert.match(response.body, /canonicalParamName/);
  assert.match(response.body, /return isMaxCount\(param\) \? "MaxCnt"/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("SingleHalfKrell editor route follows the live synthesis and quantizer contract", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/singlehalfkrell");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /SingleHalfKrell Editor/);
  assert.match(response.body, /\/osc\/targets\?app=singlehalfkrell/);
  assert.match(response.body, /SINGLE_HALF_KRELL_GROUPS/);
  assert.match(response.body, /MaxRandomTimeDomain/);
  assert.match(response.body, /PitchModAmtRandom/);
  assert.match(response.body, /ModulationRatioRangeFine/);
  assert.match(response.body, /Quantizer\/Scale/);
  assert.doesNotMatch(response.body, /Quantizer_1_/);
  assert.match(response.body, /steps > 1/);
  assert.match(response.body, /\(max - min\) \/ \(steps - 1\)/);
  assert.match(response.body, /keys\.id = "ttid-keys"/);
  assert.match(response.body, /\/harmonic\/scales/);
  assert.match(response.body, /encodeScale/);
  assert.match(response.body, /parameterNodesByAddress/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /serializeSnapshotState/);
  assert.match(response.body, /displaySavedState/);
});

test("OSC editors place controls above Block State and live destinations below it", async () => {
  const context = createRouteContext();
  const editors = [
    ["analogsequencer", 'id="stages"'],
    ["triggersequencer", 'id="steps"'],
    ["listsequencer", 'id="inports"'],
    ["listvelsequencer", 'id="parameters"'],
    ["plate", 'id="controls"'],
    ["poland", 'id="controls"'],
    ["softpiano", 'id="panels"'],
    ["element", 'id="panels"'],
    ["vantor", 'id="panels"'],
    ["drumbox", 'id="panels"'],
    ["singlehalfkrell", 'id="panels"'],
    ["ttid", 'id="editors"']
  ];
  for (const [editor, controlsMarker] of editors) {
    const response = await request(context, "GET", `/editors/${editor}`);
    assert.equal(response.status, 200);
    assert.match(response.body, /2026(?:0724-ttid-revision1|0727-nested-keys1|0806-block-swing1)/,
      `${editor} should load the instant-write snapshot client contract`);
    const controlsIndex = response.body.indexOf(controlsMarker);
    const blockStateIndex = response.body.indexOf('id="snapshot-mount"');
    const targetsIndex = response.body.indexOf('id="targets"');
    assert.ok(controlsIndex >= 0 && controlsIndex < blockStateIndex, `${editor} controls should precede Block State`);
    assert.ok(blockStateIndex < targetsIndex, `${editor} live destinations should follow Block State`);
    assert.match(response.body, /(?:Live And Save Destinations|Block Attribute Destinations)/);
    assert.match(response.body, /liveTargetRoot: targetsEl/);
    assert.match(response.body, /serializeState:/);
    assert.match(response.body, /displayState:/);
    assert.doesNotMatch(response.body, /draftChanged|serializeDraft|applySnapshot/);
  }
});

test("instant-write OSC editors expose their intended completion boundaries", async () => {
  const context = createRouteContext();
  for (const editor of ["analogsequencer", "softpiano", "element", "vantor", "drumbox", "singlehalfkrell", "plate", "poland"]) {
    const response = await request(context, "GET", `/editors/${editor}`);
    assert.match(response.body, /bindRangeCommit/);
    assert.match(response.body, /pointerdown/);
    assert.match(response.body, /pointerup/);
    assert.match(response.body, /commitGesture/);
  }

  const list = await request(context, "GET", "/editors/listsequencer");
  assert.match(list.body, /beginGesture/);
  assert.match(list.body, /pointerup/);
  assert.match(list.body, /commitGesture/);
  assert.match(list.body, /sendAddress[\s\S]*commitEdit/);

  const listVel = await request(context, "GET", "/editors/listvelsequencer");
  assert.match(listVel.body, /async function sendRow[\s\S]*commitEdit/);
  assert.match(listVel.body, /async function sendPitchMap[\s\S]*commitEdit/);
  assert.doesNotMatch(listVel.body, /schedulePitchMap|flushPitchMap/);

  const ttid = await request(context, "GET", "/editors/ttid");
  assert.match(ttid.body, /setParameterValue\(param\.name, value\);\s+snapshotClient\?\.commitEdit\(\)/);
});

test("OSC volume tool route serves target selection and trim controls", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/tools/osc-volume");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /OSC Volume/);
  assert.match(response.body, /\/osc\/targets\?status=online/);
  assert.match(response.body, /data-param-map/);
  assert.match(response.body, /editableParams/);
  assert.match(response.body, /preferredParam/);
  assert.match(response.body, /mappedValue/);
  assert.match(response.body, /data-trim/);
  assert.match(response.body, /Zero Trims/);
  assert.match(response.body, /data-shadow-nav/);
  assert.match(response.body, /<a href="\/editors" aria-current="page">OSC<\/a>/);
});

test("OSC macro tool route serves builder and validation controls", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/tools/osc-macros");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /OSC Macros/);
  assert.match(response.body, /\/osc\/macros/);
  assert.match(response.body, /\/osc\/targets\?status=online/);
  assert.match(response.body, /id="step-target"/);
  assert.match(response.body, /id="step-param"/);
  assert.match(response.body, /Dry Run/);
  assert.match(response.body, /validation-row/);
  assert.match(response.body, /Ensemble Transpose/);
  assert.match(response.body, /ChromaticTranspose/);
  assert.match(response.body, /ScalarTranspose/);
  assert.match(response.body, /\/osc\/macros\/run/);
  assert.match(response.body, /\/osc\/block-state\/capture/);
  assert.match(response.body, /Capture Compatible Instances to EDITING Block/);
  assert.match(response.body, /data-shadow-nav/);
  assert.match(response.body, /<a href="\/editors" aria-current="page">OSC<\/a>/);
});

test("shared client state module is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/shadowscore-client-state.js");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/javascript/);
  assert.match(response.body, /createShadowScoreClientState/);
  assert.match(response.body, /effectiveScore/);
});

test("shared playback update control is served and integrated across authoring editors", async () => {
  const context = createRouteContext();
  const asset = await request(context, "GET", "/shared/playback-update-control.js");
  assert.equal(asset.status, 200);
  assert.match(asset.body, /createPlaybackUpdateControl/);
  for (const route of ["/piano-roll", "/event-list", "/structure-editor"]) {
    const response = await request(context, "GET", route);
    assert.equal(response.status, 200);
    assert.match(response.body, /id="playback-update"/);
  }
  const pianoApp = await request(context, "GET", "/piano-roll/app.js");
  assert.match(pianoApp.body, /playback-update-control\.js/);
});

test("shared OSC snapshot editor client is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/osc-snapshot-editor.js");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/javascript/);
  assert.match(response.body, /createOscSnapshotEditorClient/);
  assert.match(response.body, /createOscEditorSnapshot/);
  assert.match(response.body, /sameOscSnapshot/);
  assert.match(response.body, /PLAYING/);
  assert.match(response.body, /EDITING/);
  assert.match(response.body, /CHASE/);
  assert.doesNotMatch(response.body, /Write — State|Reload Written State/);
  assert.match(response.body, /Unspecified/);
  assert.match(response.body, /Advanced clip tools/);
  assert.match(response.body, /Assign Selected Clip/);
  assert.doesNotMatch(response.body, /Write snapshot to|Save Snapshot/);
  assert.match(response.body, /oscClockRecallNotice/);
  assert.match(response.body, /expectedStructureRevision/);
  assert.match(response.body, /osc\/block-state"/);
  assert.doesNotMatch(response.body, /osc\/block-state\/write/);
  assert.doesNotMatch(response.body, /osc\/block-state\/copy/);
  assert.match(response.body, /osc\/block-state\/clear/);
  assert.match(response.body, /Clear State…/);
  assert.match(response.body, /This instance · this block/);
  assert.match(response.body, /All instances · this block/);
  assert.match(response.body, /All instances · all blocks/);
  assert.match(response.body, /Live output to:/);
  assert.doesNotMatch(response.body, /Save Copy To/);
  assert.match(response.body, /data-snapshot-copy-open/);
  assert.match(response.body, /osc\/block-state\/duplicate/);
  assert.match(response.body, /Copy Checked Block State/);
  assert.match(response.body, /checked instance/i);
  assert.doesNotMatch(response.body, /Unwritten Draft|Dirty Draft|dirty draft|serializeDraft|applySnapshot/);
  assert.match(response.body, /resolveFocusedOscRole/);
  assert.match(response.body, /oscBlockSlotState/);
  assert.match(response.body, /hydrateChasedPlayingBlock\(previousPlaying\)/);
  assert.match(response.body, /elements\.sourceSelect\?\.value !== focusedTargetId/);
  assert.match(response.body, /roles: \[roleId\]/);
  assert.match(response.body, /Chased PLAYING .* saved state into the editor/);
  assert.match(response.body, /captured from .*complete/);
});

test("shared ShadowScore stylesheet is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/shadowscore-style.css");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/css/);
  assert.match(response.body, /--ss-bg/);
  assert.match(response.body, /ss-route-tabs/);
});

test("shared musician transport bar is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/transport-bar.js");
  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /javascript/);
  assert.match(response.body, /\/api\/v1\/objects\/transport/);
  assert.match(response.body, /data-command="play"/);
  assert.match(response.body, /data-field="position"/);
  assert.match(response.body, /data-field="clock"/);
  assert.match(response.body, /data-field="bbt"/);
  assert.match(response.body, /data-field="tempo"/);
});

test("shared bipolar range renderer is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/bipolar-range.js");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/javascript/);
  assert.match(response.body, /min >= 0 \|\| max <= 0/);
  assert.match(response.body, /--ss-range-fill-start/);
});

test("shared grouped navigation defines and reaches every hosted user-facing page", async () => {
  const context = createRouteContext();
  const asset = await request(context, "GET", "/shared/shadowscore-nav.js");

  assert.equal(asset.status, 200);
  assert.match(asset.headers["Content-Type"], /text\/javascript/);
  for (const label of ["ShadowScore", "Arrange", "OSC", "Setup"]) {
    assert.match(asset.body, new RegExp(`label: "${label}"`));
  }
  for (const route of [
    "/piano-roll",
    "/matrix-edit",
    "/event-list",
    "/structure-editor",
    "/editors",
    "/editors/analogsequencer",
    "/editors/listsequencer",
    "/editors/listvelsequencer",
    "/editors/element",
    "/editors/vantor",
    "/editors/drumbox",
    "/editors/poland",
    "/editors/plate",
    "/editors/softpiano",
    "/editors/singlehalfkrell",
    "/editors/ttid",
    "/tools/osc-volume",
    "/tools/osc-macros",
    "/",
    "/admin",
    "/transport/status"
  ]) {
    assert.match(asset.body, new RegExp(`href: "${route.replaceAll("/", "\\/")}"`));
    const page = await request(context, "GET", route);
    assert.equal(page.status, 200, `${route} should resolve`);
    assert.match(page.body, /data-shadow-nav/, `${route} should expose the shared navigation mount`);
    const fallback = page.body.match(/<nav class="ss-route-tabs"[^>]*data-shadow-nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
    for (const group of ["ShadowScore", "Arrange", "OSC", "Setup"]) {
      assert.match(fallback, new RegExp(`>${group}<`), `${route} should retain the ${group} fallback`);
    }
  }
  assert.match(asset.body, /pointerdown/);
  assert.match(asset.body, /event\.key !== "Escape"/);
  assert.match(asset.body, /aria-current/);
});

test("OSC target route normalizes, filters, and reports stale targets", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "finch",
    advertisedName: "Finch",
    targets: [{
      id: "poland-main",
      name: "Finch Poland",
      host: "192.168.68.90",
      port: 1234,
      address: "/rnbo/inst/1/messages/in/poland",
      app: "poland",
      instance: "main",
      oscCapabilities: ["volume", "preset"]
    }]
  }, { remoteAddress: "192.168.68.91" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?app=poland&capability=volume");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].id, "finch:poland:main");
  assert.equal(response.targets[0].label, "Finch Poland");
  assert.equal(response.targets[0].status, "stale");
  assert.equal(response.targets[0].sendable, false);
  assert.equal(response.targets[0].capabilities.includes("poland-edit"), true);
  assert.equal(response.targets[0].diagnostics[0].type, "target-host-mismatch");
});

test("manual OSCQuery device routes manage endpoints and expose their editor targets", async () => {
  const devices = new Map();
  const registry = {
    async list() { return [...devices.values()]; },
    async probe(document) { return manualDevice({ ...document, id: "probe" }); },
    async save(document) {
      const device = manualDevice({ ...document, id: "studio-mac" });
      devices.set(device.id, device);
      return device;
    },
    async update(id, document) {
      const device = manualDevice({ ...devices.get(id), ...document, id });
      devices.set(id, device);
      return device;
    },
    async remove(id) {
      const device = devices.get(id);
      devices.delete(id);
      return device;
    },
    async refresh(id) { return devices.get(id); },
    async rnboTargets() { return []; },
    async rnboDevices() { return []; },
    async oscTargets() {
      return devices.size === 0 ? [] : [{
        id: "studio-mac:rnbo-inst-2:poland",
        localId: "rnbo-inst-2:poland",
        label: "Poland 2",
        host: "studio.local",
        port: 1234,
        baseAddress: "/rnbo/inst/2",
        app: "poland",
        instance: "main",
        hardwareUnitId: "studio-mac",
        hardwareUnitName: "Studio Mac",
        available: true,
        parameters: [{ name: "VolA", address: "/rnbo/inst/2/params/VolA" }]
      }];
    }
  };
  const context = createRouteContext({ runtime: { manualOscQueryDevices: registry } });

  const probe = await requestJson(context, "POST", "/oscquery/devices/probe", { host: "studio.local" });
  assert.equal(probe.device.id, "probe");

  const saved = await requestJson(context, "POST", "/oscquery/devices", { name: "Studio Mac", host: "studio.local" });
  assert.equal(saved.device.id, "studio-mac");
  const listed = await requestJson(context, "GET", "/oscquery/devices");
  assert.equal(listed.devices.length, 1);

  const targets = await requestJson(context, "GET", "/osc/targets?app=poland&status=online");
  assert.equal(targets.targets.length, 1);
  assert.equal(targets.targets[0].id, "studio-mac:poland:main");
  assert.equal(targets.targets[0].parameters[0].name, "VolA");

  const updated = await requestJson(context, "PATCH", "/oscquery/devices/studio-mac", { name: "Studio Rack" });
  assert.equal(updated.device.name, "Studio Rack");
  const refreshed = await requestJson(context, "POST", "/oscquery/devices/studio-mac/refresh");
  assert.equal(refreshed.device.id, "studio-mac");
  const removed = await requestJson(context, "DELETE", "/oscquery/devices/studio-mac");
  assert.equal(removed.device.id, "studio-mac");
  assert.deepEqual((await requestJson(context, "GET", "/oscquery/devices")).devices, []);
});

test("OSC send route resolves stable ids and reports per-target delivery", async () => {
  const sends = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      server: {
        hostIdentity: "local",
        advertisedName: "Local"
      },
      rnbo: {
        targets: [{
          id: "poland-source",
          name: "Poland Main",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/poland",
          app: "poland",
          instance: "main"
        }]
      }
    }),
    runtime: {
      oscSender: async (send) => {
        sends.push(send);
      }
    }
  });

  const result = await requestJson(context, "POST", "/osc/send", {
    targets: ["local:poland:main", "missing:poland:main"],
    address: "/volume",
    args: [0.7]
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].targetId, "local:poland:main");
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].error, /missing/);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].host, "192.168.68.96");
  assert.equal(sends[0].port, 9000);
  assert.equal(sends[0].address, "/volume");
  assert.deepEqual(sends[0].args, [0.7]);
});

test("OSC target route exposes registered Poland control targets", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-10:poland",
      label: "Poland 10",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/10",
      app: "poland",
      instance: "main",
      parameters: [{
        name: "VolA",
        key: "OscA/VolA",
        path: "Poland/OscA/VolA",
        address: "/rnbo/inst/10/params/VolA",
        value: 0.5,
        min: 0,
        max: 1,
        steps: 101
      }]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?app=poland");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].id, "heron:poland:main");
  assert.equal(response.targets[0].status, "online");
  assert.equal(response.targets[0].parameters[0].address, "/rnbo/inst/10/params/VolA");
  assert.equal(response.targets[0].parameters[0].key, "OscA/VolA");
  assert.equal(response.targets[0].parameters[0].path, "Poland/OscA/VolA");
  assert.equal(response.targets[0].parameters[0].steps, 101);
});

test("OSC target route exposes registered TTID control targets", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "wren",
    advertisedName: "Wren",
    oscTargets: [{
      id: "rnbo-inst-12:ttid",
      label: "Quantizer 12",
      host: "192.168.68.70",
      port: 1234,
      baseAddress: "/rnbo/inst/12",
      app: "ttid",
      instance: "main",
      parameters: [{
        name: "ttid",
        address: "/rnbo/inst/12/params/ttid",
        value: 2741,
        min: 0,
        max: 4095,
        meta: { editor: "ttid", display_as: "int" }
      }]
    }]
  }, { remoteAddress: "192.168.68.70" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?app=ttid&capability=ttid-edit");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].id, "wren:ttid:main");
  assert.equal(response.targets[0].status, "online");
  assert.equal(response.targets[0].capabilities.includes("ttid-edit"), true);
  assert.equal(response.targets[0].parameters[0].meta.editor, "ttid");
});

test("OSC target route preserves registered ListSequencer message inports", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-14:listsequencer",
      label: "ListSequencer 14",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/14",
      app: "listsequencer",
      instance: "main",
      inputPorts: [
        { name: "Steps", address: "/rnbo/inst/14/messages/in/Steps", type: "iiii" },
        { name: "Duration", address: "/rnbo/inst/14/messages/in/Duration" }
      ],
      parameters: [{ name: "Clock_1_", address: "/rnbo/inst/14/params/Clock_1_", value: 1 }]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?app=listsequencer&status=online");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].id, "heron:listsequencer:main");
  assert.deepEqual(response.targets[0].inputPorts.map((inputPort) => inputPort.name), ["Steps", "Duration"]);
  assert.equal(response.targets[0].inputPorts[0].address, "/rnbo/inst/14/messages/in/Steps");
  assert.equal(response.targets[0].inputPorts[0].type, "iiii");
  assert.equal(response.targets[0].parameters[0].name, "Clock");
  assert.equal(response.targets[0].parameters[0].address, "/rnbo/inst/14/params/Clock_1_");
});

test("OSC target route exposes TTID-tagged parameters from other RNBO apps", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "wren",
    advertisedName: "Wren",
    oscTargets: [{
      id: "rnbo-inst-13:listsequencer",
      label: "ListSequencer 13",
      host: "192.168.68.70",
      port: 1234,
      baseAddress: "/rnbo/inst/13",
      app: "listsequencer",
      instance: "main",
      parameters: [
        { name: "Scale", address: "/rnbo/inst/13/params/Scale", value: 2741, meta: { editor: "ttid" } },
        { name: "ChromaticTranspose", address: "/rnbo/inst/13/params/ChromaticTranspose", value: 0, min: -24, max: 24 },
        { name: "ScalarTranspose", address: "/rnbo/inst/13/params/ScalarTranspose", value: 0, min: -24, max: 24 }
      ]
    }]
  }, { remoteAddress: "192.168.68.70" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?capability=ttid-edit&status=online");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].app, "listsequencer");
  assert.deepEqual(response.targets[0].parameters.map((parameter) => parameter.name), [
    "Scale",
    "ChromaticTranspose",
    "ScalarTranspose"
  ]);
});

test("OSC send route resolves named parameters per target", async () => {
  const sends = [];
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-10:poland",
      label: "Poland 10",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/10",
      app: "poland",
      instance: "main",
      parameters: [{ name: "VolA", address: "/rnbo/inst/10/params/VolA" }]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({
    runtime: {
      peerRegistry: registry,
      oscSender: async (send) => sends.push(send)
    }
  });

  const result = await requestJson(context, "POST", "/osc/send", {
    targets: ["heron:poland:main"],
    param: "VolA",
    args: [0.42]
  });

  assert.equal(result.ok, true);
  assert.equal(result.param, "VolA");
  assert.equal(result.results[0].address, "/rnbo/inst/10/params/VolA");
  assert.equal(sends[0].address, "/rnbo/inst/10/params/VolA");
  assert.deepEqual(sends[0].args, [0.42]);
});

test("OSC send route resolves named input ports per target", async () => {
  const sends = [];
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  for (const [id, host, instanceId] of [["heron", "192.168.68.101", "14"], ["raven", "192.168.68.103", "15"]]) {
    registry.register({
      id,
      advertisedName: id,
      oscTargets: [{
        id: `rnbo-inst-${instanceId}:listsequencer`,
        label: `ListSequencer ${instanceId}`,
        host,
        port: 1234,
        baseAddress: `/rnbo/inst/${instanceId}`,
        app: "listsequencer",
        instance: "main",
        inputPorts: [{ name: "Steps", address: `/rnbo/inst/${instanceId}/messages/in/Steps` }]
      }]
    }, { remoteAddress: host });
  }
  const context = createRouteContext({
    runtime: {
      peerRegistry: registry,
      oscSender: async (send) => sends.push(send)
    }
  });

  const result = await requestJson(context, "POST", "/osc/send", {
    targets: ["heron:listsequencer:main", "raven:listsequencer:main"],
    inputPort: "Steps",
    args: [0, 2, 4]
  });

  assert.equal(result.ok, true);
  assert.equal(result.inputPort, "Steps");
  assert.deepEqual(sends.map((send) => send.address), [
    "/rnbo/inst/14/messages/in/Steps",
    "/rnbo/inst/15/messages/in/Steps"
  ]);
});

test("OSC send route dispatches multi-target writes concurrently", async () => {
  const sends = [];
  let releaseSends;
  const sendGate = new Promise((resolve) => { releaseSends = resolve; });
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  for (const [id, host, instanceId] of [["heron", "192.168.68.101", "14"], ["raven", "192.168.68.103", "15"]]) {
    registry.register({
      id,
      advertisedName: id,
      oscTargets: [{
        id: `rnbo-inst-${instanceId}:analogsequencer`,
        label: `AnalogSequencer ${instanceId}`,
        host,
        port: 1234,
        baseAddress: `/rnbo/inst/${instanceId}`,
        app: "analogsequencer",
        instance: "main",
        parameters: [{ name: "Clock", address: `/rnbo/inst/${instanceId}/params/Clock` }]
      }]
    }, { remoteAddress: host });
  }
  const context = createRouteContext({
    runtime: {
      peerRegistry: registry,
      oscSender: async (send) => { sends.push(send); await sendGate; }
    }
  });

  const requestPromise = requestJson(context, "POST", "/osc/send", {
    targets: ["heron:analogsequencer:main", "raven:analogsequencer:main"],
    param: "Clock",
    args: [1]
  });
  for (let attempt = 0; attempt < 10 && sends.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  const sendsBeforeRelease = sends.length;
  releaseSends();
  const result = await requestPromise;

  assert.equal(sendsBeforeRelease, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.targetId), ["heron:analogsequencer:main", "raven:analogsequencer:main"]);
});

test("OSC broadcast route expands live targets by query", async () => {
  const sends = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      server: {
        hostIdentity: "local",
        advertisedName: "Local"
      },
      rnbo: {
        targets: [
          {
            id: "poland-source",
            host: "192.168.68.96",
            port: 9000,
            address: "/rnbo/inst/2/messages/in/poland",
            app: "poland",
            instance: "main"
          },
          {
            id: "element-source",
            host: "192.168.68.97",
            port: 9000,
            address: "/rnbo/inst/3/messages/in/element",
            app: "element",
            instance: "main"
          }
        ]
      }
    }),
    runtime: {
      oscSender: async (send) => {
        sends.push(send);
      }
    }
  });

  const result = await requestJson(context, "POST", "/osc/broadcast", {
    where: { app: "poland", capability: "volume", status: "online" },
    address: "/volume",
    args: [0.5]
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].targetId, "local:poland:main");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].host, "192.168.68.96");
});

test("OSC macro routes persist, validate, and run ordered steps", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-osc-macros-"));
  const sends = [];
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      server: {
        hostIdentity: "local",
        advertisedName: "Local"
      },
      osc: {
        macros: {
          path: path.join(tmp, "macros.json")
        }
      },
      rnbo: {
        targets: [{
          id: "poland-source",
          host: "192.168.68.96",
          port: 9000,
          address: "/rnbo/inst/2/messages/in/poland",
          app: "poland",
          instance: "main"
        }]
      }
    }),
    runtime: {
      oscSender: async (send) => {
        sends.push(send);
      }
    }
  });

  const saved = await requestJson(context, "POST", "/osc/macros", {
    id: "soft-start-room",
    label: "Soft Start Room",
    steps: [{ target: "local:poland:main", address: "/volume", args: [0.4] }]
  });
  assert.equal(saved.macro.id, "soft-start-room");

  const listed = await requestJson(context, "GET", "/osc/macros");
  assert.equal(listed.macros.length, 1);

  const dryRun = await requestJson(context, "POST", "/osc/macros/soft-start-room/run", { dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.validation[0].ok, true);
  assert.equal(sends.length, 0);

  const run = await requestJson(context, "POST", "/osc/macros/soft-start-room/run", {});
  assert.equal(run.ok, true);
  assert.equal(run.results[0].targetId, "local:poland:main");
  assert.equal(sends.length, 1);
});

test("OSC macro routes resolve named parameters per target", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-osc-param-macros-"));
  const sends = [];
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-9:poland",
      label: "Poland 9",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/9",
      app: "poland",
      instance: "main",
      parameters: [{ name: "VolA", address: "/rnbo/inst/9/params/VolA" }]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({
    config: mergeConfig(defaultConfig, {
      osc: {
        macros: {
          path: path.join(tmp, "macros.json")
        }
      }
    }),
    runtime: {
      peerRegistry: registry,
      oscSender: async (send) => {
        sends.push(send);
      }
    }
  });

  const saved = await requestJson(context, "POST", "/osc/macros", {
    id: "trim-heron",
    label: "Trim Heron",
    steps: [{ target: "heron:poland:main", param: "VolA", args: [-6] }]
  });
  assert.equal(saved.macro.steps[0].param, "VolA");

  const dryRun = await requestJson(context, "POST", "/osc/macros/trim-heron/run", { dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.validation[0].address, "/rnbo/inst/9/params/VolA");
  assert.equal(sends.length, 0);

  const run = await requestJson(context, "POST", "/osc/macros/trim-heron/run", {});
  assert.equal(run.ok, true);
  assert.equal(run.results[0].address, "/rnbo/inst/9/params/VolA");
  assert.deepEqual(sends[0].args, [-6]);
});

test("OSC macro routes expand semantic transpose selectors across compatible apps", async () => {
  const sends = [];
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [
      {
        id: "rnbo-inst-4:quantizer",
        label: "Quantizer",
        host: "192.168.68.101",
        port: 1234,
        baseAddress: "/rnbo/inst/4",
        app: "quantizer",
        instance: "main",
        parameters: [
          { name: "TTID", address: "/rnbo/inst/4/params/TTID", meta: { editor: "ttid" } },
          { name: "ScalarTranspose", address: "/rnbo/inst/4/params/ScalarTranspose", min: -12, max: 12 }
        ]
      },
      {
        id: "rnbo-inst-5:analogsequencer",
        label: "Analog Sequencer",
        host: "192.168.68.101",
        port: 1234,
        baseAddress: "/rnbo/inst/5",
        app: "analogsequencer",
        instance: "main",
        parameters: [
          { name: "Scale", address: "/rnbo/inst/5/params/Scale", meta: { editor: "ttid" } },
          { name: "ScalarTranspose", address: "/rnbo/inst/5/params/ScalarTranspose", min: -7, max: 7 }
        ]
      }
    ]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({
    runtime: {
      peerRegistry: registry,
      oscSender: async (send) => sends.push(send)
    }
  });
  const macro = {
    id: "transpose-scalar",
    label: "Scalar Transpose",
    steps: [{
      where: { capability: "ttid-edit", status: "online", parameter: "ScalarTranspose" },
      param: "ScalarTranspose",
      args: [3]
    }]
  };

  const dryRun = await requestJson(context, "POST", "/osc/macros/run", { macro, dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.deepEqual(dryRun.validation.map((entry) => entry.target), [
    "heron:quantizer:main",
    "heron:analogsequencer:main"
  ]);
  assert.equal(sends.length, 0);

  const run = await requestJson(context, "POST", "/osc/macros/run", { macro });
  assert.equal(run.ok, true);
  assert.equal(run.results.length, 2);
  assert.deepEqual(sends.map((send) => send.args), [[3], [3]]);

  const invalid = await request(context, "POST", "/osc/macros/run", {
    macro: { ...macro, steps: [{ ...macro.steps[0], args: [9] }] }
  });
  assert.equal(invalid.status, 409);
  assert.match(invalid.body, /above 'ScalarTranspose' maximum 7/);
  assert.equal(sends.length, 2);
});

test("OSC Block State capture persists complete live target state to one editing block", async () => {
  const registry = createPeerRegistry(defaultConfig, { now: () => 1782580000000 });
  registry.register({
    id: "heron",
    advertisedName: "Heron",
    oscTargets: [{
      id: "rnbo-inst-4:quantizer",
      label: "Quantizer",
      host: "192.168.68.101",
      port: 1234,
      baseAddress: "/rnbo/inst/4",
      app: "quantizer",
      instance: "main",
      parameters: [
        { name: "TTID", address: "/rnbo/inst/4/params/TTID", meta: { editor: "ttid" } },
        { name: "ScalarTranspose", address: "/rnbo/inst/4/params/ScalarTranspose", min: -12, max: 12 },
        { name: "ChromaticTranspose", address: "/rnbo/inst/4/params/ChromaticTranspose", min: -24, max: 24 }
      ]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({
    runtime: {
      peerRegistry: registry,
      oscCaptureFetch: async () => jsonFetchResponse({
        CONTENTS: {
          TTID: { FULL_PATH: "/rnbo/inst/4/params/TTID", VALUE: 2741 },
          ScalarTranspose: { FULL_PATH: "/rnbo/inst/4/params/ScalarTranspose", VALUE: 3 },
          ChromaticTranspose: { FULL_PATH: "/rnbo/inst/4/params/ChromaticTranspose", VALUE: -2 }
        }
      })
    }
  });
  const initial = await requestJson(context, "GET", "/score");
  const blockId = initial.structureState.activeBlockId;
  const captured = await requestJson(context, "POST", "/osc/block-state/capture", {
    blockId,
    targets: ["heron:quantizer:main"],
    expectedStructureRevision: initial.structureRevision
  });

  assert.equal(captured.capturedCount, 1);
  assert.equal(captured.captures[0].targetId, "heron:quantizer:main");
  assert.deepEqual(captured.captures[0].clip.params, {
    ScalarTranspose: 3,
    ChromaticTranspose: -2
  });
  assert.equal(captured.captures[0].clip.params.TTID, undefined);
  assert.equal(captured.score.mesostructure[blockId].oscLayers[captured.captures[0].roleId].clipId, captured.captures[0].clipId);
});

function manualDevice(document) {
  return {
    id: document.id,
    name: document.name ?? "Studio Mac",
    host: document.host ?? "studio.local",
    oscQueryUrl: document.oscQueryUrl ?? "http://studio.local:5678/",
    oscPort: document.oscPort ?? 1234,
    status: "online",
    source: "manual",
    lastSeenAt: "2026-07-13T12:00:00.000Z",
    lastCheckedAt: "2026-07-13T12:00:00.000Z",
    lastError: "",
    instances: [{ id: "2", name: "Poland 2", app: "poland" }]
  };
}

test("clip routes reject stale expected score revisions", async () => {
  const context = createRouteContext();

  const score = await requestJson(context, "POST", "/clips/a-player-1", {
    expectedScoreRevision: 0,
    expectedStructureRevision: 0,
    notes: [{ pitch: 67 }]
  });
  assert.equal(score.scoreRevision, 1);

  const rejected = await request(context, "POST", "/clips/a-player-1", {
    expectedScoreRevision: 0,
    expectedStructureRevision: 0,
    notes: [{ pitch: 68 }]
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /stale score revision 0; current score revision is 1/);
  assert.match(rejected.body, /"currentVersion":1/);
});

test("voice note route rejects stale expected voice versions", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices/player-1/notes", {
    expectedVoiceVersion: 0,
    notes: [{ pitch: 60 }]
  });
  const response = await request(context, "POST", "/voices/player-1/notes", {
    expectedVoiceVersion: 0,
    notes: [{ pitch: 61 }]
  });

  assert.equal(response.status, 400);
  assert.match(response.body, /stale voice 'player-1' version 0; current version is 1/);
});

function jackSnapshot(options = {}) {
  const absoluteBeat = options.absoluteBeat ?? 31963.380208333332;
  return {
    source: "jack",
    host: "wren",
    state: options.state ?? "rolling",
    frame: 767223806,
    frameRate: 48000,
    bbtValid: options.bbtValid ?? true,
    bar: Math.floor(absoluteBeat / 4) + 1,
    beat: Math.floor(absoluteBeat % 4) + 1,
    tick: (absoluteBeat % 1) * 1920,
    beatsPerBar: 4,
    beatType: 4,
    ticksPerBeat: 1920,
    beatsPerMinute: options.beatsPerMinute ?? 120,
    absoluteBeat,
    observedAt: 1782580000000
  };
}

function captureControlTarget() {
  return {
    id: "rnbo-inst-2:listsequencer",
    localId: "rnbo-inst-2:listsequencer",
    label: "List Sequencer 2",
    host: "heron.local",
    port: 1234,
    baseAddress: "/rnbo/inst/2",
    app: "listsequencer",
    instance: "main",
    hardwareUnitId: "heron",
    deviceId: "heron",
    available: true,
    parameters: [
      { name: "Clock", address: "/rnbo/inst/2/params/Clock/Clock", type: "s", values: ["Off", "On"] },
      { name: "GateTime", address: "/rnbo/inst/2/params/GateTime" }
    ],
    inputPorts: [
      { name: "Steps", address: "/rnbo/inst/2/messages/in/Steps" },
      { name: "rtz", address: "/rnbo/inst/2/messages/in/rtz" }
    ]
  };
}

function clockParamsBody(value, params = {}, instanceId = 2) {
  return {
    CONTENTS: {
      Clock: {
        CONTENTS: {
          Clock: {
            FULL_PATH: `/rnbo/inst/${instanceId}/params/Clock/Clock`,
            VALUE: value
          }
        }
      },
      ...Object.fromEntries(Object.entries(params).map(([name, entry]) => [name, { VALUE: entry }]))
    }
  };
}

function jsonFetchResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function createRouteContext(options = {}) {
  const config = options.config ?? defaultConfig;
  const defaultScore = options.defaultScore ?? createInitialScore(config);
  const initialScore = options.initialScore ?? defaultScore;
  return {
    store: createScoreStore(initialScore, { defaultScore }),
    config,
    runtime: options.runtime ?? {}
  };
}

async function createOscClipLayer(context, blockId, roleId, clipId, clip) {
  await requestJson(context, "POST", "/osc/clips", { clipId, ...clip });
  return requestJson(context, "PUT", `/mesostructure/${encodeURIComponent(blockId)}/osc-layers/${encodeURIComponent(roleId)}`, { clipId });
}

async function requestJson(context, method, url, body) {
  const response = await request(context, method, url, body);
  assert.equal(response.headers["Content-Type"], "application/json");
  assert.ok(response.status >= 200 && response.status < 300, `${response.status} ${response.body}`);
  return JSON.parse(response.body);
}

async function request(context, method, url, body) {
  const request = createRequest(method, url, body);
  const response = createResponse();
  await routeRequest(request, response, context.store, context.config, context.runtime);
  return response.snapshot();
}

function createRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = { host: "127.0.0.1" };
  request.socket = { remoteAddress: "192.168.68.92" };
  return request;
}

function createResponse() {
  const headers = {};
  let status = 200;
  let body = "";

  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      Object.assign(headers, nextHeaders);
    },
    write(chunk) {
      body += chunk;
    },
    end(chunk = "") {
      body += chunk;
    },
    snapshot() {
      return { status, headers, body };
    }
  };
}
