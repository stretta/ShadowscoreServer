import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createEventPublisher, createLoadedPublisher } from "../src/realtime/publisher.mjs";

test("event publisher shares one upstream listener and releases it when idle", async () => {
  const events = new EventEmitter();
  const publisher = createEventPublisher({
    loadSnapshot: () => ({ revision: 1 }),
    events,
    sourceEvent: "change",
    mapEvent: (payload) => ({ event: payload.type, payload })
  });
  const one = [];
  const two = [];

  assert.deepEqual(await publisher.current(), { revision: 1 });
  const unsubscribeOne = publisher.subscribe((message) => one.push(message));
  const unsubscribeTwo = publisher.subscribe((message) => two.push(message));
  assert.equal(events.listenerCount("change"), 1);

  events.emit("change", { type: "score.changed", revision: 2 });
  assert.deepEqual(one, [{ event: "score.changed", payload: { type: "score.changed", revision: 2 } }]);
  assert.deepEqual(two, one);

  unsubscribeOne();
  assert.equal(events.listenerCount("change"), 1);
  unsubscribeTwo();
  assert.equal(events.listenerCount("change"), 0);
});

test("loaded publisher coalesces simultaneous fresh reads without caching sequential reads", async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const publisher = createLoadedPublisher(async () => {
    const generation = ++loads;
    if (generation === 1) await gate;
    return { generation };
  }, { refreshOnCurrent: true });

  const first = publisher.current();
  const concurrent = publisher.current();
  release();
  assert.deepEqual(await first, { generation: 1 });
  assert.deepEqual(await concurrent, { generation: 1 });
  assert.deepEqual(await publisher.current(), { generation: 2 });
});

test("loaded publisher reuses a bounded fresh generation and refreshes after expiry", async () => {
  let timestamp = 1_000;
  let loads = 0;
  const publisher = createLoadedPublisher(async () => ({ generation: ++loads }), {
    refreshOnCurrent: true,
    freshnessMs: 125,
    now: () => timestamp
  });

  assert.deepEqual(await publisher.current(), { generation: 1 });
  timestamp += 100;
  assert.deepEqual(await publisher.current(), { generation: 1 });
  timestamp += 26;
  assert.deepEqual(await publisher.current(), { generation: 2 });
  assert.deepEqual(publisher.stats(), {
    loadCount: 2,
    cacheHitCount: 1,
    coalescedCount: 0,
    hasLatest: true,
    freshnessMs: 125,
    latestAgeMs: 0
  });
});
