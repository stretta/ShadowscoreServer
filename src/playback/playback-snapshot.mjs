const counters = new WeakMap();
const fallbackKey = {};

export function nextPlaybackSnapshotGeneration(runtime) {
  const key = runtime && typeof runtime === "object" ? runtime : fallbackKey;
  const generation = (counters.get(key) ?? 0) + 1;
  counters.set(key, generation);
  return generation;
}

export function buildPlaybackSnapshot({
  generation,
  observedAt = Date.now(),
  score = {},
  playback = {},
  jack = {},
  targets = [],
  timingContracts = [],
  sendQueue = {},
  lifecycleEvents = [],
  staleAfterMs = 1000
} = {}) {
  const observedAtMs = finiteNumber(observedAt, Date.now());
  const observedAtIso = new Date(observedAtMs).toISOString();
  const contractByTarget = new Map(timingContracts.map((contract) => [contract.targetId, contract]));
  const jackAuthoritative = jack?.status === "fresh" && playback?.witness?.source === "jack";
  const authoritativeBeat = jackAuthoritative ? finiteOrNull(playback.beatIntoBlock) : null;
  const targetSnapshots = {};

  for (const target of targets) {
    const targetId = String(target?.id ?? "").trim();
    if (!targetId) continue;
    const contract = contractByTarget.get(targetId)
      ?? timingContracts.find((entry) => entry.assignedVoiceId && entry.assignedVoiceId === target.voiceId);
    const stagesPerBeat = positiveOrNull(contract?.timing?.stagesPerBeat);
    const currentStage = finiteOrNull(target.currentStage);
    const beatIntoBlock = currentStage !== null && stagesPerBeat !== null
      ? currentStage / stagesPerBeat
      : null;
    const stateObservedAt = timestampMs(target.stateObservedAt ?? target.observedAt ?? target.lastSeenAt)
      ?? (currentStage === null ? null : observedAtMs);
    const stateAgeMs = stateObservedAt === null ? null : Math.max(0, observedAtMs - stateObservedAt);
    const sendStatus = target.sendStatus ?? null;
    const activeTransaction = sendStatus && Object.hasOwn(sendStatus, "activeTransaction")
      ? integerOrNull(sendStatus.activeTransaction)
      : integerOrNull(sendStatus?.ack?.transactionId ?? sendStatus?.transactionId);
    const preparedTransaction = integerOrNull(sendStatus?.preparedTransaction);

    targetSnapshots[targetId] = withoutUndefined({
      id: targetId,
      name: target.name,
      assignedVoiceId: contract?.assignedVoiceId || target.voiceId || "",
      hardwareUnitId: target.hardwareUnitId,
      hardwareUnitName: target.hardwareUnitName,
      online: target.available !== false,
      fresh: stateAgeMs === null ? target.available !== false : stateAgeMs <= staleAfterMs,
      currentStage,
      stagesPerBeat,
      beatIntoBlock,
      phaseErrorBeats: beatIntoBlock !== null && authoritativeBeat !== null
        ? beatIntoBlock - authoritativeBeat
        : null,
      phaseErrorStages: beatIntoBlock !== null && authoritativeBeat !== null && stagesPerBeat !== null
        ? (beatIntoBlock - authoritativeBeat) * stagesPerBeat
        : null,
      activeTransaction,
      preparedTransaction,
      queuedTransaction: queuedTransactionForTarget(sendQueue, targetId),
      payloadRevision: sendStatus?.payloadRevision ?? sendStatus?.scoreRevision ?? null,
      payloadHash: sendStatus?.payloadHash ?? null,
      blockId: sendStatus?.blockId ?? contract?.timing?.blockId ?? playback.activeBlockId ?? "",
      noteCount: sendStatus?.noteCount ?? contract?.noteCount ?? 0,
      transmittedRowCount: sendStatus?.transmittedRowCount ?? contract?.transmittedRowCount ?? 0,
      preparationDurationMs: sendStatus?.preparationDurationMs ?? null,
      acknowledgement: sendStatus?.ack ?? null,
      activationAcknowledgementAt: sendStatus?.activationAcknowledgementAt ?? null,
      activationAcknowledgement: sendStatus?.activationAck ?? null,
      stateObservedAt: stateObservedAt === null ? null : new Date(stateObservedAt).toISOString(),
      stateAgeMs,
      stageReadbackStatus: target.stageReadbackStatus ?? (currentStage === null ? "unavailable" : "fresh"),
      stageReadbackError: target.stageReadbackError ?? "",
      timing: contract?.timing ?? null
    });
  }

  return {
    generation: Math.max(1, Math.trunc(finiteNumber(generation, 1))),
    observedAt: observedAtIso,
    scoreRevision: score.scoreRevision ?? score.version ?? 0,
    structureRevision: score.structureRevision ?? 0,
    transport: {
      authority: "jack",
      running: Boolean(playback.running),
      tempo: finiteOrNull(jack?.latest?.beatsPerMinute ?? playback?.witness?.tempo),
      macroIndex: playback.macroIndex ?? score.structureState?.macroIndex ?? 0,
      blockId: playback.activeBlockId ?? score.structureState?.activeBlockId ?? "",
      beatIntoBlock: authoritativeBeat,
      compositionBeat: finiteOrNull(playback.compositionBeat),
      fresh: jackAuthoritative,
      ageMs: finiteOrNull(jack?.ageMs),
      jack
    },
    playback: {
      ...playback,
      playing: Boolean(playback.running)
    },
    targets: targetSnapshots,
    timingContracts,
    sendQueue,
    lifecycleEvents: lifecycleEvents.slice(-100)
  };
}

function queuedTransactionForTarget(sendQueue, targetId) {
  if (sendQueue?.active?.targetId === targetId) return integerOrNull(sendQueue.active.transactionId);
  if (sendQueue?.queuedRequest?.targetId === targetId) return integerOrNull(sendQueue.queuedRequest.transactionId);
  return null;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
