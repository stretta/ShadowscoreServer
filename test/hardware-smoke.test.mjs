import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { evaluateChecks, runHardwareSmoke } from "../bin/hardware-smoke.mjs";

test("hardware smoke passes required host checks and skips host-only registration", async () => {
  const result = await runHardwareSmoke(defaultConfig, {
    fetchImpl: createFetch({
      "http://127.0.0.1:8790/healthz": { ok: true },
      "http://127.0.0.1:8790/session": { voices: [{ id: "player-1" }] },
      "http://127.0.0.1:8790/rnbo/targets": { targets: [] },
      "http://127.0.0.1:8790/rnbo/devices": { devices: [] },
      "http://127.0.0.1:8790/coordinator": coordinatorPayload(),
      "http://127.0.0.1:8790/": "ShadowScore Views",
      "http://127.0.0.1:8790/structure-editor": "ShadowScore Arrange",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/piano-roll": "ShadowScore Piano Roll",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List"
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "skip");
  assert.equal(result.checks.find((check) => check.name === "JACK transport").status, "skip");
});

test("hardware smoke requires fresh JACK transport when enabled", async () => {
  const config = mergeConfig(defaultConfig, {
    transport: {
      jack: {
        enabled: true
      }
    }
  });
  const result = await runHardwareSmoke(config, {
    fetchImpl: createFetch({
      "http://127.0.0.1:8790/healthz": { ok: true },
      "http://127.0.0.1:8790/session": { voices: [{ id: "player-1" }] },
      "http://127.0.0.1:8790/rnbo/targets": { targets: [] },
      "http://127.0.0.1:8790/rnbo/devices": { devices: [] },
      "http://127.0.0.1:8790/coordinator": coordinatorPayload(),
      "http://127.0.0.1:8790/": "ShadowScore Views",
      "http://127.0.0.1:8790/structure-editor": "ShadowScore Arrange",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/piano-roll": "ShadowScore Piano Roll",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List",
      "http://127.0.0.1:8790/transport": {
        fresh: true,
        latest: {
          bbtValid: true,
          state: "rolling"
        }
      }
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "JACK transport").status, "pass");
});

test("hardware smoke fails stale JACK transport when enabled", async () => {
  const config = mergeConfig(defaultConfig, {
    transport: {
      jack: {
        enabled: true
      }
    }
  });
  const result = await runHardwareSmoke(config, {
    fetchImpl: createFetch({
      "http://127.0.0.1:8790/healthz": { ok: true },
      "http://127.0.0.1:8790/session": { voices: [{ id: "player-1" }] },
      "http://127.0.0.1:8790/rnbo/targets": { targets: [] },
      "http://127.0.0.1:8790/rnbo/devices": { devices: [] },
      "http://127.0.0.1:8790/coordinator": coordinatorPayload(),
      "http://127.0.0.1:8790/": "ShadowScore Views",
      "http://127.0.0.1:8790/structure-editor": "ShadowScore Arrange",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/piano-roll": "ShadowScore Piano Roll",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List",
      "http://127.0.0.1:8790/transport": {
        fresh: false,
        status: "stale",
        reason: "snapshot stale",
        latest: {
          bbtValid: true,
          state: "rolling"
        }
      }
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "JACK transport").status, "fail");
});

test("hardware smoke fails when peer is not visible on the session host", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      role: "peer",
      hostIdentity: "shadowbox-b"
    },
    registration: {
      sessionHostUrl: "http://shadowbox-host.local:8790",
      discovery: { enabled: false }
    }
  });
  const result = await runHardwareSmoke(config, {
    fetchImpl: createFetch({
      "http://127.0.0.1:8790/healthz": { ok: true },
      "http://127.0.0.1:8790/session": { voices: [{ id: "player-1" }] },
      "http://127.0.0.1:8790/rnbo/targets": { targets: [] },
      "http://127.0.0.1:8790/rnbo/devices": { devices: [] },
      "http://127.0.0.1:8790/": "ShadowScore Views",
      "http://127.0.0.1:8790/structure-editor": "ShadowScore Arrange",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/piano-roll": "ShadowScore Piano Roll",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List",
      "http://shadowbox-host.local:8790/hardware/units": { hardwareUnits: [] }
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "fail");
});

test("peer hardware smoke skips host-only web checks", async () => {
  const config = mergeConfig(defaultConfig, {
    server: { role: "peer", hostIdentity: "finch" },
    registration: { sessionHostUrl: "http://wren.local:8790", discovery: { enabled: false } },
    rnbo: { oscQuery: { enabled: true, url: "http://127.0.0.1:5678" } }
  });
  const result = await runHardwareSmoke(config, {
    fetchImpl: createFetch({
      "http://127.0.0.1:5678": { CONTENTS: { rnbo: {} } },
      "http://wren.local:8790/hardware/units": { hardwareUnits: [{ id: "finch" }] }
    }),
    timeoutMs: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "healthz").status, "skip");
  assert.equal(result.checks.find((check) => check.name === "coordinator").status, "skip");
  assert.equal(result.checks.find((check) => check.name === "http port").status, "skip");
  assert.equal(result.checks.find((check) => check.name === "RNBOOSCQuery").status, "pass");
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "pass");
});

test("peer hardware smoke verifies registration through discovered authority", async () => {
  const config = mergeConfig(defaultConfig, {
    server: { role: "peer", hostIdentity: "finch" },
    registration: { sessionHostUrl: "", discovery: { enabled: true, timeoutMs: 0 } },
    rnbo: { oscQuery: { enabled: true, url: "http://127.0.0.1:5678" } }
  });
  const result = await runHardwareSmoke(config, {
    discovery: fakeDiscovery([{
      id: "wren",
      address: "192.168.68.99",
      shadowscoreUrl: "http://wren.local:8790"
    }]),
    fetchImpl: createFetch({
      "http://127.0.0.1:5678": { CONTENTS: { rnbo: {} } },
      "http://192.168.68.99:8790/coordinator": {
        local: { id: "wren" },
        selection: { mode: "local", coordinatorId: "wren" }
      },
      "http://192.168.68.99:8790/hardware/units": { hardwareUnits: [{ id: "finch" }] }
    }),
    timeoutMs: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "pass");
});

test("evaluateChecks reports failed check names", () => {
  assert.deepEqual(evaluateChecks([
    { name: "healthz", status: "pass" },
    { name: "RNBOOSCQuery", status: "skip" },
    { name: "session", status: "fail" }
  ]), {
    ok: false,
    failed: ["session"]
  });
});

function createFetch(payloads) {
  return async (url) => {
    const payload = payloads[url];
    if (payload === undefined) {
      return {
        ok: false,
        status: 404,
        async json() {
          return {};
        },
        async text() {
          return "";
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
      async text() {
        return String(payload);
      }
    };
  };
}

function fakeDiscovery(candidates) {
  return {
    start() {},
    refresh() {},
    snapshot() { return structuredClone(candidates); },
    close() {}
  };
}

function coordinatorPayload() {
  return {
    local: { id: "wren", name: "wren", url: "http://wren.local:8790" },
    selection: { mode: "local", coordinatorId: "wren", coordinatorUrl: "http://wren.local:8790" },
    candidates: []
  };
}

function createNetConnect() {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
}
