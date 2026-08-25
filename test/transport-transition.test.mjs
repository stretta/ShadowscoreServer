import assert from "node:assert/strict";
import test from "node:test";

import {
  beginTransportTransition,
  completeTransportTransition,
  transportTransitionSnapshot,
  updateTransportTransition
} from "../src/transport/transport-transition.mjs";

test("transport transition reports progressive start phases and completed timings", () => {
  let now = Date.parse("2026-08-25T12:00:00.000Z");
  const runtime = { now: () => now };
  const id = beginTransportTransition(runtime, { kind: "play" });

  now += 40;
  updateTransportTransition(runtime, id, "discovering");
  now += 160;
  updateTransportTransition(runtime, id, "preparing");
  now += 300;
  updateTransportTransition(runtime, id, "synchronizing");

  const active = transportTransitionSnapshot(runtime).active;
  assert.equal(active.state, "synchronizing");
  assert.equal(active.label, "Synchronizing players");
  assert.equal(active.elapsed_ms, 500);
  assert.deepEqual(active.phases.map(({ phase, elapsed_ms }) => ({ phase, elapsed_ms })), [
    { phase: "received", elapsed_ms: 40 },
    { phase: "discovering", elapsed_ms: 160 },
    { phase: "preparing", elapsed_ms: 300 }
  ]);

  now += 75;
  const completed = completeTransportTransition(runtime, id, { ok: true });
  assert.equal(completed.outcome, "playing");
  assert.equal(completed.elapsed_ms, 575);
  assert.equal(transportTransitionSnapshot(runtime).active, null);
  assert.equal(transportTransitionSnapshot(runtime).last.elapsed_ms, 575);
});

test("an older operation cannot overwrite a newer transport transition", () => {
  const runtime = { now: () => 1000 };
  const first = beginTransportTransition(runtime);
  const second = beginTransportTransition(runtime, { kind: "resync" });

  assert.equal(updateTransportTransition(runtime, first, "verifying"), false);
  assert.equal(completeTransportTransition(runtime, first, { ok: false }), null);
  assert.equal(transportTransitionSnapshot(runtime).active.id, second);
  assert.equal(transportTransitionSnapshot(runtime).active.kind, "resync");
});
