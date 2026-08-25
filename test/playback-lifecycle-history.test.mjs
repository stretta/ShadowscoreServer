import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackLifecycleHistory } from "../src/playback/playback-lifecycle-history.mjs";

test("playback lifecycle history is bounded and isolated from callers", () => {
  const history = createPlaybackLifecycleHistory({ limit: 2 });
  const first = { type: "prepare_started", targetId: "finch", detail: { attempt: 1 } };
  history.record(first);
  first.detail.attempt = 99;
  history.record({ type: "prepare_completed", targetId: "finch" });
  history.record({ type: "activation_completed", targetId: "finch" });

  const snapshot = history.snapshot();
  assert.deepEqual(snapshot.map((event) => event.type), ["prepare_completed", "activation_completed"]);
  snapshot[0].type = "mutated";
  assert.equal(history.snapshot()[0].type, "prepare_completed");
  history.clear();
  assert.deepEqual(history.snapshot(), []);
});
