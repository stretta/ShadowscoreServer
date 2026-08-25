import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedOperationQueue } from "../src/playback/serialized-operation-queue.mjs";

test("serialized operation queue runs one operation at a time in request order", async () => {
  const queue = createSerializedOperationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return 1;
  });
  const second = queue.run(async () => {
    events.push("second:start");
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  assert.deepEqual(queue.status(), { active: true, queued: 1 });
  let idle = false;
  const idlePromise = queue.waitForIdle().then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await idlePromise;
  assert.equal(idle, true);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  assert.deepEqual(queue.status(), { active: false, queued: 0 });
});

test("serialized operation queue releases the next operation after failure", async () => {
  const queue = createSerializedOperationQueue();
  const failed = queue.run(async () => {
    throw new Error("first failed");
  });
  const recovered = queue.run(async () => "recovered");

  await assert.rejects(failed, /first failed/);
  assert.equal(await recovered, "recovered");
  assert.deepEqual(queue.status(), { active: false, queued: 0 });
});

test("serialized operation queue rejects invalid operations without occupying the queue", async () => {
  const queue = createSerializedOperationQueue();
  await assert.rejects(queue.run(null), /must be a function/);
  assert.deepEqual(queue.status(), { active: false, queued: 0 });
});
