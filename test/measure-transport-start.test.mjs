import assert from "node:assert/strict";
import test from "node:test";

import { measureTransportStarts, summarizeMeasurements } from "../tools/measure-transport-start.mjs";

test("transport measurement always stops and summarizes verified starts", async () => {
  const operations = [];
  let now = 1000;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/playback/snapshot")) {
      return jsonResponse({
        controls: { players: { playing: true, transition: { last: { outcome: "playing" } } } },
        updates: { activeTargetCount: 7, participatingTargetCount: 7 }
      });
    }
    if (!options.method) {
      return jsonResponse({ object: { state: "stopped", is_playing: false } });
    }
    const operation = JSON.parse(options.body).operation;
    operations.push(operation);
    now += operation === "play" ? 3200 : 800;
    return jsonResponse({
      ok: true,
      result: operation === "play" ? {
        transition: {
          elapsed_ms: 3100,
          phases: [
            { phase: "configuring", elapsed_ms: 900 },
            { phase: "synchronizing", elapsed_ms: 1000 },
            { phase: "verifying", elapsed_ms: 800 }
          ]
        },
        rnboReadiness: { participatingTargetIds: Array.from({ length: 7 }, (_, index) => `client-${index}`) },
        clockStartAcknowledgement: { verified: true, attemptCount: 1, acknowledgements: Array.from({ length: 7 }, () => ({ acknowledged: true })) },
        clockPhaseAcknowledgement: { verified: true, attemptCount: 1, acknowledgements: Array.from({ length: 7 }, () => ({ acknowledged: true })) },
        clockStartPhaseVerification: {
          verified: true,
          attemptCount: 1,
          attempts: [{ attempt: 1, reads: [{ targetId: "client-0", ok: true, elapsedMs: 12 }] }],
          witness: { skewBeats: 0, projectedStages: [] }
        },
        clockPhaseArmWindow: { delayMs: 125 },
        coordinatedStartTimings: { clockPhaseArmWindowMs: 125 }
      } : {}
    });
  };

  const result = await measureTransportStarts({
    baseUrl: "http://wren.test:8790",
    runs: 2,
    pauseMs: 0,
    fetchImpl,
    now: () => now
  });

  assert.deepEqual(operations, ["play", "stop", "play", "stop"]);
  assert.equal(result.summary.successful_runs, 2);
  assert.deepEqual(result.summary.play_elapsed_ms, { min: 3200, median: 3200, max: 3200 });
  assert.deepEqual(result.summary.transition_elapsed_ms, { min: 3100, median: 3100, max: 3100 });
  assert.deepEqual(result.summary.configuration_elapsed_ms, { min: 900, median: 900, max: 900 });
  assert.deepEqual(result.summary.synchronization_elapsed_ms, { min: 1000, median: 1000, max: 1000 });
  assert.deepEqual(result.summary.verification_elapsed_ms, { min: 800, median: 800, max: 800 });
  assert.deepEqual(result.summary.arm_delay_ms, { min: 125, median: 125, max: 125 });
  assert.deepEqual(result.summary.stop_elapsed_ms, { min: 800, median: 800, max: 800 });
  assert.equal(result.runs[0].play.phase_verification.attemptCount, 1);
  assert.equal(result.runs[0].play.phase_verification.attempts[0].reads[0].targetId, "client-0");
  assert.equal(result.runs[0].play.clock_start_acknowledgement.attemptCount, 1);
  assert.equal(result.runs[0].play.phase_acknowledgement.attemptCount, 1);
  assert.deepEqual(result.runs[0].play.coordinated_start_timings, { clockPhaseArmWindowMs: 125 });
});

test("transport measurement attempts Stop after a failed Play", async () => {
  const operations = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/playback/snapshot")) return jsonResponse({ controls: { players: {} }, updates: {} });
    if (!options.method) return jsonResponse({ object: { state: "stopped", is_playing: false } });
    const operation = JSON.parse(options.body).operation;
    operations.push(operation);
    if (operation === "play") return jsonResponse({ ok: false, error: "phase verification failed" }, 503);
    return jsonResponse({ ok: true, result: {} });
  };

  const result = await measureTransportStarts({ runs: 1, pauseMs: 0, fetchImpl });

  assert.deepEqual(operations, ["play", "stop"]);
  assert.equal(result.summary.failed_runs, 1);
  assert.match(result.summary.failures[0].error, /phase verification failed/);
});

test("transport measurement refuses to interrupt existing playback", async () => {
  const fetchImpl = async () => jsonResponse({ object: { state: "playing", is_playing: true } });
  await assert.rejects(
    measureTransportStarts({ runs: 1, fetchImpl }),
    /transport is already playing/
  );
});

test("transport measurement rejects invalid run controls", async () => {
  await assert.rejects(measureTransportStarts({ runs: 0 }), /runs must be a positive integer/);
  await assert.rejects(measureTransportStarts({ pauseMs: -1 }), /pause-ms must be a non-negative integer/);
  await assert.rejects(measureTransportStarts({ timeoutMs: 0 }), /timeout-ms must be a positive integer/);
});

test("measurement summary retains failed phase evidence", () => {
  const summary = summarizeMeasurements([{
    run: 3,
    play: { ok: false, error: "direct client phase verification failed" },
    diagnostics: { phase_verification: { verified: false, witness: { projectedStages: [{ targetId: "raven", stage: 52 }] } } }
  }]);
  assert.equal(summary.failed_runs, 1);
  assert.equal(summary.failures[0].phase_verification.witness.projectedStages[0].targetId, "raven");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}
