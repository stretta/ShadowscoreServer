import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { routeRequest } from "../src/http/routes.mjs";
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
  assert.match(response.body, /Session link/);
  assert.match(response.body, /Download backup/);
  assert.match(response.body, /Saved scores/);
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
  assert.match(response.body, /voice\.assignment\.reconciled/);
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

test("transport status page exposes host transport controls", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/transport/status");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Shadowscore Transport/);
  assert.match(response.body, /id="start-jack"/);
  assert.match(response.body, /id="start-timer"/);
  assert.match(response.body, /id="reanchor"/);
  assert.match(response.body, /id="advance"/);
  assert.match(response.body, /id="reset"/);
  assert.match(response.body, /id="stop"/);
  assert.match(response.body, /id="composition-beat"/);
  assert.match(response.body, /id="beat-into-block"/);
  assert.match(response.body, /id="macro-anchor"/);
  assert.match(response.body, /id="phase-reset"/);
  assert.match(response.body, /id="timing-contracts"/);
  assert.match(response.body, /renderContracts\(contracts\.contracts \|\| \[\]\)/);
  assert.match(response.body, /Disagrees on/);
  assert.match(response.body, /\/transport\/events/);
  assert.match(response.body, /\/transport\/play/);
  assert.match(response.body, /\/transport\/stop/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /\/playback\/timing-contracts/);
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

  const rejected = await request(context, "POST", "/structure/playhead", {
    activeBlockId: "missing"
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /unknown mesostructural block 'missing'/);
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
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    }
  ]);
  assert.deepEqual(started.clockWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock",
      targetId: "source-client",
      value: 1
    }
  ]);
  assert.deepEqual(started.phaseWrites, []);

  const stopped = await requestJson(context, "POST", "/macrostructure/playback/stop", {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.playback.running, false);
  assert.deepEqual(writes.at(-1), {
    host: "192.168.68.96",
    port: 9000,
    path: "/rnbo/inst/2/params/Clock",
    value: 0
  });
  assert.deepEqual(stopped.clockWrites, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock",
      targetId: "source-client",
      value: 0
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
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    }
  ]);
  assert.equal(started.clockWrites.length, 1);
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
    path: "/rnbo/inst/2/params/Clock",
    value: 0
  });
  assert.deepEqual(jackCalls, [["start"], ["tempo", 120], ["stop"]]);
});

test("macrostructure tempo save sends JACK tempo when control is available", async () => {
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

  const score = await requestJson(context, "POST", "/macrostructure", {
    tempo: 137.25,
    blocks: ["A"]
  });

  assert.equal(score.macrostructure.tempo, 137.25);
  assert.deepEqual(jackCalls, [["tempo", 137.25]]);
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
    skewBeats: 0,
    targetCount: 1,
    reason: "RNBO current_stage readback"
  });
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
    mode: "jack",
    phaseReset: true
  });

  assert.equal(started.ok, true);
  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
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
      path: "/rnbo/inst/3/params/Clock",
      value: 1
    }
  ]);
  assert.deepEqual(started.clockWrites, [
    {
      host: "192.168.68.97",
      port: 9001,
      path: "/rnbo/inst/3/params/Clock",
      targetId: "other-client",
      value: 1
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
  const backup = await request(context, "GET", "/admin/backup");

  assert.equal(backup.status, 200);
  assert.match(backup.headers["Content-Disposition"], /shadowscore-berklee-b51/);
  const snapshot = JSON.parse(backup.body);
  snapshot.voices["player-1"].notes = [{ pitch: 72 }];

  const restored = await requestJson(context, "POST", "/admin/restore", snapshot);
  assert.deepEqual(restored.voices["player-1"].notes, [{ pitch: 72 }]);
  assert.equal(restored.ensembleId, "berklee-b51");
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
  assert.equal(target.capabilities.maxStages, 1024);
  assert.equal(target.capabilities.maxNoteRows, 512);
  assert.deepEqual(targets.sendQueue, {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  });
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
  assert.equal(contract.transmittedRowCount, 819);
  assert.equal(contract.replacementMode, "legacy-full-clear");
  assert.equal(contract.compactScoreReplace, false);
  assert.equal(contract.targetCapabilities.compactScoreReplace, false);
  assert.equal(contract.targetCapabilities.supportsBeginReplaceClear, false);
  assert.equal(contract.targetCapabilities.activeRowCountCommit, false);
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
    targets: [{ id: "b-source", host: "192.168.68.71", port: 9000, address: "/rnbo/inst/2/messages/in/shadowscore" }]
  });

  currentTime = 7000;
  const session = await requestJson(context, "GET", "/session");
  const peer = session.hardwareUnits.find((unit) => unit.id === "shadowbox-b");
  const target = session.rnbo.targets.find((entry) => entry.id === "shadowbox-b:b-source");

  assert.equal(peer.status, "offline");
  assert.equal(peer.available, false);
  assert.equal(target.available, false);
  assert.equal(session.assignments["player-1"].rnboTargetId, "shadowbox-b:b-source");
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
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    }
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 32);
  assert.equal(context.config.rnbo.transport.Clock, undefined);
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
    "/rnbo/inst/2/params/Clock"
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
      path: "/rnbo/inst/2/params/Clock",
      value: 1
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
    ["/rnbo/inst/2/params/Clock", 1]
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

