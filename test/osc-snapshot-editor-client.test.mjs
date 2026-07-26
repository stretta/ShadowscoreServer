import assert from "node:assert/strict";
import test from "node:test";
import {
  createOscEditorSnapshot,
  createOscStateWriteQueue,
  oscBlockSlotState,
  oscClearStateScopes,
  oscCopyStateAvailability,
  oscChaseHydration,
  oscClockRecallNotice,
  oscEditorParamValue,
  oscPlaybackWiperVisible,
  oscRecallSummary,
  readOscQueryParameterValues,
  resolveFocusedOscRole,
  selectExclusiveOscTarget,
  sameOscSnapshot
} from "../public/shared/osc-snapshot-editor.js";

test("instant state write queue serializes contexts and coalesces unsent replacements", async () => {
  const writes = [];
  const statuses = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = createOscStateWriteQueue({
    async write(job) {
      writes.push(job);
      if (writes.length === 1) await firstGate;
    },
    onStatus(status) { statuses.push(status.state); }
  });

  queue.enqueue({ key: "A|analog-1", blockId: "A", targetIds: ["analog-1"], snapshot: { app: "analogsequencer", params: { Gate: 0.1 } } });
  queue.enqueue({ key: "A|analog-1", blockId: "A", targetIds: ["analog-1"], snapshot: { app: "analogsequencer", params: { Gate: 0.2 } } });
  queue.enqueue({ key: "A|analog-1", blockId: "A", targetIds: ["analog-1"], snapshot: { app: "analogsequencer", params: { Gate: 0.3 } } });
  queue.enqueue({ key: "B|analog-1", blockId: "B", targetIds: ["analog-1"], snapshot: { app: "analogsequencer", params: { Gate: 0.4 } } });
  releaseFirst();
  await queue.whenIdle();

  assert.deepEqual(writes.map((job) => [job.blockId, job.snapshot.params.Gate]), [
    ["A", 0.1],
    ["A", 0.3],
    ["B", 0.4]
  ]);
  assert.equal(queue.snapshot().running, false);
  assert.deepEqual(queue.snapshot().queued, []);
  assert.ok(statuses.includes("saving"));
  assert.equal(statuses.at(-1), "saved");
});

test("instant state write queue retains a failed immutable job for retry", async () => {
  let attempts = 0;
  const queue = createOscStateWriteQueue({
    async write() {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    }
  });
  queue.enqueue({ key: "A|analog-1", blockId: "A", targetIds: ["analog-1"], snapshot: { app: "analogsequencer", params: { Gate: 0.5 } } });
  await queue.whenIdle();
  assert.equal(queue.snapshot().failed.snapshot.params.Gate, 0.5);
  assert.equal(queue.retry(), true);
  await queue.whenIdle();
  assert.equal(attempts, 2);
  assert.equal(queue.snapshot().failed, null);
});

test("shared OSC editor snapshot core normalizes parameter and list state", () => {
  assert.deepEqual(createOscEditorSnapshot({
    app: "AnalogSequencer",
    paramEntries: [{ name: "01StageValue", value: "64" }, { name: "Clock", value: 0 }],
    inputPortEntries: [{ name: "Steps", value: "1 0 1" }, { name: "rtz", value: [1] }],
    recall: { rtzBeforePlay: true }
  }), {
    schemaVersion: 1,
    app: "analogsequencer",
    params: { "01StageValue": 64, Clock: 0 },
    inputPorts: { Steps: [1, 0, 1] },
    recall: { rtzBeforePlay: true }
  });
});

test("shared OSC editor snapshot core stores string enums as numeric option indexes", () => {
  const param = { name: "ClockRate", value: "8n", values: ["4n", "8nd", "8n", "16n"] };
  const snapshot = createOscEditorSnapshot({ app: "analogsequencer", paramEntries: [param] });
  assert.deepEqual(snapshot.params, { ClockRate: 2 });
  assert.equal(oscEditorParamValue(param, snapshot.params.ClockRate), "8n");
  assert.equal(oscEditorParamValue({ ...param, values: ["1", "2", "14", "14", "15"] }, 3), "15");
});

test("shared OSC editor snapshot comparison is semantic and order-independent", () => {
  assert.equal(sameOscSnapshot(
    { app: "plate", params: { Clock: 0, Decay: 0.5 }, inputPorts: {} },
    { schemaVersion: 1, app: "plate", params: { Decay: 0.5, Clock: 0 }, inputPorts: {} }
  ), true);
  assert.equal(oscRecallSummary({ attemptedWriteCount: 2, attemptedPacketBytes: 72, dispatchDurationMs: 1.5 }),
    "Recall complete: 2 writes, 72 bytes, 1.5 ms dispatch");
});

