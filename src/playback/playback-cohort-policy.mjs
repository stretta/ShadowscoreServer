const READY_STATES = new Set(["active", "prepared"]);

export function evaluatePreparedPlaybackCohort(options = {}) {
  const states = [...(options.states ?? [])];
  const availability = [...(options.availability ?? [])];
  const assignedVoiceIds = [...new Set(options.assignedVoiceIds ?? [])];
  const assignedVoiceIdSet = new Set(assignedVoiceIds);
  const assignedStates = states.filter((state) => !state.voiceId || assignedVoiceIdSet.has(state.voiceId));
  const unavailableStates = assignedStates.filter((state) => state.state === "unavailable");
  const participatingStates = assignedStates.filter((state) => state.state !== "unavailable");
  const unavailableVoiceIds = new Set([
    ...availability
      .filter((record) => record.available === false)
      .map((record) => record.voiceId),
    ...unavailableStates.map((state) => state.voiceId)
  ].filter(Boolean));
  const participatingVoiceIds = assignedVoiceIds.filter((voiceId) => !unavailableVoiceIds.has(voiceId));
  const observedVoiceIds = new Set(participatingStates.map((state) => state.voiceId).filter(Boolean));
  const missingVoiceIds = participatingVoiceIds.filter((voiceId) => !observedVoiceIds.has(voiceId));
  const invalidStates = participatingStates.filter((state) => !READY_STATES.has(state.state));
  const degraded = unavailableVoiceIds.size > 0;

  let decision = "ready";
  if (!participatingVoiceIds.length) decision = "no-targets";
  else if (!participatingStates.length || missingVoiceIds.length || invalidStates.length) decision = "not-ready";
  else if (participatingStates.every((state) => state.state === "active" && !hasUnpromotedPreparation(state))) decision = "already-active";

  return {
    decision,
    ready: ["ready", "already-active"].includes(decision),
    degraded,
    participatingStates,
    preparedStates: participatingStates.filter((state) => state.state === "prepared" || hasUnpromotedPreparation(state)),
    unavailableVoiceIds: [...unavailableVoiceIds],
    participatingVoiceIds,
    missingVoiceIds,
    invalidStates,
    participatingTargetCount: participatingStates.length,
    unavailableTargetCount: unavailableVoiceIds.size
  };
}

export function playbackActivationPolicy(updates = [], assignedVoiceIds = null) {
  const assigned = Array.isArray(assignedVoiceIds) ? new Set(assignedVoiceIds) : null;
  const relevant = assigned
    ? updates.filter((update) => !update.voiceId || assigned.has(update.voiceId))
    : updates;
  const participating = relevant.filter((update) => update.state !== "unavailable");
  const unavailable = relevant.filter((update) => update.state === "unavailable");
  const pending = participating.filter((update) => update.state !== "active" || hasUnpromotedPreparation(update));
  return {
    participating,
    unavailable,
    pending,
    reusable: participating.every((update) => READY_STATES.has(update.state)),
    degraded: unavailable.length > 0
  };
}

export function activationActionForState(state) {
  if (state === "active") return "active";
  return "activation-failed";
}

function hasUnpromotedPreparation(state = {}) {
  return Number.isInteger(state.preparedTransaction)
    && state.preparedTransaction !== state.activeTransaction;
}
