export const TRANSPORT_START_PROTOCOL_VERSION = 1;
export const TRANSPORT_START_MAX_OPERATION_ID = 16777215;

export const TRANSPORT_START_COMMANDS = Object.freeze({
  arm: 1,
  activate: 2,
  cancel: 3
});

export const TRANSPORT_START_EVENTS = Object.freeze({
  armed: 1,
  active: 2,
  canceled: 3,
  rejected: 4
});

const EVENT_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(TRANSPORT_START_EVENTS).map(([name, value]) => [value, name])
));

export function armTransportStartRequest({
  operationId,
  startStage,
  maxSteps,
  clockInterval,
  expiryBeats = 2
} = {}) {
  const operation = exactInt(operationId, "operationId", 1, TRANSPORT_START_MAX_OPERATION_ID);
  const steps = exactInt(maxSteps, "maxSteps", 1, 2147483647);
  const stage = exactInt(startStage, "startStage", 0, steps - 1);
  const interval = exactInt(clockInterval, "clockInterval", 1, 2147483647);
  const expiry = exactInt(expiryBeats, "expiryBeats", 1, 1024);
  return request(TRANSPORT_START_COMMANDS.arm, operation, stage, steps, interval, expiry);
}

export function activateTransportStartRequest(operationId) {
  return operationRequest(TRANSPORT_START_COMMANDS.activate, operationId);
}

export function cancelTransportStartRequest(operationId) {
  return operationRequest(TRANSPORT_START_COMMANDS.cancel, operationId);
}

export function validateTransportStartAck(value, { operationId, expectedEvent } = {}) {
  const expectedOperation = exactInt(operationId, "operationId", 1, TRANSPORT_START_MAX_OPERATION_ID);
  const values = Array.isArray(value) ? value.map(Number) : [];
  const [version, eventCode, observedOperation, stage, detail, successFlag] = values;
  const event = EVENT_NAMES[eventCode] ?? "unknown";
  const base = {
    ok: false,
    value: values,
    protocolVersion: version,
    event,
    eventCode,
    operationId: observedOperation,
    expectedOperationId: expectedOperation,
    stage,
    detail,
    success: successFlag === 1
  };

  if (values.length === 0) {
    return { ...base, status: "uninitialized" };
  }
  if (values.length !== 6 || values.some((entry) => !Number.isInteger(entry))) {
    return { ...base, status: "malformed" };
  }
  if (version !== TRANSPORT_START_PROTOCOL_VERSION) {
    return { ...base, status: "version-mismatch" };
  }
  if (!EVENT_NAMES[eventCode]) {
    return { ...base, status: "unknown-event" };
  }
  if (observedOperation !== expectedOperation) {
    return { ...base, status: "stale-operation" };
  }
  if (eventCode === TRANSPORT_START_EVENTS.rejected || successFlag !== 1) {
    return { ...base, status: "rejected" };
  }
  if (expectedEvent !== undefined) {
    const expectedCode = eventCodeFor(expectedEvent);
    if (eventCode !== expectedCode) {
      return { ...base, status: "event-mismatch", expectedEvent };
    }
  }
  return { ...base, ok: true, status: event };
}

export function supportsTransactionalTransportStart(target) {
  return Boolean(
    target
    && target.available !== false
    && target.capabilities?.transactionalTransportStart === true
    && String(target.transportStartPath ?? "").startsWith("/")
    && String(target.transportStartAckPath ?? "").startsWith("/")
  );
}

