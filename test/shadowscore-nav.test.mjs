import assert from "node:assert/strict";
import test from "node:test";
import {
  activeNavigationForPath,
  shadowScoreNavigation
} from "../public/shared/shadowscore-nav.js";

test("grouped navigation has the settled four primary destinations", () => {
  assert.deepEqual(shadowScoreNavigation.map(({ id, label }) => ({ id, label })), [
    { id: "shadowscore", label: "ShadowScore" },
    { id: "arrange", label: "Arrange" },
    { id: "osc", label: "OSC" },
    { id: "setup", label: "Setup" }
  ]);
});

test("grouped navigation resolves current group and item for every route family", () => {
  assert.deepEqual(activeNavigationForPath("/piano-roll"), {
    groupId: "shadowscore",
    groupLabel: "ShadowScore",
    itemLabel: "Piano Roll"
  });
  assert.deepEqual(activeNavigationForPath("/matrix-edit/session"), {
    groupId: "shadowscore",
    groupLabel: "ShadowScore",
    itemLabel: "Matrix"
  });
  assert.deepEqual(activeNavigationForPath("/structure-editor"), {
    groupId: "arrange",
    groupLabel: "Arrange",
    itemLabel: "Arrange"
  });
  assert.deepEqual(activeNavigationForPath("/editors/analogsequencer"), {
    groupId: "osc",
    groupLabel: "OSC",
    itemLabel: "Analog Sequencer"
  });
  assert.deepEqual(activeNavigationForPath("/tools/osc-macros"), {
    groupId: "osc",
    groupLabel: "OSC",
    itemLabel: "OSC Macros"
  });
  assert.deepEqual(activeNavigationForPath("/admin#routing"), {
    groupId: "setup",
    groupLabel: "Setup",
    itemLabel: "Player And Client Routing"
  });
  assert.deepEqual(activeNavigationForPath("/admin"), {
    groupId: "setup",
    groupLabel: "Setup",
    itemLabel: "Admin"
  });
  assert.deepEqual(activeNavigationForPath("/transport/status"), {
    groupId: "setup",
    groupLabel: "Setup",
    itemLabel: "Transport Status"
  });
});
