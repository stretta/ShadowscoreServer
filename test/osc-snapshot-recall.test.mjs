import assert from "node:assert/strict";
import test from "node:test";

import {
  compileOscSnapshot,
  createOscSnapshotRecallService,
  dispatchOscBlockRecall
} from "../src/osc/snapshot-recall.mjs";

test("snapshot compiler orders params, lists, late state, and Clock while reporting unsupported controls", () => {
  const compiled = compileOscSnapshot({
    app: "listsequencer",
    params: { Clock: 1, GateTime: 0.4, FutureMode: 1, Tail: 0.8 },
    inputPorts: { Steps: [1, 0, 1, 0], rtz: [1] }
  }, oscTarget({
    parameters: [
      param("Clock"),
      param("GateTime"),
      param("Tail", { snapshot_order: "late" })
    ],
    inputPorts: [inport("Steps"), inport("rtz")]
  }), { blockId: "A", roleId: "list-a", targetId: "heron:listsequencer:main" });

  assert.deepEqual(compiled.writes.map((write) => [write.group, write.name]), [
    ["params", "GateTime"],
    ["inputPorts", "Steps"],
    ["late", "Tail"],
    ["clock", "Clock"]
  ]);
  assert.deepEqual(compiled.missingControls, [{ kind: "param", name: "FutureMode", reason: "missing-live-control" }]);
  assert.deepEqual(compiled.excludedControls, [{ kind: "inputPort", name: "rtz", reason: "momentary-control" }]);
  assert.equal(compiled.writes.every((write) => Number.isInteger(write.packetBytes) && write.packetBytes > 0), true);
  assert.equal(compiled.writes.find((write) => write.name === "Steps").packetBytes > compiled.writes.find((write) => write.name === "Clock").packetBytes, true);
});

test("snapshot compiler translates numeric enum indexes to live OSCQuery string values", () => {
  const compiled = compileOscSnapshot({
    app: "analogsequencer",
    params: { ClockRate: 2, Mode: 1, Invalid: 9 }
  }, oscTarget({
    app: "analogsequencer",
    parameters: [
      { ...param("ClockRate"), type: "s", values: ["4n", "8nd", "8n", "16n"] },
      { ...param("Mode"), type: "s", values: ["Forward", "Backward", "Palindrome"] },
      { ...param("Invalid"), type: "s", values: ["Off", "On"] }
    ]
  }));

  assert.deepEqual(compiled.writes.map((write) => [write.name, write.args]), [
    ["ClockRate", ["8n"]],
    ["Mode", ["Backward"]]
  ]);
  assert.deepEqual(compiled.missingControls, [{
    kind: "param", name: "Invalid", reason: "invalid-enum-index", value: 9, choiceCount: 2
  }]);
});

test("recall telemetry measures encoded payloads and the dispatch window", async () => {
  const score = scoreWithRoles({
    online: snapshot("listsequencer", { GateTime: 0.4, Clock: 1 }, { Steps: [1, 0, 1, 0] })
  }, {
    online: assignment("listsequencer", "heron", "heron:listsequencer:main")
  });
  const targets = [oscTarget({
    parameters: [param("GateTime"), param("Clock")],
    inputPorts: [inport("Steps")]
  })];
  let now = 1000;
  const result = await dispatchOscBlockRecall(score, "A", targets, {
    now: () => now,
    sender: async () => { now += 4; }
  });

  assert.equal(result.plannedWriteCount, 3);
  assert.equal(result.plannedPacketBytes, result.attemptedPacketBytes);
  assert.equal(result.attemptedPacketBytes, result.succeededPacketBytes);
  assert.equal(result.failedPacketBytes, 0);
  assert.equal(result.dispatchDurationMs, 12);
  assert.deepEqual(result.roles[0].writes.map((write) => [write.startedOffsetMs, write.completedOffsetMs, write.durationMs]), [
    [0, 4, 4],
    [4, 8, 4],
    [8, 12, 4]
  ]);

  const dryRun = await dispatchOscBlockRecall(score, "A", targets, { dryRun: true, now: () => 2000 });
  assert.equal(dryRun.plannedPacketBytes, result.plannedPacketBytes);
  assert.equal(dryRun.attemptedPacketBytes, 0);
  assert.equal(dryRun.dispatchDurationMs, 0);
});

