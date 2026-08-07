import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeOscQueryService } from "../src/coordinator/bonjour-discovery.mjs";
import { createCoordinatorManager } from "../src/coordinator/coordinator-manager.mjs";
import { defaultConfig, mergeConfig } from "../src/config.mjs";

test("OSCQuery Bonjour services become stable tree candidates", () => {
  const candidate = normalizeOscQueryService({
    name: "rnbo:Birch",
    host: "birch.local.",
    port: 5678,
    addresses: ["fe80::1", "10.103.2.1"]
  }, 1786118400000);

  assert.deepEqual(candidate, {
    id: "birch",
    name: "birch",
    serviceName: "rnbo:Birch",
    host: "birch.local",
    address: "10.103.2.1",
    addresses: ["fe80::1", "10.103.2.1"],
    port: 5678,
    oscQueryUrl: "http://birch.local:5678",
    graphEditorUrl: "http://birch.local:3000",
    shadowscoreUrl: "http://birch.local:8790",
    observedAt: "2026-08-07T16:00:00.000Z",
    source: "bonjour-oscquery"
  });
});

test("coordinator selection persists and registers without restarting", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-coordinator-"));
  const registrations = [];
  const discovery = fakeDiscovery([tree("elm"), tree("maple")]);
  const config = mergeConfig(defaultConfig, {
    server: { hostIdentity: "maple", advertisedName: "Maple" },
    http: { publicUrl: "http://maple.local:8790" },
    coordinator: { statePath: path.join(directory, "coordinator.json") }
  });
  const manager = await createCoordinatorManager(config, {
    discovery,
    register: async (url, id) => registrations.push([url, id]),
    fetchImpl: healthFetch()
  });

  const selected = await manager.select({ mode: "remote", coordinatorId: "elm", coordinatorUrl: "http://elm.local:8790" });

  assert.equal(selected.selection.mode, "remote");
  assert.equal(selected.selection.coordinatorId, "elm");
  assert.deepEqual(registrations, [["http://elm.local:8790", "maple"]]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "coordinator.json"), "utf8")), selected.selection);
  manager.close();
});

test("claiming coordination moves every discovered ShadowScore tree", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-coordinator-claim-"));
  const writes = [];
  const config = mergeConfig(defaultConfig, {
    server: { hostIdentity: "elm", advertisedName: "Elm" },
    http: { publicUrl: "http://elm.local:8790" },
    coordinator: { statePath: path.join(directory, "coordinator.json") }
  });
  const manager = await createCoordinatorManager(config, {
    discovery: fakeDiscovery([tree("elm"), tree("birch"), tree("oak")]),
    register: async () => {},
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") writes.push([url, JSON.parse(options.body)]);
      return jsonResponse({ ok: true });
    }
  });

  const claimed = await manager.claim();

  assert.equal(claimed.selection.mode, "local");
  assert.deepEqual(claimed.results, [{ id: "birch", ok: true }, { id: "oak", ok: true }]);
  assert.deepEqual(writes, [
    ["http://birch.local:8790/coordinator/select", { mode: "remote", coordinatorId: "elm", coordinatorUrl: "http://elm.local:8790" }],
    ["http://oak.local:8790/coordinator/select", { mode: "remote", coordinatorId: "elm", coordinatorUrl: "http://elm.local:8790" }]
  ]);
  manager.close();
});

function tree(id) {
  return { id, name: id, host: `${id}.local`, shadowscoreUrl: `http://${id}.local:8790` };
}

function fakeDiscovery(candidates) {
  return {
    start() {}, refresh() {},
    snapshot() { return structuredClone(candidates); },
    close() {}
  };
}

function healthFetch() {
  return async () => jsonResponse({ ok: true });
}

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return structuredClone(body); } };
}
