export function rnboScoreDeliveryProfile(config = {}, target = {}, attempt = 0) {
  const requestedBatchSize = clampInt(config.rnbo?.sendBatchSize ?? 1, 1, 1, 64);
  const capability = target.capabilities ?? {};
  const acknowledgementEnabled = config.rnbo?.ack?.enabled === undefined
    ? config.rnbo?.oscQuery?.enabled === true
    : config.rnbo.ack.enabled === true;
  const bounded = capability.boundedScoreBatchIngestion === true
    && capability.scoreBatchAcknowledgement === "commit"
    && acknowledgementEnabled;
  const receiverMaxBatchSize = bounded
    ? clampInt(capability.maxScoreBatchRows ?? 1, 1, 1, 64)
    : 1;
  const initialBatchSize = Math.min(requestedBatchSize, receiverMaxBatchSize);
  const baseDelayMs = clampInt(config.rnbo?.sendDelayMs ?? 0, 0, 0, 10000);
  const divisor = 2 ** Math.max(0, attempt);
  const multiplier = 2 ** Math.max(0, attempt);
  const maxDelayMs = clampInt(config.rnbo?.maxRetryDelayMs ?? 20, 20, 0, 10000);
  return {
    attempt,
    batchSize: Math.max(1, Math.ceil(initialBatchSize / divisor)),
    delayMs: Math.min(maxDelayMs, baseDelayMs * multiplier),
    mode: attempt === 0 ? "normal" : "conservative-retry"
  };
}

export function rnboFlowControlEvidence(config = {}, target = {}, deliveryProfile = {}) {
  const capability = target.capabilities ?? {};
  return {
    requestedBatchSize: clampInt(config.rnbo?.sendBatchSize ?? 1, 1, 1, 64),
    effectiveBatchSize: clampInt(deliveryProfile.batchSize ?? 1, 1, 1, 64),
    boundedIngestionAdvertised: capability.boundedScoreBatchIngestion === true,
    receiverMaxBatchSize: clampInt(capability.maxScoreBatchRows ?? 1, 1, 1, 64),
    acknowledgement: capability.scoreBatchAcknowledgement === "commit" ? "commit" : "none"
  };
}

function clampInt(value, fallback, min, max) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
