import { deriveMacroPosition, macroTimeline } from "../playback/macro-playback.mjs";

export const TRANSPORT_OBJECT_ID = "transport";

export const transportObjectDescriptor = Object.freeze({
  id: TRANSPORT_OBJECT_ID,
  path: "shadow_score transport",
  type: "ShadowScoreTransport",
  properties: Object.freeze([
    "is_playing",
    "position_beats",
    "position_seconds",
    "position_fraction",
    "position_bbt",
    "duration_beats",
    "duration_seconds",
    "tempo",
    "time_signature_numerator",
    "time_signature_denominator",
    "active_section",
    "sync"
  ]),
  methods: Object.freeze([
    "play",
    "stop",
    "return_to_start",
    "locate_beats",
    "locate_fraction",
    "set_tempo",
    "previous_section",
    "next_section",
    "re_sync"
  ])
});

export function buildAuthoritativeTransportState({
  score = {},
  playbackSnapshot = {},
  revision = 1,
  observedAt = playbackSnapshot.observedAt ?? new Date().toISOString()
} = {}) {
  const timeline = macroTimeline(score);
  const transport = playbackSnapshot.transport ?? {};
  const playback = playbackSnapshot.playback ?? {};
  const controls = playbackSnapshot.controls ?? {};
  const playing = Boolean(controls.players?.playing ?? transport.running ?? playback.running);
  const locatedBeat = locatedCompositionBeat(score, controls.position, timeline);
  const fallbackBeat = locatedBeat ?? fallbackCompositionBeat(score, playing ? playback : {}, timeline);
  const rawBeat = playing
    ? finiteOrNull(transport.compositionBeat ?? playback.compositionBeat) ?? fallbackBeat
    : fallbackBeat;
  const position = deriveMacroPosition(score, rawBeat);
  const positionBeats = clamp(position.cycleBeat, 0, timeline.totalBeats);
  const durationSeconds = secondsAtBeat(score, timeline.totalBeats);
  const positionSeconds = secondsAtBeat(score, positionBeats);
  const timeSignature = score.context?.clip?.TimeSignature ?? {};
  const numerator = positiveInteger(timeSignature.numerator, 4);
  const denominator = positiveInteger(timeSignature.denominator, 4);
  const tempo = positiveNumber(
    playbackSnapshot.tempo?.live
      ?? transport.tempo
      ?? score.mesostructure?.[position.activeBlockId]?.tempo,
    120
  );
  const sync = deriveSyncHealth(playbackSnapshot);
  if (controls.players?.syncRecovery) sync.recovery = controls.players.syncRecovery;
  return {
    object_id: TRANSPORT_OBJECT_ID,
    path: "shadow_score transport",
    type: "ShadowScoreTransport",
    revision: positiveInteger(revision, 1),
    observed_at: new Date(observedAt).toISOString(),
    authority: "server",
    clock_source: transport.authority ?? "jack",
    is_playing: playing,
    position_beats: round(positionBeats, 6),
    position_seconds: round(positionSeconds, 3),
    position_fraction: timeline.totalBeats > 0 ? round(positionBeats / timeline.totalBeats, 8) : 0,
    position_bbt: beatToBbt(positionBeats, numerator),
    duration_beats: round(timeline.totalBeats, 6),
    duration_seconds: round(durationSeconds, 3),
    tempo: round(tempo, 3),
    time_signature_numerator: numerator,
    time_signature_denominator: denominator,
    active_section: position.activeBlockId,
    macro_index: position.macroIndex,
    beat_into_section: round(position.beatIntoBlock, 6),
    arrangement: {
      requested_mode: controls.arrangement?.requestedMode ?? "run",
      running: Boolean(controls.arrangement?.running ?? playback.running),
      sections: timeline.entries.map((entry) => ({
        id: entry.blockId,
        index: entry.index,
        start_beat: entry.startBeat,
        end_beat: entry.endBeat,
        tempo: positiveNumber(score.mesostructure?.[entry.blockId]?.tempo, tempo)
      }))
    },
    sync,
    capabilities: {
      can_play: true,
      can_stop: true,
      can_locate: timeline.totalBeats > 0,
      can_set_tempo: true,
      can_re_sync: true
    }
  };
}