test("shared OSC editor recall notice follows the saved Clock contract", () => {
  assert.equal(oscClockRecallNotice({ params: { Clock: 0 } }), "Clock Off suspends immediately");
  assert.equal(oscClockRecallNotice({ params: { Clock: 1 } }), "Clock On arms for the next observed shared beat");
  assert.equal(oscClockRecallNotice({ params: { Tempo: 120 } }), "");
});

test("shared OSC editor reads unified nested Clock parameters by reported address", async () => {
  const target = {
    host: "127.0.0.1",
    baseAddress: "/rnbo/inst/3",
    parameters: [
      { name: "Clock", address: "/rnbo/inst/3/params/Clock/Clock" },
      { name: "Swing", address: "/rnbo/inst/3/params/Clock/Swing" },
      { name: "ClockInterval", address: "/rnbo/inst/3/params/Clock/ClockInterval" },
      { name: "SwingAmt", address: "/rnbo/inst/3/params/Clock/SwingAmt" }
    ]
  };
  const values = await readOscQueryParameterValues(target, {
    protocol: "http:",
    hostname: "wren.local",
    fetchImpl: async (url) => {
      assert.equal(url, "http://wren.local:5678/rnbo/inst/3/params");
      return {
        ok: true,
        async json() {
          return {
            CONTENTS: {
              Clock: {
                CONTENTS: {
                  Clock: { FULL_PATH: "/rnbo/inst/3/params/Clock/Clock", VALUE: "On" },
                  Swing: { FULL_PATH: "/rnbo/inst/3/params/Clock/Swing", VALUE: "Off" },
                  ClockInterval: { FULL_PATH: "/rnbo/inst/3/params/Clock/ClockInterval", VALUE: 240 },
                  SwingAmt: { FULL_PATH: "/rnbo/inst/3/params/Clock/SwingAmt", VALUE: 0.625 }
                }
              }
            }
          };
        }
      };
    }
  });
  assert.deepEqual(Object.fromEntries(values), {
    Clock: "On",
    Swing: "Off",
    ClockInterval: 240,
    SwingAmt: 0.625
  });
});

test("focused live instances resolve their score role without exposing role selection", () => {
  const assignments = {
    "analog-a": { app: "analogsequencer", deviceId: "wren", oscTargetId: "wren:analogsequencer:5" },
    "analog-b": { app: "analogsequencer", deviceId: "wren", oscTargetId: "wren:analogsequencer:11" }
  };
  const targets = [
    { id: "wren:analogsequencer:5", app: "analogsequencer", deviceId: "wren" },
    { id: "wren:analogsequencer:11", app: "analogsequencer", deviceId: "wren" }
  ];
  assert.equal(resolveFocusedOscRole({ app: "analogsequencer", targetId: targets[1].id, targets, assignments }), "analog-b");
  assert.equal(resolveFocusedOscRole({ app: "analogsequencer", targetId: "missing", targets, assignments }), "");
});

test("an unassigned same-device instance does not borrow another online instance's role", () => {
  const assignments = {
    "analog-a": { app: "analogsequencer", deviceId: "wren", oscTargetId: "wren:analogsequencer:5" }
  };
  const targets = [
    { id: "wren:analogsequencer:5", app: "analogsequencer", deviceId: "wren" },
    { id: "wren:analogsequencer:11", app: "analogsequencer", deviceId: "wren" }
  ];
  assert.equal(resolveFocusedOscRole({ app: "analogsequencer", targetId: targets[1].id, targets, assignments }), "");
});

test("focusing an instance makes it the sole live-send destination", () => {
  const inputs = [
    { checked: true, dataset: { target: "analog-5" } },
    { checked: true, dataset: { target: "analog-11" } },
    { checked: false, dataset: { target: "analog-17" } }
  ];
  const root = { querySelectorAll: () => inputs };
  assert.equal(selectExclusiveOscTarget(root, "analog-11"), true);
  assert.deepEqual(inputs.map(({ checked }) => checked), [false, true, false]);
  assert.equal(selectExclusiveOscTarget(root, "missing"), false);
  assert.deepEqual(inputs.map(({ checked }) => checked), [false, false, false]);
});

