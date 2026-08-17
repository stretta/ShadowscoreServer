import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackUpdateControl, playbackUpdatePresentation, transferStatusPresentation } from "../public/shared/playback-update-control.js";

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

test("shared playback control distinguishes outgoing and receiver-confirmed transfer progress", () => {
  const presentation = transferStatusPresentation({
    summary: { targetCount: 2, inProgressCount: 1, readyCount: 1, liveCount: 0, failedCount: 0 },
    targets: {
      finch: { targetId: "finch", voiceId: "player-1", state: "awaiting-ack", expectedRows: 277, sentRows: 277, confirmedRows: 0 },
      heron: { targetId: "heron", voiceId: "player-2", state: "ready", expectedRows: 60, sentRows: 60, confirmedRows: 60 }
    }
  });
  assert.equal(presentation.label, "Players · 1/2 ready · 1 receiving");
  assert.equal(presentation.targets[0].label, "Sent 277/277 · awaiting confirmation");
  assert.equal(presentation.targets[1].label, "Ready · 60/60 confirmed");
});

test("shared playback control keeps an action error visible after refreshing", async () => {
  const originalDocument = globalThis.document;
  const elements = {
    state: {},
    transfer: {},
    action: {
      addEventListener(_type, listener) { this.listener = listener; }
    },
    details: {},
    targets: { replaceChildren() {} }
  };
  const root = {
    classList: { add() {} },
    set innerHTML(_value) {},
    querySelector(selector) {
      return {
        "[data-playback-update-state]": elements.state,
        "[data-transfer-summary]": elements.transfer,
        "[data-playback-update-action]": elements.action,
        "[data-playback-update-details]": elements.details,
        "[data-playback-update-targets]": elements.targets
      }[selector];
    }
  };
  globalThis.document = { createElement: () => ({}) };
  const current = snapshot({
    running: false,
    targets: { wren: { targetId: "wren", voiceId: "player-4", state: "saved-not-active" } },
    affectedTargetCount: 1
  });
  let getCount = 0;
  let finishRefresh;
  const refreshed = new Promise((resolve) => { finishRefresh = resolve; });
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        clone: () => ({ json: async () => ({ error: "players were not READY" }) })
      };
    }
    getCount += 1;
    if (getCount === 2) finishRefresh();
    return { ok: true, json: async () => structuredClone(current) };
  };

  try {
    const control = createPlaybackUpdateControl({ root, fetchImpl, getBlockId: () => "A", pollIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    elements.action.listener();
    await refreshed;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(elements.state.textContent, "Playback update failed · players were not READY");
    assert.equal(elements.state.className, "ss-playback-update-state bad");
    assert.equal(elements.action.disabled, false);
    control.close();
  } finally {
    globalThis.document = originalDocument;
  }
});
