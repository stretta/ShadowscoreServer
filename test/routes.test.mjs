import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { routeRequest } from "../src/http/routes.mjs";
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

test("admin reset route clears requested score sections", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);
  await requestJson(context, "POST", "/voices/player-1/assignment", { assignee: "Ari" });

  const reset = await requestJson(context, "POST", "/admin/reset", {
    voices: true,
    assignments: true
  });

  assert.deepEqual(reset.voices["player-1"].notes, []);
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
  assert.match(response.body, /Import voice notes to clips/);
  assert.match(response.body, /\/admin\/import-legacy-voice-notes/);
});

test("session route exposes host metadata and voice assignments", async () => {
  const context = createRouteContext();
  const session = await requestJson(context, "GET", "/session");

  assert.equal(session.ensembleId, "berklee-b51");
  assert.equal(session.server.role, "host");
  assert.equal(session.endpoints.app, "http://127.0.0.1/");
  assert.equal(session.endpoints.collab, "ws://127.0.0.1/collab");
  assert.equal(session.endpoints.eventList, "http://127.0.0.1/event-list");
  assert.equal(session.endpoints.structureEditor, "http://127.0.0.1/");
  assert.equal(session.endpoints.structure, "http://127.0.0.1/structure");
  assert.equal(session.endpoints.structurePlayhead, "http://127.0.0.1/structure/playhead");
  assert.equal(session.endpoints.macroPlayback, "http://127.0.0.1/macrostructure/playback");
  assert.equal(session.endpoints.playbackTimingContracts, "http://127.0.0.1/playback/timing-contracts");
  assert.equal(session.endpoints.transport, "http://127.0.0.1/transport");
  assert.equal(session.endpoints.transportEvents, "http://127.0.0.1/transport/events");
  assert.equal(session.endpoints.transportStatus, "http://127.0.0.1/transport/status");
  assert.equal(session.macroPlayback.running, false);
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
  assert.match(response.body, /id="phase-reset"/);
  assert.match(response.body, /\/transport\/events/);
  assert.match(response.body, /\/macrostructure\/playback\/start/);
  assert.match(response.body, /\/macrostructure\/playback\/stop/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /\/playback\/timing-contracts/);
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

  const chained = await requestJson(context, "POST", "/macrostructure", {
    expectedVersion: added.version,
    blocks: ["A", "G", "B"]
  });
  assert.deepEqual(chained.macrostructure.blocks, ["A", "G", "B"]);
  assert.equal(chained.macrostructure.expectedVersion, undefined);

  const removed = await requestJson(context, "DELETE", "/mesostructure/G");
  assert.equal(removed.mesostructure.G, undefined);
  assert.deepEqual(removed.macrostructure.blocks, ["A", "B"]);
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
  assert.deepEqual(result.contracts[0], {
    targetId: "source-client",
    targetType: "rnbo",
    contractTransport: "rnbo-osc",
    available: true,
    assignedVoiceId: "player-1",
    timing: {
      blockId: "A",
      stagesPerBeat: 240,
      ticksPerStage: 2,
      patternLength: 960,
      maxStages: 1024,
      maxNoteRows: 819,
      resolutionMode: "fit",
      quantizationError: null
    },
    noteCount: 4,
    transmittedRowCount: 64
  });
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

test("RNBO target param route writes playback transport controls", async () => {
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

test("RNBO target param route derives MaxSteps for assigned targets and starts clock last", async () => {
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

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/params", {
    params: {
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
      value: 120
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    }
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 64);
  assert.equal(context.config.rnbo.transport.ClockInterval, 120);
});

test("RNBO target param route derives adaptive ClockInterval for assigned targets", async () => {
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

  const result = await requestJson(context, "POST", "/rnbo/targets/source-client/params", {
    params: {
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

test("RNBO target param route rejects unsupported params", async () => {
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

  const response = await request(context, "POST", "/rnbo/targets/source-client/params", {
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
  assert.match(response.body, /\/macrostructure\/playback\/\$\{running \? "start" : "stop"\}/);
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

test("root route serves structure editor", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Structure Editor/);
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
});

test("structure editor route serves server-bundled editor html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/structure-editor");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Structure Editor/);
  assert.match(response.body, /id="block-list"/);
  assert.match(response.body, /id="players"/);
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
  assert.match(response.body, /formatRemaining/);
  assert.match(response.body, /Create new clip/);
  assert.match(response.body, /\/mesostructure\/\$\{encodeURIComponent\(nextId\)\}/);
  assert.match(response.body, /\/clips\/\$\{encodeURIComponent\(clipId\)\}/);
  assert.match(response.body, /\/macrostructure/);
  assert.match(response.body, /\/structure\/playhead/);
  assert.match(response.body, /\/macrostructure\/advance/);
  assert.match(response.body, /\/macrostructure\/reset/);
  assert.match(response.body, /\/macrostructure\/playback\/start/);
  assert.match(response.body, /\/macrostructure\/playback\/stop/);
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

function jackSnapshot() {
  return {
    source: "jack",
    host: "wren",
    state: "rolling",
    frame: 767223806,
    frameRate: 48000,
    bbtValid: true,
    bar: 7991,
    beat: 4,
    tick: 730,
    beatsPerBar: 4,
    beatType: 4,
    ticksPerBeat: 1920,
    beatsPerMinute: 120,
    absoluteBeat: 31963.380208333332,
    observedAt: 1782580000000
  };
}

function createRouteContext(options = {}) {
  const config = options.config ?? defaultConfig;
  return {
    store: createScoreStore(createInitialScore(config)),
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
