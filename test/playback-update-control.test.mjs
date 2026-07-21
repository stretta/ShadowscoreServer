import assert from "node:assert/strict";
import test from "node:test";
import { playbackUpdatePresentation } from "../public/shared/playback-update-control.js";

function snapshot({ running = true, state = "saved-not-active", targets = {}, affectedTargetCount } = {}) {
  return {
    scoreRevision: 12,
    transport: { running, blockId: "A" },
    updates: { blockId: "A", scoreRevision: 12, state, targets, affectedTargetCount }
  };
}

test("shared playback control distinguishes saved, ready, and active", () => {
  const saved = playbackUpdatePresentation(snapshot({
    targets: { finch: { targetId: "finch", voiceId: "player-1", state: "saved-not-active" } },
    affectedTargetCount: 1
  }), "A");
  const ready = playbackUpdatePresentation(snapshot({
    state: "prepared",
    targets: { finch: { targetId: "finch", voiceId: "player-1", state: "prepared" } },
    affectedTargetCount: 1
  }), "A");
  const active = playbackUpdatePresentation(snapshot({
    state: "active",
    targets: { finch: { targetId: "finch", voiceId: "player-1", state: "active" } },
    affectedTargetCount: 0
  }), "A");
  assert.equal(saved.label, "Saved · players running previous version");
  assert.equal(saved.actionLabel, "Apply next beat");
  assert.equal(ready.label, "Ready · applies on next beat");
  assert.equal(active.label, "Live");
  assert.equal(active.showAction, false);
});

test("shared playback control uses update-now while stopped", () => {
  const presentation = playbackUpdatePresentation(snapshot({
    running: false,
    state: "prepared",
    targets: { wren: { targetId: "wren", state: "prepared" } },
    affectedTargetCount: 1
  }), "A");
  assert.equal(presentation.actionLabel, "Update players now");
  assert.equal(presentation.actionEnabled, true);
});

test("shared playback control reports unavailable ensemble members and upcoming blocks", () => {
  const unavailable = playbackUpdatePresentation(snapshot({
    targets: {
      finch: { targetId: "finch", state: "prepared" },
      heron: { targetId: "heron", state: "failed", lastError: { status: "unreachable" } }
    },
    affectedTargetCount: 2
  }), "A");
  assert.equal(unavailable.label, "Saved · 1 player unavailable");
  assert.equal(unavailable.actionEnabled, false);

  const upcoming = playbackUpdatePresentation(snapshot({}), "B");
  assert.equal(upcoming.label, "Saved · B is upcoming");
  assert.equal(upcoming.showAction, false);
});