export function selectTransactionalTransportStartCohort(targets, expectedTargetIds, options = {}) {
  const expected = [...new Set((expectedTargetIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (!expected.length) return [];
  const byId = new Map((targets ?? []).map((target) => [String(target?.id ?? ""), target]));
  const selected = expected.map((id) => byId.get(id));
  if (selected.some((target) => !target || !supportsTransactionalTransportStart(target))) return [];
  if (options.requirePhaseReset === true && selected.some((target) =>
    !String(target.clockPhaseResetPath ?? "").startsWith("/")
    || !String(target.clockPhaseAckPath ?? "").startsWith("/")
  )) return [];
  return selected;
}

export async function coordinateTransactionalTransportStart({
  targets,
  operationId,
  expiryBeats = 2,
  sendRequest,
  readAcknowledgement,
  awaitActivationWindow,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  timeoutMs = 5000,
  pollIntervalMs = 50
} = {}) {
  const operation = exactInt(operationId, "operationId", 1, TRANSPORT_START_MAX_OPERATION_ID);
  const cohort = normalizeCohort(targets);
  if (!cohort.length) throw coordinatorError("TRANSPORT_START_EMPTY_COHORT", "transactional transport start requires at least one target");
  if (typeof sendRequest !== "function") throw new Error("sendRequest is required");
  if (typeof readAcknowledgement !== "function") throw new Error("readAcknowledgement is required");
  if (typeof awaitActivationWindow !== "function") throw new Error("awaitActivationWindow is required");

  const sent = [];
  const startedAt = now();
  try {
    const armWrites = await sendToCohort(cohort, (entry) => armTransportStartRequest({
      operationId: operation,
      startStage: entry.startStage,
      maxSteps: entry.maxSteps,
      clockInterval: entry.clockInterval,
      expiryBeats
    }), sendRequest, sent);
    const armed = await awaitCohortEvent(cohort, {
      operationId: operation,
      expectedEvent: "armed",
      expectedStages: true,
      readAcknowledgement,
      wait,
      now,
      timeoutMs,
      pollIntervalMs
    });
    const activationWindow = await awaitActivationWindow();
    if (activationWindow?.available !== true) {
      throw coordinatorError(
        "TRANSPORT_START_WINDOW_UNAVAILABLE",
        activationWindow?.reason || "safe transactional activation window is unavailable",
        { activationWindow }
      );
    }
    const activateWrites = await sendToCohort(
      cohort,
      () => activateTransportStartRequest(operation),
      sendRequest,
      sent
    );
    const active = await awaitCohortEvent(cohort, {
      operationId: operation,
      expectedEvent: "active",
      expectedStages: true,
      readAcknowledgement,
      wait,
      now,
      timeoutMs,
      pollIntervalMs
    });
    return {
      ok: true,
      operationId: operation,
      targetIds: cohort.map(({ id }) => id),
      armWrites,
      armed,
      activationWindow,
      activateWrites,
      active,
      elapsedMs: Math.max(0, now() - startedAt)
    };
  } catch (cause) {
    const cancelRequest = cancelTransportStartRequest(operation);
    const rollback = await Promise.all(cohort.map(async (entry) => {
      try {
        const write = await sendRequest(entry.target, cancelRequest);
        sent.push({ targetId: entry.id, command: "cancel", write });
        return { targetId: entry.id, ok: true, write };
      } catch (error) {
        return { targetId: entry.id, ok: false, error: String(error?.message ?? error) };
      }
    }));
    const error = coordinatorError(
      cause?.code || "TRANSPORT_START_FAILED",
      cause?.message || "transactional transport start failed",
      {
        operationId: operation,
        targetIds: cohort.map(({ id }) => id),
        sent,
        rollback,
        cause
      }
    );
    throw error;
  }
}

export async function verifySustainedCohortStages(cohortEntries, {
  readStage,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  sampleCount = 7,
  sampleIntervalMs = 50,
  requiredAdvance = 1
} = {}) {
  if (typeof readStage !== "function") throw new Error("readStage is required");
  const cohort = normalizeCohort(cohortEntries);
  if (!cohort.length) throw coordinatorError("TRANSPORT_START_EMPTY_COHORT", "sustained stage verification requires at least one target");
  const samplesRequired = boundedInteger(sampleCount, 7, 3, 31);
  const intervalMs = boundedMilliseconds(sampleIntervalMs, 50, 0, 1000);
  const advanceRequired = boundedInteger(requiredAdvance, 1, 0, 16);
  const startedAt = now();
  const samples = [];

  for (let sampleIndex = 0; sampleIndex < samplesRequired; sampleIndex += 1) {
    const observed = await Promise.all(cohort.map(async (entry) => {
      const read = await readStage(entry.target);
      const stage = Number(typeof read === "object" && read !== null ? read.stage : read);
      if (!Number.isInteger(stage) || stage < 0 || stage >= entry.maxSteps) {
        throw coordinatorError(
          "TRANSPORT_START_STAGE_WITNESS_UNAVAILABLE",
          `target '${entry.id}' returned unavailable current_stage during sustained verification`,
          { targetId: entry.id, stage: Number.isFinite(stage) ? stage : null, read }
        );
      }
      return {
        targetId: entry.id,
        stage,
        progress: signedCircularDelta(stage, entry.startStage, entry.maxSteps),
        ...(typeof read === "object" && read !== null ? { read } : {})
      };
    }));
    samples.push({
      index: sampleIndex,
      elapsedMs: Math.max(0, now() - startedAt),
      targets: observed
    });
    if (sampleIndex + 1 < samplesRequired && intervalMs > 0) await wait(intervalMs);
  }

  const histories = new Map(cohort.map(({ id }) => [id, samples.map(({ targets }) =>
    targets.find(({ targetId }) => targetId === id)?.progress
  )]));
  const advances = cohort.map(({ id }) => {
    const history = histories.get(id) ?? [];
    return {
      targetId: id,
      minimum: Math.min(...history),
      maximum: Math.max(...history),
      advance: Math.max(...history) - Math.min(...history)
    };
  });
  const stalled = advances.filter(({ advance }) => advance < advanceRequired);
  if (stalled.length) {
    throw coordinatorError(
      "TRANSPORT_START_STAGE_NOT_ADVANCING",
      `transactional clients did not advance ${advanceRequired} stage${advanceRequired === 1 ? "" : "s"} during sustained verification`,
      { samples, advances, stalledTargetIds: stalled.map(({ targetId }) => targetId) }
    );
  }

  const pairOffsets = [];
  for (let first = 0; first < cohort.length; first += 1) {
    for (let second = first + 1; second < cohort.length; second += 1) {
      const firstEntry = cohort[first];
      const secondEntry = cohort[second];
      const firstHistory = histories.get(firstEntry.id) ?? [];
      const secondHistory = histories.get(secondEntry.id) ?? [];
      const offsets = firstHistory.map((value, index) => value - secondHistory[index]);
      pairOffsets.push({
        firstTargetId: firstEntry.id,
        secondTargetId: secondEntry.id,
        offsets,
        medianOffset: median(offsets)
      });
    }
  }
  const divergent = pairOffsets.filter(({ medianOffset }) => medianOffset !== 0);
  if (divergent.length) {
    throw coordinatorError(
      "TRANSPORT_START_SUSTAINED_STAGE_SKEW",
      "transactional clients diverged after the ACTIVE acknowledgement barrier",
      { samples, advances, pairOffsets, divergent }
    );
  }

  return {
    verified: true,
    sampleCount: samples.length,
    sampleIntervalMs: intervalMs,
    requiredAdvance: advanceRequired,
    elapsedMs: Math.max(0, now() - startedAt),
    samples,
    advances,
    pairOffsets
  };
}

function operationRequest(command, operationId) {
  const operation = exactInt(operationId, "operationId", 1, TRANSPORT_START_MAX_OPERATION_ID);
  return request(command, operation, 0, 0, 0, 0);
}

function request(command, operationId, startStage, maxSteps, clockInterval, expiryBeats) {
  return [
    TRANSPORT_START_PROTOCOL_VERSION,
    command,
    operationId,
    startStage,
    maxSteps,
    clockInterval,
    expiryBeats
  ];
}

function eventCodeFor(value) {
  if (Number.isInteger(value) && EVENT_NAMES[value]) return value;
  const code = TRANSPORT_START_EVENTS[String(value ?? "").trim().toLowerCase()];
  if (code) return code;
  throw new Error(`unsupported transactional transport start event '${String(value ?? "")}'`);
}

function normalizeCohort(targets) {
  if (!Array.isArray(targets)) return [];
  const ids = new Set();
  return targets.map((entry, index) => {
    const target = entry?.target ?? entry;
    const id = String(target?.id ?? entry?.id ?? `target-${index + 1}`);
    if (ids.has(id)) throw new Error(`duplicate transactional transport target '${id}'`);
    ids.add(id);
    if (!supportsTransactionalTransportStart(target)) {
      throw coordinatorError("TRANSPORT_START_UNSUPPORTED_COHORT", `target '${id}' does not expose transactional transport start`);
    }
    const maxSteps = exactInt(entry?.maxSteps, `${id}.maxSteps`, 1, 2147483647);
    return {
      id,
      target,
      maxSteps,
      startStage: exactInt(entry?.startStage, `${id}.startStage`, 0, maxSteps - 1),
      clockInterval: exactInt(entry?.clockInterval, `${id}.clockInterval`, 1, 2147483647)
    };
  });
}

async function sendToCohort(cohort, requestFor, sendRequest, sent) {
  return Promise.all(cohort.map(async (entry) => {
    const request = requestFor(entry);
    const write = await sendRequest(entry.target, request);
    const command = request[1] === TRANSPORT_START_COMMANDS.arm ? "arm" : "activate";
    sent.push({ targetId: entry.id, command, write });
    return { targetId: entry.id, request, write };
  }));
}

async function awaitCohortEvent(cohort, options) {
  const timeoutMs = boundedMilliseconds(options.timeoutMs, 5000, 0, 30000);
  const pollIntervalMs = boundedMilliseconds(options.pollIntervalMs, 50, 1, 1000);
  const startedAt = options.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let acknowledgements = [];
  do {
    attempts += 1;
    acknowledgements = await Promise.all(cohort.map(async (entry) => {
      const value = await options.readAcknowledgement(entry.target);
      const ack = validateTransportStartAck(value, {
        operationId: options.operationId,
        expectedEvent: options.expectedEvent
      });
      if (ack.ok && options.expectedStages && ack.stage !== entry.startStage) {
        return { targetId: entry.id, ...ack, ok: false, status: "stage-mismatch", expectedStage: entry.startStage };
      }
      return { targetId: entry.id, expectedStage: entry.startStage, ...ack };
    }));
    if (acknowledgements.every(({ ok }) => ok)) {
      return {
        verified: true,
        event: options.expectedEvent,
        acknowledgements,
        attemptCount: attempts,
        elapsedMs: Math.max(0, options.now() - startedAt)
      };
    }
    const terminal = acknowledgements.find(({ status }) => [
      "rejected",
      "version-mismatch",
      "unknown-event",
      "malformed",
      "stage-mismatch"
    ].includes(status));
    if (terminal) {
      throw coordinatorError(
        terminal.status === "stage-mismatch" ? "TRANSPORT_START_STAGE_MISMATCH" : "TRANSPORT_START_ACK_REJECTED",
        `target '${terminal.targetId}' returned ${terminal.status} while awaiting ${options.expectedEvent}`,
        { acknowledgements, expectedEvent: options.expectedEvent }
      );
    }
    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) break;
    await options.wait(Math.min(pollIntervalMs, remainingMs));
  } while (options.now() <= deadline);
  throw coordinatorError(
    "TRANSPORT_START_ACK_TIMEOUT",
    `transactional transport start timed out awaiting ${options.expectedEvent}`,
    { acknowledgements, expectedEvent: options.expectedEvent, attemptCount: attempts }
  );
}

function coordinatorError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function boundedMilliseconds(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function signedCircularDelta(value, reference, modulus) {
  const forward = ((value - reference) % modulus + modulus) % modulus;
  return forward > modulus / 2 ? forward - modulus : forward;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function exactInt(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return number;
}
