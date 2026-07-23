import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedWriteActionLabel,
  createOscEditorSnapshot,
  oscBlockDraftKey,
  oscBlockDraftState,
  oscBlockSlotState,
  oscClearStateScopes,
  oscChaseHydration,
  oscClockRecallNotice,
  oscEditorParamValue,
  oscPlaybackWiperVisible,
  oscRecallSummary,
  oscWriteActionLabel,
  oscWriteAvailability,
  resolveFocusedOscRole,
  selectExclusiveOscTarget,
  sameOscSnapshot
} from "../public/shared/osc-snapshot-editor.js";

test("shared OSC editor snapshot core normalizes parameter and list drafts", () => {
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

test("writing depends on checked destinations, draft completeness, and semantic dirtiness", () => {
  assert.deepEqual(oscWriteAvailability({ blockId: "A", targetId: "analog-1", complete: true, written: false, dirty: true }), { allowed: true, reason: "" });
  assert.deepEqual(oscWriteAvailability({ blockId: "A", targetId: "analog-1", complete: true, written: true, dirty: false }), {
    allowed: false,
    reason: "A State is saved"
  });
  assert.deepEqual(oscWriteAvailability({ blockId: "B", targetId: "analog-1", complete: false }), {
    allowed: false,
    reason: "Complete the displayed draft before writing"
  });
  assert.deepEqual(oscWriteAvailability({ blockId: "B", complete: true }), { allowed: false, reason: "Check at least one live destination before writing" });
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
  assert.equal(oscClockRecallNotice({ params: { Clock: 0 } }), "Clock 0 suspends immediately");
  assert.equal(oscClockRecallNotice({ params: { Clock: 1 } }), "Clock 1 arms for the next observed shared beat");
  assert.equal(oscClockRecallNotice({ params: { Tempo: 120 } }), "");
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

test("the playback wiper is visible only when PLAYING and EDITING match", () => {
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "E", playingBlockId: "E", running: true }), true);
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "A", playingBlockId: "E", running: true }), false);
  assert.equal(oscPlaybackWiperVisible({ editingBlockId: "E", playingBlockId: "E", running: false }), false);
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
  assert.equal(oscWriteActionLabel({ blockId: "A", written: true }), "Replace A State");
  assert.equal(oscWriteActionLabel({ blockId: "B", written: false }), "Write B State");
  assert.equal(checkedWriteActionLabel("B", 2), "Write B State to 2 Checked Instances");
  assert.equal(checkedWriteActionLabel("B", 1), "Write B State to 1 Checked Instance");
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

test("draft state is keyed independently by role and block and distinguishes dirty from provisional", () => {
  const saved = { schemaVersion: 1, app: "plate", params: { Decay: 0.5 }, inputPorts: {} };
  assert.equal(oscBlockDraftKey({ roleId: "plate-1", targetId: "live", blockId: "B" }), "role:plate-1|B");
  assert.equal(oscBlockDraftKey({ targetId: "live", blockId: "B" }), "target:live|B");
  assert.equal(oscBlockDraftState({ draft: null, saved }), "Written");
  assert.equal(oscBlockDraftState({ draft: saved, saved }), "Saved");
  assert.equal(oscBlockDraftState({ draft: { ...saved, params: { Decay: 0.7 } }, saved }), "Dirty");
  assert.equal(oscBlockDraftState({ draft: saved, saved: null }), "Unwritten Draft");
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
