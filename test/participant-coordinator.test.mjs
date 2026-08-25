import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPlaybackParticipantCoordinator } from "../src/playback/participant-coordinator.mjs";

test("playback participant coordinator exposes transport-neutral read capabilities", async () => {
  const deliveryEvents = new EventEmitter();
  const calls = [];
  const adapter = {
    enabled: true,
    transferEvents: deliveryEvents,
    async playbackUpdates(blockId, options) {
      calls.push({ blockId, options });
      return { blockId, state: "prepared", targets: {} };
    },
    lifecycleEvents() { return [{ type: "prepare_completed" }]; },
    transferStatus() { return { summary: { readyCount: 1 } }; },
    sendStatus() { return [{ targetId: "finch" }]; },
    sendQueueStatus() { return { inProgress: false, queued: false }; },
    async waitForIdle() { return { inProgress: false, queued: false }; }
  };
  const coordinator = createPlaybackParticipantCoordinator({ adapter, adapterId: "rnbo" });

  assert.equal(coordinator.enabled, true);
  assert.deepEqual(coordinator.descriptor(), {
    adapterId: "rnbo",
    enabled: true,
    capabilities: {
      playbackUpdates: true,
      lifecycleEvents: true,
      deliveryStatus: true,
      operationQueueStatus: true
    }
  });
  assert.deepEqual(await coordinator.playbackUpdates("A", { targets: ["cached"] }), {
    blockId: "A",
    state: "prepared",
    targets: {}
  });
  assert.deepEqual(calls, [{ blockId: "A", options: { targets: ["cached"] } }]);
  assert.deepEqual(coordinator.lifecycleEvents(), [{ type: "prepare_completed" }]);
  assert.equal(coordinator.deliveryStatus().summary.readyCount, 1);
  assert.deepEqual(coordinator.participantDeliveryStatus(), [{ targetId: "finch" }]);
  assert.deepEqual(coordinator.operationQueueStatus(), { inProgress: false, queued: false });
  assert.deepEqual(await coordinator.waitForIdle(), { inProgress: false, queued: false });
  assert.equal(coordinator.deliveryEvents, deliveryEvents);
});

test("disabled playback participant coordinator has safe diagnostics and rejects updates", async () => {
  const coordinator = createPlaybackParticipantCoordinator();
  assert.equal(coordinator.enabled, false);
  assert.deepEqual(coordinator.lifecycleEvents(), []);
  assert.deepEqual(coordinator.participantDeliveryStatus(), []);
  assert.deepEqual(coordinator.operationQueueStatus(), {
    inProgress: false,
    queued: false,
    active: null,
    queuedRequest: null
  });
  assert.equal(coordinator.deliveryStatus().summary.targetCount, 0);
  await assert.rejects(coordinator.playbackUpdates("A"), /cannot playbackUpdates/);
});
