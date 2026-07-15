import assert from "node:assert/strict";
import test from "node:test";
import { createOscEditorSnapshot, oscClockRecallNotice, oscEditorParamValue, oscRecallSummary, sameOscSnapshot } from "../public/shared/osc-snapshot-editor.js";

test("shared OSC editor snapshot core normalizes parameter and list drafts", () => {
  assert.deepEqual(createOscEditorSnapshot({
    app: "AnalogSequencer",
    paramEntries: [{ name: "01StageValue", value: "64" }, { name: "Clock", value: 0 }],
    inputPortEntries: [{ name: "Steps", value: "1 0 1" }, { name: "rtz", value: [1] }]
  }), {
    schemaVersion: 1,
    app: "analogsequencer",
    params: { "01StageValue": 64, Clock: 0 },
    inputPorts: { Steps: [1, 0, 1] }
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
  assert.equal(oscClockRecallNotice({ params: { Clock: 0 } }), "Clock 0 suspends immediately");
  assert.equal(oscClockRecallNotice({ params: { Clock: 1 } }), "Clock 1 arms for the next observed shared beat");
  assert.equal(oscClockRecallNotice({ params: { Tempo: 120 } }), "");
});