test("root route serves view index", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Views/);
  assert.match(response.body, /\/editors/);
  assert.match(response.body, /Instrument Editors/);
  assert.match(response.body, /\/structure-editor/);
  assert.match(response.body, /\/matrix-edit/);
  assert.match(response.body, /\/event-list/);
  assert.match(response.body, /\/admin/);
  assert.match(response.body, /\/transport\/status/);
  assert.match(response.body, /\/rnbo\/devices/);
  assert.match(response.body, /:3000/);
});

test("editor manifest route lists registered instrument editors", async () => {
  const context = createRouteContext();
  const response = await requestJson(context, "GET", "/editors/manifest");

  assert.equal(response.editors.length, 4);
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
      label: "TTID",
      route: "/editors/ttid",
      targetFilter: {
        app: "ttid"
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
      id: "listsequencer",
      label: "ListSequencer",
      route: "/editors/listsequencer",
      targetFilter: {
        app: "listsequencer"
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
  assert.match(response.body, /ShadowScore Editors/);
  assert.match(response.body, /\/editors\/manifest/);
  assert.match(response.body, /\/osc\/targets/);
  assert.match(response.body, /filterText/);
});

test("event list route serves server-bundled editor html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/event-list");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Event List/);
  assert.match(response.body, /id="clip"/);
  assert.match(response.body, /id="new-clip"/);
  assert.match(response.body, /id="rename-clip"/);
  assert.match(response.body, /id="delete-clip"/);
  assert.match(response.body, /id="clip-playback-type"/);
  assert.match(response.body, /id="clip-time-numerator"/);
  assert.match(response.body, /id="clip-time-denominator"/);
  assert.match(response.body, /TimeSignature/);
  assert.match(response.body, /id="save-clip-attributes"/);
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
  assert.match(response.body, /ShadowScore Structure Editor/);
  assert.match(response.body, /Block Assignments/);
  assert.match(response.body, /Assigned Clip/);
  assert.match(response.body, /Duplicate Block/);
  assert.match(response.body, /Song Form/);
  assert.match(response.body, /Cue Section/);
  assert.match(response.body, /id="block-list"/);
  assert.match(response.body, /id="players"/);
  assert.match(response.body, /id="duplicate-block"/);
  assert.match(response.body, /id="chain"/);
  assert.match(response.body, /id="active-block"/);
  assert.match(response.body, /id="set-active-block"/);
  assert.match(response.body, /id="advance-block"/);
  assert.match(response.body, /id="reset-block"/);
  assert.match(response.body, /id="start-macro"/);
  assert.match(response.body, /id="stop-macro"/);
  assert.match(response.body, /id="macro-playback-status"/);
  assert.match(response.body, /id="macro-playback-state"/);
  assert.match(response.body, /id="macro-playback-detail"/);
  assert.match(response.body, /repeat\(auto-fit, minmax\(110px, 1fr\)\)/);
  assert.match(response.body, /\.panel-body > \* \{\s+min-width: 0;/);
  assert.match(response.body, /formatRemaining/);
  assert.match(response.body, /Create new clip/);
  assert.match(response.body, /persistMacrostructure\("Updating playback chain/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(sourceBlockId\)\}\/duplicate/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(nextId\)\}/);
  assert.match(response.body, /\/clips\/\$\{encodeURIComponent\(clipId\)\}/);
  assert.match(response.body, /\/macrostructure/);
  assert.match(response.body, /\/structure\/playhead/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /\/macrostructure\/playback\/start/);
  assert.match(response.body, /\/macrostructure\/playback\/stop/);
  assert.match(response.body, /createShadowScoreClientState/);
  assert.match(response.body, /blockDraftKey/);
  assert.match(response.body, /withExpectedStructureRevision/);
  assert.match(response.body, /expectedStructureRevision/);
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
  assert.match(response.body, /Oscillator A/);
  assert.match(response.body, /data-group="oscillator-a"/);
  assert.match(response.body, /VolA/);
  assert.match(response.body, /FilterKeyTracking/);
});

test("TTID editor route serves the OSC target integration page", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/editors/ttid");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /TTID Editor/);
  assert.match(response.body, /\/osc\/targets\?app=ttid/);
  assert.match(response.body, /editor: ttid/);
  assert.match(response.body, /SCALES/);
  assert.match(response.body, /ionian/);
  assert.match(response.body, /formatMask/);
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
  assert.match(response.body, /plate-choice/);
  assert.match(response.body, /scheduleParamSend/);
  assert.match(response.body, /flushParamSend/);
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
});

test("shared client state module is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/shadowscore-client-state.js");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/javascript/);
  assert.match(response.body, /createShadowScoreClientState/);
  assert.match(response.body, /effectiveScore/);
});

test("shared ShadowScore stylesheet is served as a static asset", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/shared/shadowscore-style.css");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/css/);
  assert.match(response.body, /--ss-bg/);
  assert.match(response.body, /ss-route-tabs/);
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
        address: "/rnbo/inst/10/params/VolA",
        value: 0.5,
        min: 0,
        max: 1
      }]
    }]
  }, { remoteAddress: "192.168.68.101" });
  const context = createRouteContext({ runtime: { peerRegistry: registry } });

  const response = await requestJson(context, "GET", "/osc/targets?app=poland");

  assert.equal(response.targets.length, 1);
  assert.equal(response.targets[0].id, "heron:poland:main");
  assert.equal(response.targets[0].status, "online");
  assert.equal(response.targets[0].parameters[0].address, "/rnbo/inst/10/params/VolA");
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
    beatsPerMinute: 120,
    absoluteBeat,
    observedAt: 1782580000000
  };
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
