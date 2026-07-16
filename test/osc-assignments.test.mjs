import assert from "node:assert/strict";
import test from "node:test";

import { reconcileOscAssignments, resolveOscAssignment } from "../src/osc/assignments.mjs";

test("OSC roles resolve returning devices by stable device identity and app", () => {
  const assignment = { app: "plate", deviceId: "heron", oscTargetId: "heron:plate:old", locked: false };
  const target = oscTarget({ id: "heron:plate:new", deviceId: "heron", app: "plate" });
  const resolved = resolveOscAssignment("plate-a", assignment, [target]);

  assert.equal(resolved.status, "online");
  assert.equal(resolved.target.id, "heron:plate:new");
  const reconciled = reconcileOscAssignments({ "plate-a": assignment }, [target]);
  assert.equal(reconciled.assignments["plate-a"].oscTargetId, "heron:plate:new");
  assert.equal(reconciled.changed.length, 1);
});

test("OSC role resolution preserves offline and unassigned mappings", () => {
  const offline = resolveOscAssignment("plate-a", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:main"
  }, []);
  const unassigned = resolveOscAssignment("plate-b", { app: "plate", deviceId: "", oscTargetId: "" }, []);

  assert.equal(offline.status, "offline");
  assert.equal(offline.targetId, "heron:plate:main");
  assert.equal(unassigned.status, "unassigned");
});

test("OSC role resolution prefers an exact live target among multiple compatible instances", () => {
  const assignment = { app: "plate", deviceId: "heron", oscTargetId: "heron:plate:one" };
  const targets = [
    oscTarget({ id: "heron:plate:one", deviceId: "heron", app: "plate" }),
    oscTarget({ id: "heron:plate:two", deviceId: "heron", app: "plate" })
  ];
  const resolved = resolveOscAssignment("plate-a", assignment, targets);

  assert.equal(resolved.status, "online");
  assert.equal(resolved.target.id, "heron:plate:one");
  assert.deepEqual(resolved.compatibleTargetIds, ["heron:plate:one", "heron:plate:two"]);
});

test("OSC role resolution keeps stale assignments ambiguous across multiple compatible instances", () => {
  const assignment = { app: "plate", deviceId: "heron", oscTargetId: "heron:plate:old" };
  const targets = [
    oscTarget({ id: "heron:plate:one", deviceId: "heron", app: "plate" }),
    oscTarget({ id: "heron:plate:two", deviceId: "heron", app: "plate" })
  ];
  const resolved = resolveOscAssignment("plate-a", assignment, targets);

  assert.equal(resolved.status, "ambiguous");
  assert.equal(resolved.target, undefined);
});

test("locked OSC roles never retarget and ignored roles never become sendable", () => {
  const locked = { app: "plate", deviceId: "heron", oscTargetId: "heron:plate:old", locked: true };
  const returning = oscTarget({ id: "heron:plate:new", deviceId: "heron", app: "plate" });
  const lockedResult = reconcileOscAssignments({ "plate-a": locked }, [returning]);
  assert.equal(lockedResult.assignments["plate-a"].oscTargetId, "heron:plate:old");
  assert.equal(lockedResult.resolutions["plate-a"].status, "offline");

  const ignored = resolveOscAssignment("plate-b", {
    app: "plate",
    deviceId: "heron",
    oscTargetId: "heron:plate:new",
    ignoreRecall: true
  }, [returning]);
  assert.equal(ignored.status, "ignored");
  assert.equal(ignored.sendable, false);
  assert.equal(ignored.target.id, "heron:plate:new");
});

test("editor capabilities can resolve semantic roles across differently named apps", () => {
  const target = oscTarget({
    id: "wren:listsequencer:main",
    deviceId: "wren",
    app: "listsequencer",
    capabilities: ["osc", "ttid-edit"]
  });
  const resolved = resolveOscAssignment("quantizer-a", {
    app: "ttid",
    deviceId: "wren",
    oscTargetId: ""
  }, [target]);
  assert.equal(resolved.status, "online");
  assert.equal(resolved.target.id, target.id);
});

function oscTarget(overrides = {}) {
  return {
    id: "heron:plate:main",
    deviceId: "heron",
    unitId: "heron",
    app: "plate",
    status: "online",
    sendable: true,
    capabilities: ["osc", "plate-edit"],
    ...overrides
  };
}
