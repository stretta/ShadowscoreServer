import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { createManualOscQueryDeviceRegistry } from "../src/oscquery/manual-device-registry.mjs";

test("manual OSCQuery devices are probed, persisted, and exposed as editor targets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-oscquery-devices-"));
  const config = mergeConfig(defaultConfig, {
    oscQuery: {
      manualDevicesPath: path.join(directory, "devices.json"),
      refreshIntervalMs: 60000
    }
  });
  const requests = [];
  const registry = createManualOscQueryDeviceRegistry(config, {
    now: () => 1782580000000,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return jsonResponse(polandTree());
    }
  });

  const saved = await registry.save({
    name: "Studio Mac",
    host: "studio.local",
    oscPort: 9001
  });

  assert.equal(saved.id, "studio-mac");
  assert.equal(saved.oscQueryUrl, "http://studio.local:5678/");
  assert.equal(saved.oscPort, 9001);
  assert.equal(saved.status, "online");
  assert.equal(saved.instances.length, 1);
  assert.deepEqual(requests, ["http://studio.local:5678/"]);

  const targets = await registry.oscTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "studio-mac:rnbo-inst-2:poland");
  assert.equal(targets[0].hardwareUnitId, "studio-mac");
  assert.equal(targets[0].host, "studio.local");
  assert.equal(targets[0].port, 9001);
  assert.equal(targets[0].app, "poland");
  assert.equal(targets[0].parameters[0].address, "/rnbo/inst/2/params/VolA");

  const persisted = JSON.parse(await fs.readFile(path.join(directory, "devices.json"), "utf8"));
  assert.deepEqual(persisted.devices.map((device) => device.id), ["studio-mac"]);
  assert.equal(persisted.devices[0].oscQueryUrl, "http://studio.local:5678/");

  const updated = await registry.update("studio-mac", { name: "Studio Rack", oscPort: 1234 });
  assert.equal(updated.id, "studio-mac");
  assert.equal(updated.name, "Studio Rack");
  assert.equal(updated.oscPort, 1234);

  const removed = await registry.remove("studio-mac");
  assert.equal(removed.id, "studio-mac");
  assert.deepEqual(await registry.list(), []);
});

test("manual OSCQuery devices retain known instances and report offline after refresh failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-oscquery-offline-"));
  const config = mergeConfig(defaultConfig, {
    oscQuery: { manualDevicesPath: path.join(directory, "devices.json"), refreshIntervalMs: 250 }
  });
  let fail = false;
  let timestamp = 1782580000000;
  const registry = createManualOscQueryDeviceRegistry(config, {
    now: () => timestamp,
    fetchImpl: async () => {
      if (fail) throw new Error("connection refused");
      return jsonResponse(polandTree());
    }
  });
  await registry.save({ host: "192.168.1.50" });

  fail = true;
  timestamp += 1000;
  const device = await registry.refresh("192-168-1-50");
  assert.equal(device.status, "offline");
  assert.match(device.lastError, /connection refused/);
  assert.equal(device.instances.length, 1);
  const targets = await registry.oscTargets();
  assert.equal(targets[0].available, false);
});

function polandTree() {
  return {
    CONTENTS: {
      rnbo: {
        CONTENTS: {
          info: { CONTENTS: { version: { VALUE: "1.4.4" }, runner_version: { VALUE: "1.4.4-9" } } },
          inst: {
            CONTENTS: {
              "2": {
                CONTENTS: {
                  params: {
                    CONTENTS: {
                      VolA: rnboParam("VolA", 0.5, 0),
                      VolB: rnboParam("VolB", 0.6, 1),
                      WaveA: rnboParam("WaveA", 1, 2),
                      WaveB: rnboParam("WaveB", 2, 3)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

function rnboParam(name, value, index) {
  return {
    FULL_PATH: `/rnbo/inst/2/params/${name}`,
    TYPE: "f",
    VALUE: value,
    RANGE: [{ MIN: 0, MAX: 127 }],
    CONTENTS: { index: { VALUE: index } }
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return structuredClone(body); } };
}