test("dispatcher runs target groups concurrently and preserves all ordering within one instance", async () => {
  const score = scoreWithRoles({
    "role-a": snapshot("listsequencer", { AValue: 1, Clock: 1 }),
    "role-b": snapshot("listsequencer", { BValue: 2, Clock: 0 }),
    "role-c": snapshot("plate", { Decay: 0.5 })
  }, {
    "role-a": assignment("listsequencer", "heron", "heron:listsequencer:main"),
    "role-b": assignment("listsequencer", "heron", "heron:listsequencer:main"),
    "role-c": assignment("plate", "raven", "raven:plate:main")
  });
  const targets = [
    oscTarget({
      id: "heron:listsequencer:main",
      deviceId: "heron",
      parameters: [param("AValue"), param("BValue"), param("Clock")]
    }),
    oscTarget({
      id: "raven:plate:main",
      deviceId: "raven",
      app: "plate",
      capabilities: ["osc", "plate-edit"],
      parameters: [param("Decay")]
    })
  ];
  const starts = [];
  let release;
  const firstPair = new Promise((resolve) => { release = resolve; });
  const sender = async (write) => {
    starts.push(`${write.targetId}:${write.address}`);
    if (starts.length === 2) release();
    await firstPair;
  };

  const result = await dispatchOscBlockRecall(score, "A", targets, { sender });

  assert.equal(result.ok, true);
  assert.equal(starts[0].startsWith("heron:listsequencer:main:"), true);
  assert.equal(starts[1].startsWith("raven:plate:main:"), true);
  assert.deepEqual(starts.filter((entry) => entry.startsWith("heron:")), [
    "heron:listsequencer:main:/params/AValue",
    "heron:listsequencer:main:/params/Clock",
    "heron:listsequencer:main:/params/BValue",
    "heron:listsequencer:main:/params/Clock"
  ]);
});

