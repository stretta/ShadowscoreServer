import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../src/playback/bounded-concurrency.mjs";

test("bounded concurrency preserves result order and never exceeds its limit", async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const running = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return value * 10;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(await running, [10, 20, 30, 40]);
  assert.equal(maxActive, 2);
});

test("bounded concurrency drains queued work before surfacing a target failure", async () => {
  const attempted = [];
  const failure = new Error("target failed");

  await assert.rejects(mapWithConcurrency([1, 2, 3], 1, async (value) => {
    attempted.push(value);
    if (value === 2) throw failure;
    return value;
  }), (error) => error === failure);

  assert.deepEqual(attempted, [1, 2, 3]);
});
