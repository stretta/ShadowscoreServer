#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:8790";

export async function measureTransportStarts(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const runs = positiveInteger(options.runs, 5, "runs");
  const pauseMs = nonNegativeInteger(options.pauseMs, 1000, "pause-ms");
  const timeoutMs = positiveInteger(options.timeoutMs, 30000, "timeout-ms");

  const initial = await readAuthoritativeTransport(baseUrl, fetchImpl, timeoutMs);
  if (initial.is_playing === true) {
    throw new Error("transport is already playing; Stop it before running the measurement");
  }

  const measurements = [];
  for (let index = 0; index < runs; index += 1) {
    const run = index + 1;
    let play;
    let diagnostics;
    let stop;
    try {
      play = await timedOperation(baseUrl, fetchImpl, now, timeoutMs, "play", run);
      diagnostics = await readPlaybackDiagnostics(baseUrl, fetchImpl, timeoutMs);
    } catch (error) {
      play = play ?? { ok: false, status: 0, elapsed_ms: 0, error: messageForError(error) };
      try {
        diagnostics = await readPlaybackDiagnostics(baseUrl, fetchImpl, timeoutMs);
      } catch (diagnosticError) {
        diagnostics = { error: messageForError(diagnosticError) };
      }
    } finally {
      try {
        stop = await timedOperation(baseUrl, fetchImpl, now, timeoutMs, "stop", run);
      } catch (error) {
        stop = { ok: false, status: 0, elapsed_ms: 0, error: messageForError(error) };
      }
    }

    const stopped = await readAuthoritativeTransport(baseUrl, fetchImpl, timeoutMs);
    measurements.push({
      run,
      play,
      diagnostics,
      stop,
      stopped: {
        state: stopped.state,
        is_playing: stopped.is_playing
      }
    });
    if (stopped.is_playing === true) {
      throw new Error(`run ${run} did not leave transport stopped`);
    }
    if (run < runs && pauseMs > 0) await wait(pauseMs);
  }

  return {
    base_url: baseUrl,
    runs: measurements,
    summary: summarizeMeasurements(measurements)
  };
}

export function summarizeMeasurements(measurements = []) {
  const successes = measurements.filter(({ play }) => play?.ok === true);
  const failures = measurements.filter(({ play }) => play?.ok !== true);
  const elapsed = successes.map(({ play }) => Number(play.elapsed_ms)).filter(Number.isFinite);
  const transition = successes
    .map(({ play }) => Number(play.transition?.elapsed_ms))
    .filter(Number.isFinite);
  const configuration = successes
    .map(({ play }) => phaseElapsed(play.transition, "configuring"))
    .filter(Number.isFinite);
  const synchronization = successes
    .map(({ play }) => phaseElapsed(play.transition, "synchronizing"))
    .filter(Number.isFinite);
  const verification = successes
    .map(({ play }) => phaseElapsed(play.transition, "verifying"))
    .filter(Number.isFinite);
  const armDelay = successes
    .map(({ play }) => finiteOrNull(play.arm_window?.delayMs))
    .filter(Number.isFinite);
  const stopElapsed = measurements
    .map(({ stop }) => Number(stop?.elapsed_ms))
    .filter(Number.isFinite);
  return {
    requested_runs: measurements.length,
    successful_runs: successes.length,
    failed_runs: failures.length,
    play_elapsed_ms: numericSummary(elapsed),
    transition_elapsed_ms: numericSummary(transition),
    configuration_elapsed_ms: numericSummary(configuration),
    synchronization_elapsed_ms: numericSummary(synchronization),
    verification_elapsed_ms: numericSummary(verification),
    arm_delay_ms: numericSummary(armDelay),
    stop_elapsed_ms: numericSummary(stopElapsed),
    failures: failures.map(({ run, play, diagnostics }) => ({
      run,
      error: play?.error ?? "unknown failure",
      phase_verification: diagnostics?.phase_verification ?? null
    }))
  };
}

