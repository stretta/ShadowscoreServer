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
      "http://127.0.0.1:8790/": "ShadowScore Structure Editor",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List"
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "skip");
});

test("hardware smoke fails when peer is not visible on the session host", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      role: "peer",
      hostIdentity: "shadowbox-b"
    },
    registration: {
      sessionHostUrl: "http://shadowbox-host.local:8790"
    }
  });
  const result = await runHardwareSmoke(config, {
    fetchImpl: createFetch({
      "http://127.0.0.1:8790/healthz": { ok: true },
      "http://127.0.0.1:8790/session": { voices: [{ id: "player-1" }] },
      "http://127.0.0.1:8790/rnbo/targets": { targets: [] },
      "http://127.0.0.1:8790/": "ShadowScore Structure Editor",
      "http://127.0.0.1:8790/matrix-edit": "ShadowScore Matrix Edit",
      "http://127.0.0.1:8790/event-list": "ShadowScore Event List",
      "http://shadowbox-host.local:8790/hardware/units": { hardwareUnits: [] }
    }),
    netConnect: createNetConnect(),
    timeoutMs: 20
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "peer registration").status, "fail");
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

function createNetConnect() {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
}
