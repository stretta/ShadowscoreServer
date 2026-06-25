import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { routeRequest } from "../src/http/routes.mjs";
import { createPeerRegistry } from "../src/registration/peer-registry.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

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
});

test("session route exposes host metadata and voice assignments", async () => {
  const context = createRouteContext();
  const session = await requestJson(context, "GET", "/session");

  assert.equal(session.ensembleId, "berklee-b51");
  assert.equal(session.server.role, "host");
  assert.equal(session.endpoints.collab, "ws://127.0.0.1/collab");
  assert.equal(session.endpoints.eventList, "http://127.0.0.1/event-list");
  assert.equal(session.voices.length, 6);
  assert.equal(session.voices[0].assignment.label, "Player 1");
  assert.equal(session.assignmentPresets[0].id, "six-player-shadowbox");
  assert.equal(session.hardwareUnits.length, 1);
  assert.equal(session.hardwareUnits[0].local, true);
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
  assert.equal(targets.targets.some((target) => target.id === "shadowbox-b:b-source"), true);
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
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    }
  ]);
  assert.equal(context.config.rnbo.transport.MaxSteps, 64);
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
  assert.match(response.body, /\/rnbo\/targets\/\$\{encodeURIComponent\(targetId\)\}\/params/);
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

test("root route remains a matrix edit compatibility alias", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Matrix Edit/);
});

test("event list route serves server-bundled editor html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/event-list");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /ShadowScore Event List/);
  assert.match(response.body, /id="server-select"/);
  assert.match(response.body, /id="discover"/);
  assert.match(response.body, /pt5\.local:8790/);
  assert.match(response.body, /\/session/);
  assert.match(response.body, /id="ableton-notes"/);
  assert.match(response.body, /id="replace-array"/);
  assert.match(response.body, /id="add-array"/);
  assert.match(response.body, /id="rnbo-target"/);
  assert.match(response.body, /id="tempo"/);
  assert.match(response.body, /id="max-steps"/);
  assert.match(response.body, /id="clock-interval"/);
  assert.match(response.body, /id="start-transport"/);
  assert.match(response.body, /id="stop-transport"/);
  assert.match(response.body, /\/rnbo\/targets\/\$\{encodeURIComponent\(targetId\)\}\/params/);
  assert.match(response.body, /POST/);
  assert.match(response.body, /\/voices\/\$\{encodeURIComponent\(state\.voiceId\)\}\/notes/);
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
