import assert from "node:assert/strict";
import test from "node:test";
import { buildOscResourceReport } from "../src/osc/resources.mjs";

test("OSC resource report distinguishes mapped, compatible, offline, ambiguous, and unmapped resources", () => {
  const assignments = {
    "list-a": { label: "List A", app: "listsequencer", deviceId: "rack-a", oscTargetId: "list-1" },
    "plate-a": { label: "Plate A", app: "plate", deviceId: "rack-b", oscTargetId: "plate-1", locked: true },
    "analog-a": { label: "Analog A", app: "analogsequencer", deviceId: "rack-c", oscTargetId: "analog-1", locked: true },
    "missing-a": { label: "Missing A", app: "softpiano", deviceId: "rack-z" }
  };
  const targets = [
    target("list-1", "listsequencer", "rack-a"),
    target("list-2", "listsequencer", "rack-a"),
    target("plate-1", "plate", "rack-b"),
    target("analog-1", "analogsequencer", "rack-c", "offline", false),
    target("ttid-1", "ttid", "rack-d", "ambiguous", false),
    target("poland-1", "poland", "rack-e")
  ];

  const report = buildOscResourceReport(assignments, targets);
  assert.equal(report.roles.find(({ roleId }) => roleId === "list-a").status, "ambiguous");
  assert.equal(report.roles.find(({ roleId }) => roleId === "plate-a").status, "mapped");
  assert.equal(report.roles.find(({ roleId }) => roleId === "analog-a").status, "offline");
  assert.equal(report.roles.find(({ roleId }) => roleId === "missing-a").status, "offline");
  assert.equal(report.resources.find(({ targetId }) => targetId === "list-1").status, "compatible");
  assert.equal(report.resources.find(({ targetId }) => targetId === "plate-1").status, "mapped");
  assert.equal(report.resources.find(({ targetId }) => targetId === "analog-1").status, "offline");
  assert.equal(report.resources.find(({ targetId }) => targetId === "ttid-1").status, "ambiguous");
  assert.equal(report.resources.find(({ targetId }) => targetId === "poland-1").status, "unmapped");
});

function target(id, app, deviceId, status = "online", sendable = true) {
  return { id, label: id, app, deviceId, unitId: deviceId, instance: "main", status, sendable };
}
