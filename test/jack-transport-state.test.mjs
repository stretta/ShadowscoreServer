import assert from "node:assert/strict";
import test from "node:test";
import { createJackTransportState } from "../src/transport/jack-transport-state.mjs";

test("JACK transport state reports fresh BBT snapshots", () => {
  let now = 1000;
  const transport = createJackTransportState({
    transport: {
      jack: {
        freshnessMs: 500
      }
    }
  }, {
    now: () => now
  });

  const snapshot = transport.update(jackSnapshot());

  assert.equal(snapshot.status, "fresh");
  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.unusable, false);
  assert.equal(snapshot.latest.receivedAt, 1000);
  assert.equal(snapshot.latest.absoluteBeat, 31963.380208333332);
  assert.equal(snapshot.ageMs, 0);

  now = 1250;
  assert.equal(transport.snapshot().status, "fresh");
  assert.equal(transport.snapshot().ageMs, 250);

  now = 1601;
  const stale = transport.snapshot();
  assert.equal(stale.status, "stale");
  assert.equal(stale.fresh, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.unusable, false);
});

test("JACK transport state reports invalid BBT as unusable even when recent", () => {
  const transport = createJackTransportState({}, { now: () => 2000 });

  const snapshot = transport.update({
    source: "jack",
    host: "wren",
    state: "rolling",
    frame: 100,
    frameRate: 48000,
    bbtValid: false,
    observedAt: 1990
  });

  assert.equal(snapshot.status, "unusable");
  assert.equal(snapshot.fresh, false);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.unusable, true);
  assert.equal(snapshot.reason, "bbt invalid");
  assert.equal(snapshot.latest.absoluteBeat, undefined);
});

test("JACK transport state rejects malformed snapshots", () => {
  const transport = createJackTransportState();

  assert.throws(() => transport.update({
    source: "jack",
    host: "wren",
    state: "rolling",
    frame: 100,
    frameRate: 48000,
    bbtValid: true
  }), /bar must be a finite number/);
});

function jackSnapshot() {
  return {
    source: "jack",
    host: "wren",
    state: "rolling",
    frame: 767223806,
    frameRate: 48000,
    bbtValid: true,
    bar: 7991,
    beat: 4,
    tick: 730,
    beatsPerBar: 4,
    beatType: 4,
    ticksPerBeat: 1920,
    beatsPerMinute: 120,
    absoluteBeat: 31963.380208333332,
    observedAt: 1782580000000
  };
}