export function resolveTransportLocation(score, request = {}) {
  const timeline = macroTimeline(score);
  if (!timeline.entries.length || timeline.totalBeats <= 0) {
    throw new Error("arrangement has no playable duration");
  }
  const hasFraction = request.fraction !== undefined;
  const field = hasFraction ? "fraction" : "beats";
  const value = Number(request[field]);
  const maximum = hasFraction ? 1 : timeline.totalBeats;
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${field} must be between 0 and ${maximum}`);
  }
  // The arrangement is cyclic. Keep an exact right-edge gesture in the last
  // playable instant instead of wrapping it back to the first section.
  const requestedBeat = hasFraction ? value * timeline.totalBeats : value;
  const compositionBeat = requestedBeat >= timeline.totalBeats
    ? Math.max(0, timeline.totalBeats - 0.000001)
    : requestedBeat;
  const position = deriveMacroPosition(score, compositionBeat);
  return {
    compositionBeat,
    positionFraction: compositionBeat / timeline.totalBeats,
    macroIndex: position.macroIndex,
    activeBlockId: position.activeBlockId,
    beatIntoBlock: position.beatIntoBlock,
    durationBeats: timeline.totalBeats
  };
}

export function secondsAtBeat(score, targetBeat) {
  const timeline = macroTimeline(score);
  const limit = clamp(Number(targetBeat) || 0, 0, timeline.totalBeats);
  let seconds = 0;
  for (const entry of timeline.entries) {
    if (limit <= entry.startBeat) break;
    const beats = Math.min(limit, entry.endBeat) - entry.startBeat;
    const tempo = positiveNumber(score.mesostructure?.[entry.blockId]?.tempo, 120);
    seconds += beats * 60 / tempo;
    if (limit <= entry.endBeat) break;
  }
  return seconds;
}

export function beatToBbt(positionBeats, beatsPerBar = 4, ticksPerBeat = 960) {
  const beat = Math.max(0, Number(positionBeats) || 0);
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = beat - ((bar - 1) * beatsPerBar);
  const beatNumber = Math.floor(beatInBar) + 1;
  const tick = Math.floor((beatInBar - Math.floor(beatInBar)) * ticksPerBeat);
  return `${bar}.${beatNumber}.${String(tick).padStart(3, "0")}`;
}

export function deriveSyncHealth(playbackSnapshot = {}) {
  const targets = Object.values(playbackSnapshot.targets ?? {}).filter((target) => target.assignedVoiceId);
  const online = targets.filter((target) => target.online !== false);
  const fresh = online.filter((target) => target.fresh !== false && target.stageReadbackStatus !== "unavailable");
  const phaseErrors = fresh.map((target) => Math.abs(Number(target.phaseErrorBeats))).filter(Number.isFinite);
  const maxPhaseErrorBeats = phaseErrors.length ? Math.max(...phaseErrors) : null;
  // A complete stage is musically significant: at four stages per beat it is
  // the quarter-beat displacement that turns a chord into an arpeggio. Keep
  // enough margin for timestamp/readback jitter, but never accept a whole
  // stage as aligned.
  const resolutionToleranceBeats = Math.max(0.05, ...fresh.map((target) => {
    const stagesPerBeat = Number(target.stagesPerBeat ?? target.timing?.stagesPerBeat);
    return Number.isFinite(stagesPerBeat) && stagesPerBeat > 0 ? 0.75 / stagesPerBeat : 0;
  }));
  // Inter-player skew compares like-for-like stage witnesses and remains
  // stage-strict. Server offset compares those discrete, network-polled
  // witnesses with continuous JACK BBT, so allow the bounded observation
  // uncertainty without hiding a musically meaningful half-beat displacement.
  const serverOffsetToleranceBeats = Math.max(resolutionToleranceBeats, 0.5);
  const maxClientSkewBeats = clientPhaseSkew(fresh);
  const queueBusy = Boolean(playbackSnapshot.sendQueue?.inProgress || playbackSnapshot.sendQueue?.queued);
  let state = "aligned";
  let reason = "All observed players are within the phase tolerance.";
  if (!targets.length) {
    state = "unavailable";
    reason = "No assigned players are available for sync observation.";
  } else if (queueBusy) {
    state = "preparing";
    reason = "Player score transfer is still in progress.";
  } else if (online.length < targets.length) {
    state = "degraded";
    reason = `${targets.length - online.length} assigned player${targets.length - online.length === 1 ? " is" : "s are"} offline.`;
  } else if (fresh.length < online.length) {
    state = "stale";
    reason = `${online.length - fresh.length} player phase witness${online.length - fresh.length === 1 ? " is" : "es are"} stale.`;
  } else if (maxClientSkewBeats !== null && maxClientSkewBeats > resolutionToleranceBeats) {
    state = "slipped";
    reason = `Maximum inter-player skew is ${round(maxClientSkewBeats, 3)} beats.`;
  } else if (maxPhaseErrorBeats !== null && maxPhaseErrorBeats > serverOffsetToleranceBeats) {
    state = "offset";
    reason = `Players agree with each other but are offset ${round(maxPhaseErrorBeats, 3)} beats from the server clock.`;
  } else if (maxPhaseErrorBeats === null && maxClientSkewBeats === null) {
    state = "uncertain";
    reason = "Player phase witnesses are not comparable to the server clock.";
  }
  return {
    state,
    reason,
    assigned_players: targets.length,
    online_players: online.length,
    fresh_players: fresh.length,
    max_phase_error_beats: maxPhaseErrorBeats === null ? null : round(maxPhaseErrorBeats, 6),
    max_client_skew_beats: maxClientSkewBeats === null ? null : round(maxClientSkewBeats, 6),
    tolerance_beats: round(resolutionToleranceBeats, 6),
    server_offset_tolerance_beats: round(serverOffsetToleranceBeats, 6),
    re_sync_recommended: state === "slipped" || state === "offset"
  };
}

function clientPhaseSkew(targets) {
  if (targets.length < 2) return null;
  const reference = targets.find((target) => finiteOrNull(target.projectedBeatIntoBlock ?? target.beatIntoBlock) !== null);
  if (!reference) return null;
  const referenceBeat = finiteOrNull(reference.projectedBeatIntoBlock ?? reference.beatIntoBlock);
  const referenceCycle = targetCycleBeats(reference);
  const differences = targets.map((target) => {
    const beat = finiteOrNull(target.projectedBeatIntoBlock ?? target.beatIntoBlock);
    const cycle = targetCycleBeats(target);
    if (beat === null || referenceBeat === null || cycle === null || referenceCycle === null || Math.abs(cycle - referenceCycle) > 0.000001) return null;
    return Math.abs(signedCircularDifference(beat, referenceBeat, cycle));
  }).filter((value) => value !== null);
  return differences.length > 1 ? Math.max(...differences) : null;
}

function targetCycleBeats(target) {
  const stagesPerBeat = positiveNumber(target.stagesPerBeat ?? target.timing?.stagesPerBeat, 0);
  const patternLength = positiveNumber(target.timing?.patternLength, 0);
  return stagesPerBeat > 0 && patternLength > 0 ? patternLength / stagesPerBeat : null;
}

function signedCircularDifference(value, reference, cycle) {
  const shifted = (value - reference) + (cycle / 2);
  return (((shifted % cycle) + cycle) % cycle) - (cycle / 2);
}

function fallbackCompositionBeat(score, playback, timeline) {
  const macroIndex = Number(playback.macroIndex ?? score.structureState?.macroIndex ?? 0);
  const entry = timeline.entries.find((candidate) => candidate.index === macroIndex)
    ?? timeline.entries.find((candidate) => candidate.blockId === score.structureState?.activeBlockId)
    ?? timeline.entries[0];
  return (entry?.startBeat ?? 0) + Math.max(0, Number(playback.beatIntoBlock) || 0);
}

function locatedCompositionBeat(score, position, timeline) {
  const beat = finiteOrNull(position?.compositionBeat);
  const macroIndex = Number(position?.macroIndex);
  const blockId = String(position?.activeBlockId ?? "");
  if (beat === null || !Number.isInteger(macroIndex)) return null;
  if (macroIndex !== Number(score.structureState?.macroIndex) || blockId !== String(score.structureState?.activeBlockId ?? "")) return null;
  return clamp(beat, 0, timeline.totalBeats);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
