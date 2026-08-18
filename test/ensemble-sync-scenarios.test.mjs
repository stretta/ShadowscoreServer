import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ensemble-sync-scenarios.json", import.meta.url), "utf8"));
const allowedStatuses = new Set([
  "aligned",
  "stable-offset",
  "rate-drift",
  "stale-or-stopped",
  "preparing",
  "reconstruct-active"
]);

test("ensemble sync regression corpus has complete ordered observations", () => {
  assert.equal(fixture.version, 1);
  assert.equal(fixture.timing.stagesPerBeat, 4);
  assert.equal(fixture.targets.length, 7);
  assert.equal(fixture.scenarios.length, 8);

  for (const scenario of fixture.scenarios) {
    assert.match(scenario.id, /^[a-z0-9-]+$/);
    assert.ok(scenario.description.length > 20, `${scenario.id} needs an explanatory description`);
    assert.ok(allowedStatuses.has(scenario.expected.status), `${scenario.id} has an unknown expected status`);
    assert.ok(["evaluate", "suppress"].includes(scenario.expected.phaseJudgement));
    assert.ok(scenario.samples.length >= 2, `${scenario.id} needs repeated observations`);

    let previousAt = -1;
    for (const sample of scenario.samples) {
      assert.ok(sample.atMs > previousAt, `${scenario.id} observations must be ordered`);
      assert.equal(sample.stages.length, fixture.targets.length, `${scenario.id} must observe every target`);
      assert.ok(sample.stages.every(Number.isFinite), `${scenario.id} stages must be finite`);
      previousAt = sample.atMs;
    }

    for (const targetId of scenario.expected.outlierTargets ?? []) {
      assert.ok(fixture.targets.includes(targetId), `${scenario.id} names unknown outlier ${targetId}`);
    }
  }
});

test("captured aligned scenarios never exceed their sampling tolerance", () => {
  for (const scenario of fixture.scenarios.filter(({ expected }) => expected.status === "aligned")) {
    for (const sample of scenario.samples) {
      const spread = Math.max(...sample.stages) - Math.min(...sample.stages);
      assert.ok(spread <= scenario.expected.maxSpreadStages, `${scenario.id} spread ${spread} exceeded tolerance`);
    }
  }
});

test("captured offset and drift scenarios contain observable divergence", () => {
  const divergent = fixture.scenarios.filter(({ expected }) => ["stable-offset", "rate-drift"].includes(expected.status));
  for (const scenario of divergent) {
    const spreads = scenario.samples.map(({ stages }) => Math.max(...stages) - Math.min(...stages));
    assert.ok(spreads.some((spread) => spread > 1), `${scenario.id} does not contain a detectable divergence`);
    if (scenario.expected.status === "stable-offset") {
      assert.ok(Math.max(...spreads) - Math.min(...spreads) <= 1, `${scenario.id} offset is not stable`);
    } else {
      assert.ok(spreads.at(-1) > spreads[0], `${scenario.id} drift does not accumulate`);
    }
  }
});

test("captured operational states specify whether phase judgment is safe", () => {
  const preparing = fixture.scenarios.find(({ id }) => id === "preparation-does-not-condemn-active-payload");
  assert.equal(preparing.runtime.sendQueueInProgress, true);
  assert.equal(preparing.runtime.activeTransaction, 10507);
  assert.equal(preparing.expected.phaseJudgement, "suppress");

  const restart = fixture.scenarios.find(({ id }) => id === "server-restart-reconstructs-active-clients");
  assert.equal(restart.runtime.serverActiveTransaction, null);
  assert.equal(restart.runtime.clientActiveTransaction, 10507);
  assert.equal(restart.expected.action, "adopt-without-resend");
});

test.todo("ensemble sync estimator classifies the captured changing-condition scenarios");
