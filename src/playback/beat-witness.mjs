export function jackBeatWitness(transport) {
  const latest = transport?.latest;
  if (!latest) {
    return unusableWitness("jack", "no JACK snapshot");
  }
  if (transport?.status !== "fresh") {
    return unusableWitness("jack", transport?.reason || `JACK snapshot ${transport?.status || "unusable"}`);
  }
  if (latest.bbtValid !== true) {
    return unusableWitness("jack", "JACK BBT invalid");
  }
  if (latest.state !== "rolling") {
    return unusableWitness("jack", `JACK transport ${latest.state || "not rolling"}`);
  }
  if (!Number.isFinite(latest.absoluteBeat)) {
    return unusableWitness("jack", "JACK absolute beat unavailable");
  }
  return {
    source: "jack",
    usable: true,
    absoluteBeat: latest.absoluteBeat,
    tempo: Number.isFinite(latest.beatsPerMinute) ? latest.beatsPerMinute : null,
    fresh: true,
    reason: ""
  };
}

export function timerBeatWitness({ running = false, mode = "stopped" } = {}) {
  return {
    source: "timer",
    usable: running && mode === "timer",
    absoluteBeat: null,
    tempo: null,
    fresh: running && mode === "timer",
    degraded: true,
    reason: running && mode === "timer" ? "wall-clock fallback" : "timer fallback inactive"
  };
}

export function rnboClientBeatWitness({ targets = [], contracts = [], maxSkewBeats = 0.25 } = {}) {
  const contractByTargetId = new Map(contracts.map((contract) => [contract.targetId, contract]));
  const candidates = [];
  for (const target of targets) {
    const currentStage = Number(target?.currentStage);
    if (!Number.isFinite(currentStage)) {
      continue;
    }
    const contract = contractByTargetId.get(target.id) ?? contracts.find((entry) => entry.assignedVoiceId);
    const stagesPerBeat = Number(contract?.timing?.stagesPerBeat);
    if (!Number.isFinite(stagesPerBeat) || stagesPerBeat <= 0) {
      continue;
    }
    candidates.push(withoutUndefined({
      targetId: target.id ?? "",
      assignedVoiceId: contract?.assignedVoiceId || undefined,
      currentStage,
      stagesPerBeat,
      absoluteBeat: currentStage / stagesPerBeat
    }));
  }

  if (!candidates.length) {
    return unusableWitness("rnbo-client", "no RNBO current_stage readback");
  }

  const assigned = candidates.filter((candidate) => candidate.assignedVoiceId);
  const comparable = assigned.length ? assigned : candidates;
  const minBeat = Math.min(...comparable.map((candidate) => candidate.absoluteBeat));
  const maxBeat = Math.max(...comparable.map((candidate) => candidate.absoluteBeat));
  const skewBeats = maxBeat - minBeat;
  const skewLimit = finiteNonNegative(maxSkewBeats, 0.25);
  if (comparable.length > 1 && skewBeats > skewLimit) {
    return {
      source: "rnbo-client",
      usable: false,
      absoluteBeat: null,
      tempo: null,
      fresh: false,
      reason: `RNBO current_stage skew ${formatNumber(skewBeats)} beats exceeds ${formatNumber(skewLimit)}`,
      skewBeats,
      maxSkewBeats: skewLimit,
      targetCount: comparable.length
    };
  }

  const selected = comparable[0];
  return withoutUndefined({
    source: "rnbo-client",
    usable: true,
    absoluteBeat: selected.absoluteBeat,
    tempo: null,
    fresh: true,
    targetId: selected.targetId,
    assignedVoiceId: selected.assignedVoiceId,
    currentStage: selected.currentStage,
    stagesPerBeat: selected.stagesPerBeat,
    skewBeats,
    targetCount: comparable.length,
    reason: selected.assignedVoiceId ? "assigned RNBO current_stage readback" : "RNBO current_stage readback"
  });
}

export function selectBeatWitness({
  mode = "stopped",
  running = false,
  jackTransport,
  rnboTargets = [],
  timingContracts = [],
  rnboClient = {}
} = {}) {
  const candidates = beatWitnessCandidates({
    mode,
    running,
    jackTransport,
    rnboTargets,
    timingContracts,
    rnboClient
  });
  return candidates.find((candidate) => candidate.usable)
    ?? candidates.find((candidate) => candidate.source === "rnbo-client" && candidate.reason !== "no RNBO current_stage readback")
    ?? candidates[0];
}

export function beatWitnessCandidates({
  mode = "stopped",
  running = false,
  jackTransport,
  rnboTargets = [],
  timingContracts = [],
  rnboClient = {}
} = {}) {
  if (!running && mode === "stopped") {
    return [{
      source: "none",
      usable: false,
      absoluteBeat: null,
      tempo: null,
      fresh: false,
      reason: "macro playback stopped"
    }];
  }

  const jack = jackBeatWitness(jackTransport);
  const rnboClientWitness = rnboClientBeatWitness({
    targets: rnboTargets,
    contracts: timingContracts,
    maxSkewBeats: rnboClient.maxSkewBeats
  });
  const timer = timerBeatWitness({ running, mode });

  if (mode === "timer") {
    return [timer, jack, rnboClientWitness];
  }
  return [jack, rnboClientWitness, timer];
}

function unusableWitness(source, reason) {
  return {
    source,
    usable: false,
    absoluteBeat: null,
    tempo: null,
    fresh: false,
    reason
  };
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