test("the playback wiper follows a matching live client stage even when macro transport is stopped", () => {
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "E", playingBlockId: "E", running: true }), true);
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "A", playingBlockId: "E", running: true }), false);
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "E", playingBlockId: "E", running: false }), true);
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "", playingBlockId: "E", running: true }), false);
});

test("block slots distinguish unspecified state from explicitly written empty data", () => {
  const emptyClip = { schemaVersion: 1, app: "listsequencer", params: { Clock: 0 }, inputPorts: { Steps: [] } };
  const score = {
    oscClips: { "a-list": emptyClip },
    mesostructure: {
      A: { oscLayers: { "list-a": { clipId: "a-list" } } },
      B: { oscLayers: {} }
    }
  };
  assert.deepEqual(oscBlockSlotState(score, "A", "list-a"), { status: "Written", clipId: "a-list", clip: emptyClip });
  assert.deepEqual(oscBlockSlotState(score, "B", "list-a"), { status: "Unspecified", clipId: "", clip: null });
});

test("clear scope counts distinguish focused, block-wide, and score-wide Written states", () => {
  const score = {
    mesostructure: {
      A: { oscLayers: { "analog-a": { clipId: "a-analog" }, "plate-a": { clipId: "a-plate" } } },
      B: { oscLayers: { "analog-a": { clipId: "b-analog" } } },
      C: { oscLayers: {} }
    }
  };
  const scopes = oscClearStateScopes(score, "A", "analog-a");
  assert.equal(scopes["instance-block"].count, 1);
  assert.equal(scopes.block.count, 2);
  assert.equal(scopes.all.count, 3);
  assert.match(scopes.block.confirmation, /all instances in block A/);
  assert.match(scopes.all.confirmation, /all instances in all blocks/);
});

test("copy checked state requires every checked role to be Written in the source block", () => {
  const score = {
    oscClips: {
      "a-analog": { app: "analogsequencer", params: { Clock: 1 }, inputPorts: {} },
      "a-plate": { app: "plate", params: { Decay: 0.5 }, inputPorts: {} },
      "b-analog": { app: "analogsequencer", params: { Clock: 0 }, inputPorts: {} }
    },
    mesostructure: {
      A: { oscLayers: { "analog-a": { clipId: "a-analog" }, "plate-a": { clipId: "a-plate" } } },
      B: { oscLayers: { "analog-a": { clipId: "b-analog" } } }
    }
  };
  assert.deepEqual(oscCopyStateAvailability({
    score,
    sourceBlockId: "A",
    destinationBlockId: "B",
    targetIds: ["analog", "plate"],
    roleIds: ["analog-a", "plate-a"]
  }), {
    allowed: true,
    reason: "",
    replacementCount: 1,
    summary: "Copy 2 Written states from A to B · replace 1"
  });
  assert.match(oscCopyStateAvailability({
    score,
    sourceBlockId: "B",
    destinationBlockId: "A",
    targetIds: ["analog", "plate"],
    roleIds: ["analog-a", "plate-a"]
  }).reason, /1 checked instance is Unspecified in block B/);
  assert.match(oscCopyStateAvailability({
    score,
    sourceBlockId: "A",
    destinationBlockId: "B",
    targetIds: ["unmapped"],
    roleIds: []
  }).reason, /must have a score role/);
});

test("chase hydrates only a newly playing written state", () => {
  const written = { schemaVersion: 1, app: "analogsequencer", params: { Clock: 1, GateTime: 72 }, inputPorts: {} };
  const score = {
    oscClips: { "b-analog": written },
    mesostructure: {
      A: { oscLayers: {} },
      B: { oscLayers: { "analog-a": { clipId: "b-analog" } } }
    }
  };
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "A", blockId: "B", roleId: "analog-a", chase: true }), {
    status: "Written",
    clip: written
  });
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "B", blockId: "B", roleId: "analog-a", chase: true }), {
    status: "Unchanged",
    clip: null
  });
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "A", blockId: "B", roleId: "analog-a", chase: false }), {
    status: "Unchanged",
    clip: null
  });
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "A", blockId: "B", roleId: "analog-a", chase: true, ignored: true }), {
    status: "Unchanged",
    clip: null
  });
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "B", blockId: "B", roleId: "analog-a", chase: true, force: true }), {
    status: "Written",
    clip: written
  });
  assert.deepEqual(oscChaseHydration({ score, previousBlockId: "B", blockId: "A", roleId: "analog-a", chase: true }), {
    status: "Unspecified",
    clip: null
  });
});
