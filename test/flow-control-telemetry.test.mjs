import assert from "node:assert/strict";
import test from "node:test";
import { createEventLoopBacklogSampler } from "../src/playback/flow-control-telemetry.mjs";

test("event-loop backlog telemetry measures delay beyond intentional pacing", async () => {
  const readings = [100, 107, 200, 214];
  const sampler = createEventLoopBacklogSampler({
    now: () => readings.shift(),
    wait: async () => {}
  });

  assert.equal(await sampler.pace(5), 2);
  assert.equal(await sampler.pace(10), 4);
  assert.deepEqual(sampler.snapshot(), {
    sampleCount: 2,
    meanMs: 3,
    maxMs: 4
  });
});

test("event-loop backlog telemetry stays non-negative and reports an empty baseline", async () => {
  const readings = [10, 12];
  const sampler = createEventLoopBacklogSampler({
    now: () => readings.shift(),
    wait: async () => {}
  });

  assert.deepEqual(sampler.snapshot(), {
    sampleCount: 0,
    meanMs: 0,
    maxMs: 0
  });
  assert.equal(await sampler.pace(5), 0);
});