test("best-effort dispatch reports failures and continues other writes and instances", async () => {
  const score = scoreWithRoles({
    "list-a": snapshot("listsequencer", { GateTime: 0.4, Clock: 1 }),
    "plate-a": snapshot("plate", { Decay: 0.5 })
  }, {
    "list-a": assignment("listsequencer", "heron", "heron:listsequencer:main"),
    "plate-a": assignment("plate", "raven", "raven:plate:main")
  });
  const targets = [
    oscTarget({ parameters: [param("GateTime"), param("Clock")] }),
    oscTarget({ id: "raven:plate:main", deviceId: "raven", app: "plate", capabilities: ["plate-edit"], parameters: [param("Decay")] })
  ];
  const attempts = [];
  const result = await dispatchOscBlockRecall(score, "A", targets, {
    sender: async (write) => {
      attempts.push(`${write.targetId}:${write.address}`);
      if (write.address === "/params/GateTime") throw new Error("network down");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.attemptedWriteCount, 3);
  assert.equal(result.failedWriteCount, 1);
  assert.equal(result.roles.find((role) => role.roleId === "list-a").status, "partial");
  assert.equal(result.roles.find((role) => role.roleId === "plate-a").status, "sent");
  assert.equal(attempts.includes("heron:listsequencer:main:/params/Clock"), true);
  assert.equal(attempts.includes("raven:plate:main:/params/Decay"), true);
});

test("dry-run plans writes without sending and reports skipped routing states", async () => {
  const score = scoreWithRoles({
    online: snapshot("listsequencer", { Clock: 0 }),
    offline: snapshot("listsequencer", { Clock: 1 }),
    ignored: snapshot("listsequencer", { Clock: 1 }),
    unassigned: snapshot("listsequencer", { Clock: 1 })
  }, {
    online: assignment("listsequencer", "heron", "heron:listsequencer:main"),
    offline: assignment("listsequencer", "finch", "finch:listsequencer:main"),
    ignored: { ...assignment("listsequencer", "raven", "raven:listsequencer:main"), ignoreRecall: true },
    unassigned: assignment("listsequencer", "", "")
  });
  const targets = [
    oscTarget({ parameters: [param("Clock")] }),
    oscTarget({ id: "raven:listsequencer:main", deviceId: "raven", unitId: "raven", parameters: [param("Clock")] })
  ];
  let sends = 0;
  const result = await dispatchOscBlockRecall(score, "A", targets, {
    dryRun: true,
    sender: async () => { sends += 1; }
  });

  assert.equal(sends, 0);
  assert.equal(result.plannedWriteCount, 1);
  assert.equal(result.attemptedWriteCount, 0);
  assert.equal(result.roles.find((role) => role.roleId === "online").status, "dry-run");
  assert.equal(result.roles.find((role) => role.roleId === "offline").skippedReason, "offline");
  assert.equal(result.roles.find((role) => role.roleId === "ignored").skippedReason, "ignored");
  assert.equal(result.roles.find((role) => role.roleId === "unassigned").skippedReason, "unassigned");
});

test("recall service keeps bounded diagnostic history and block filters", async () => {
  let id = 0;
  const service = createOscSnapshotRecallService({ historyLimit: 2, idFactory: () => `recall-${++id}`, now: () => 1782580000000 });
  const score = scoreWithRoles({ online: snapshot("listsequencer", { Clock: 1 }) }, {
    online: assignment("listsequencer", "heron", "heron:listsequencer:main")
  });
  const targets = [oscTarget({ parameters: [param("Clock")] })];

  await service.recall({ score, blockId: "A", targets, dryRun: true });
  score.mesostructure.B = structuredClone(score.mesostructure.A);
  await service.recall({ score, blockId: "B", targets, dryRun: true });
  await service.recall({ score, blockId: "A", targets, dryRun: true });

  assert.deepEqual(service.snapshot().history.map((entry) => entry.id), ["recall-3", "recall-2"]);
  assert.deepEqual(service.snapshot({ blockId: "B" }).history.map((entry) => entry.id), ["recall-2"]);
  assert.equal(service.snapshot({ blockId: "missing" }).last, null);
});

function scoreWithRoles(snapshots, assignments) {
  const oscClips = Object.fromEntries(Object.entries(snapshots).map(([roleId, document]) => [`clip-${roleId}`, { name: roleId, ...document, capture: {} }]));
  return {
    mesostructure: { A: { duration: { bars: 4 }, players: {}, oscLayers: Object.fromEntries(Object.keys(snapshots).map((roleId) => [roleId, { clipId: `clip-${roleId}` }])) } },
    oscClips,
    oscAssignments: assignments
  };
}

function snapshot(app, params = {}, inputPorts = {}) {
  return { schemaVersion: 1, app, params, inputPorts };
}

function assignment(app, deviceId, oscTargetId) {
  return { app, deviceId, oscTargetId, ignoreRecall: false, locked: false };
}

function oscTarget(overrides = {}) {
  return {
    id: "heron:listsequencer:main",
    deviceId: "heron",
    unitId: "heron",
    app: "listsequencer",
    status: "online",
    sendable: true,
    capabilities: ["osc", "listsequencer-edit"],
    host: "192.168.68.101",
    port: 1234,
    parameters: [],
    inputPorts: [],
    ...overrides
  };
}

function param(name, meta = undefined) {
  return { name, address: `/params/${name}`, meta };
}

function inport(name, meta = undefined) {
  return { name, address: `/messages/in/${name}`, meta };
}