async function timedOperation(baseUrl, fetchImpl, now, timeoutMs, operation, run) {
  const startedAt = now();
  const response = await fetchImpl(`${baseUrl}/api/v1/objects/transport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: `transport-measure-${operation}-${run}`,
      client_id: "transport-measurement",
      operation,
      args: {}
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  const elapsedMs = Math.max(0, now() - startedAt);
  const result = body?.result ?? {};
  return {
    ok: response.ok && body?.ok === true,
    status: response.status,
    elapsed_ms: elapsedMs,
    error: response.ok ? "" : String(body?.error ?? `HTTP ${response.status}`),
    transition: result.transition ?? null,
    cohort: result.startupCohort ?? null,
    participating_target_ids: result.rnboReadiness?.participatingTargetIds ?? [],
    clock_start_verified: result.clockStartAcknowledgement?.verified ?? null,
    clock_start_ack_count: result.clockStartAcknowledgement?.acknowledgements?.filter(({ acknowledged }) => acknowledged).length ?? 0,
    clock_start_acknowledgement: result.clockStartAcknowledgement ?? null,
    arm_window: result.clockPhaseArmWindow ?? null,
    phase_ack_verified: result.clockPhaseAcknowledgement?.verified ?? null,
    phase_ack_count: result.clockPhaseAcknowledgement?.acknowledgements?.filter(({ acknowledged }) => acknowledged).length ?? 0,
    phase_acknowledgement: result.clockPhaseAcknowledgement ?? null,
    phase_verified: result.clockStartPhaseVerification?.verified ?? null,
    phase_skew_beats: finiteOrNull(result.clockStartPhaseVerification?.witness?.skewBeats),
    projected_stages: result.clockStartPhaseVerification?.witness?.projectedStages ?? [],
    phase_verification: result.clockStartPhaseVerification ?? null,
    coordinated_start_timings: result.coordinatedStartTimings ?? null
  };
}

async function readAuthoritativeTransport(baseUrl, fetchImpl, timeoutMs) {
  const response = await fetchImpl(`${baseUrl}/api/v1/objects/transport`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`transport snapshot HTTP ${response.status}`);
  const body = await response.json();
  return body?.object ?? body;
}

async function readPlaybackDiagnostics(baseUrl, fetchImpl, timeoutMs) {
  const response = await fetchImpl(`${baseUrl}/playback/snapshot`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`playback snapshot HTTP ${response.status}`);
  const body = await response.json();
  const acknowledgement = body?.controls?.players?.clockStartAcknowledgement ?? null;
  return {
    players_playing: body?.controls?.players?.playing ?? null,
    transition: body?.controls?.players?.transition?.last ?? null,
    clock_start_verified: acknowledgement?.verified ?? null,
    phase_ack_verified: acknowledgement?.clockPhaseAcknowledgement?.verified ?? null,
    phase_verification: acknowledgement?.phaseVerification ?? null,
    rollback: acknowledgement?.rollback ?? null,
    active_target_count: body?.updates?.activeTargetCount ?? null,
    participating_target_count: body?.updates?.participatingTargetCount ?? null,
    sync_recovery: body?.controls?.players?.syncRecovery ?? null
  };
}

function phaseElapsed(transition, phase) {
  const values = (transition?.phases ?? [])
    .filter((entry) => entry.phase === phase)
    .map((entry) => Number(entry.elapsed_ms))
    .filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : NaN;
}

function numericSummary(values) {
  if (!values.length) return { min: null, median: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return { min: sorted[0], median, max: sorted.at(-1) };
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (!/^https?:$/.test(url.protocol)) throw new Error("base URL must use http or https");
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  throw new Error(`${label} must be a positive integer`);
}

function nonNegativeInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  throw new Error(`${label} must be a non-negative integer`);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") result.baseUrl = argv[++index];
    else if (value === "--runs") result.runs = Number(argv[++index]);
    else if (value === "--pause-ms") result.pauseMs = Number(argv[++index]);
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else throw new Error(`unknown argument '${value}'`);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  measureTransportStarts(readArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.summary.failed_runs > 0) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`${messageForError(error)}\n`);
      process.exitCode = 1;
    });
}
