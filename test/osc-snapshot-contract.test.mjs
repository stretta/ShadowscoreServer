import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OSC_ASSIGNMENTS_COLLECTION,
  OSC_CLIPS_COLLECTION,
  OSC_LAYERS_COLLECTION,
  OSC_SNAPSHOT_SCHEMA_VERSION,
  normalizeOscSnapshot,
  snapshotControlDisposition
} from "../src/osc/snapshot-contract.mjs";

const fixtureUrl = new URL("./fixtures/osc-snapshot-contract.json", import.meta.url);

test("Phase 1 collection and schema names are stable", () => {
  assert.equal(OSC_ASSIGNMENTS_COLLECTION, "oscAssignments");
  assert.equal(OSC_CLIPS_COLLECTION, "oscClips");
  assert.equal(OSC_LAYERS_COLLECTION, "oscLayers");
  assert.equal(OSC_SNAPSHOT_SCHEMA_VERSION, 1);
});

test("Phase 1 fixtures cover every editor family and routing condition without live addresses", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const apps = new Set();
  const categories = new Set();
  for (const entry of fixture.cases) {
    const snapshot = normalizeOscSnapshot(entry.snapshot);
    apps.add(snapshot.app);
    categories.add(entry.category);
    assert.equal(JSON.stringify(snapshot).includes("/rnbo/"), false, entry.id);
    assert.equal(JSON.stringify(snapshot).includes(".local"), false, entry.id);
    assert.equal(JSON.stringify(snapshot).includes("oscTargetId"), false, entry.id);
  }
  assert.deepEqual([...apps].sort(), [
    "analogsequencer",
    "listsequencer",
    "listvelsequencer",
    "plate",
    "poland",
    "softpiano",
    "ttid"
  ]);
  assert.deepEqual([...categories].sort(), [
    "clock-off",
    "ignored",
    "list-based",
    "offline",
    "parameter-only",
    "unassigned",
    "unknown-control"
  ]);
});

test("snapshot normalization retains Clock zero and empty lists", () => {
  assert.deepEqual(normalizeOscSnapshot({
    app: "Analog Sequencer",
    params: { Clock: 0 },
    inputPorts: { Steps: [] }
  }), {
    schemaVersion: 1,
    app: "analog-sequencer",
    params: { Clock: 0 },
    inputPorts: { Steps: [] }
  });
});

test("snapshot normalization accepts unknown semantic controls for offline authoring", () => {
  assert.deepEqual(normalizeOscSnapshot({
    schemaVersion: 1,
    app: "future-export",
    params: { FutureParameter: 12 },
    inputPorts: { FutureList: [1, 2, 3] }
  }).params, { FutureParameter: 12 });
});

test("snapshot normalization retains the optional RTZ-before-play recall behavior", () => {
  assert.deepEqual(normalizeOscSnapshot({
    app: "analogsequencer",
    params: { Clock: 1 },
    recall: { rtzBeforePlay: true }
  }).recall, { rtzBeforePlay: true });
});

test("snapshot normalization rejects live addresses and non-numeric values", () => {
  assert.throws(
    () => normalizeOscSnapshot({ app: "plate", params: { "/rnbo/inst/1/params/Gain": 1 } }),
    /semantic names/
  );
  assert.throws(
    () => normalizeOscSnapshot({ app: "plate", params: { Gain: "loud" } }),
    /must be numeric/
  );
  assert.throws(
    () => normalizeOscSnapshot({ app: "listsequencer", inputPorts: { Steps: [1, "rest"] } }),
    /numeric list/
  );
});

test("control disposition excludes momentary commands and orders Clock last", () => {
  assert.deepEqual(snapshotControlDisposition({ kind: "param", name: "Clock" }), {
    state: "clock",
    reason: "clock-last"
  });
  assert.deepEqual(snapshotControlDisposition({ kind: "inputPort", name: "rtz" }), {
    state: "excluded",
    reason: "momentary-control"
  });
  assert.deepEqual(snapshotControlDisposition({ kind: "inputPort", name: "Steps" }), {
    state: "persistent",
    reason: "editor-owned"
  });
  assert.deepEqual(snapshotControlDisposition({ kind: "param", name: "GateTime", meta: { snapshot_order: "late" } }), {
    state: "late",
    reason: "metadata-late"
  });
});

test("TTID metadata is mesostructural and cannot be imported as OSC clip state", () => {
  assert.deepEqual(snapshotControlDisposition({ kind: "param", name: "PitchSet", meta: { editor: "ttid" } }), {
    state: "excluded",
    reason: "mesostructural-ttid"
  });
  assert.throws(() => normalizeOscSnapshot({ app: "listsequencer", params: { Scale: 2741 }, inputPorts: {} }), /cannot own mesostructural TTID/);
  assert.throws(() => normalizeOscSnapshot({ app: "quantizer", params: { ttid: 2741 }, inputPorts: {} }), /cannot own mesostructural TTID/);
});
