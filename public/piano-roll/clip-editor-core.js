export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

export function snapBeat(value, subdivision) {
  const stepsPerBeat = gridStepsPerBeat(subdivision);
  return Math.round(Number(value) * stepsPerBeat) / stepsPerBeat;
}

export function gridStepsPerBeat(subdivision) {
  return Math.max(1, (Number(subdivision) || 4) / 4);
}

export function playbackBeatForVoice(options = {}) {
  const executionBeat = executionBeatForVoice(options);
  if (Number.isFinite(executionBeat)) return executionBeat;

  const playback = options.playback;
  if (playback?.activeBlockId !== options.blockId) return undefined;
  const macroBeat = playback.beatIntoBlock == null ? NaN : Number(playback.beatIntoBlock);
  return playback.playing && Number.isFinite(macroBeat) ? macroBeat : undefined;
}

export function executionBeatForVoice(options = {}) {
  const location = executionLocationForVoice(options);
  return location?.blockId === options.blockId ? location.beat : undefined;
}

export function executionBlockForVoice(options = {}) {
  return executionLocationForVoice(options)?.blockId;
}

export function executionLocationForVoice(options = {}) {
  const targetId = options.assignment?.rnboTargetId;
  const target = (options.targets || []).find((entry) => entry.id === targetId);
  const contract = (options.contracts || []).find((entry) =>
    entry.targetId === targetId || entry.assignedVoiceId === options.voiceId
  );
  const blockId = String(target?.activeBlockId || target?.blockId || contract?.timing?.blockId || "");
  const projectedBeat = target?.projectedBeatIntoBlock == null ? NaN : Number(target.projectedBeatIntoBlock);
  const currentStage = target?.currentStage == null ? NaN : Number(target.currentStage);
  const stagesPerBeat = Number(target?.stagesPerBeat ?? target?.timing?.stagesPerBeat ?? contract?.timing?.stagesPerBeat);
  if (
    targetId
    && blockId
    && target?.online !== false
    && target?.fresh !== false
    && target?.available !== false
    && (Number.isFinite(projectedBeat) || (Number.isFinite(currentStage) && currentStage >= 0 && Number.isFinite(stagesPerBeat) && stagesPerBeat > 0))
  ) {
    return { blockId, beat: Number.isFinite(projectedBeat) ? projectedBeat : currentStage / stagesPerBeat };
  }
  return undefined;
}

export function sourceTimeForProjectedTime(projectedTime, clipDuration, playbackType = "looped") {
  const duration = Math.max(Number.EPSILON, Number(clipDuration));
  const projected = Math.max(0, Number(projectedTime));
  if (playbackType === "one-shot") {
    return { sourceTime: projected, occurrenceIndex: 0, alias: false };
  }
  const occurrenceIndex = Math.floor(projected / duration);
  return {
    sourceTime: projected % duration,
    occurrenceIndex,
    alias: occurrenceIndex > 0
  };
}

export function projectClipOccurrences(notes, options) {
  const clipDuration = Math.max(Number.EPSILON, Number(options.clipDuration));
  const timelineDuration = Math.max(clipDuration, Number(options.timelineDuration));
  const cycles = options.playbackType === "one-shot" ? 1 : Math.ceil(timelineDuration / clipDuration);
  const occurrences = [];
  notes.forEach((note, sourceIndex) => {
    for (let occurrenceIndex = 0; occurrenceIndex < cycles; occurrenceIndex += 1) {
      const startTime = Number(note.start_time) + occurrenceIndex * clipDuration;
      if (startTime >= timelineDuration) break;
      occurrences.push({
        sourceIndex,
        occurrenceIndex,
        alias: occurrenceIndex > 0,
        note: {
          ...note,
          start_time: startTime,
          duration: Math.min(Number(note.duration), timelineDuration - startTime)
        }
      });
    }
  });
  return occurrences;
}

export function moveNote(note, options) {
  const subdivision = Number(options.subdivision);
  const minimumDuration = 1 / gridStepsPerBeat(subdivision);
  const clipDuration = Math.max(minimumDuration, Number(options.clipDuration));
  return {
    ...note,
    start_time: clamp(
      snapBeat(Number(note.start_time) + Number(options.deltaTime), subdivision),
      0,
      Math.max(0, clipDuration - minimumDuration)
    ),
    pitch: clamp(Math.round(Number(note.pitch) + Number(options.deltaPitch)), 0, 127)
  };
}

export function resizeNoteRight(note, options) {
  const subdivision = Number(options.subdivision);
  const minimumDuration = Math.max(1 / gridStepsPerBeat(subdivision), Number(options.minimumDuration) || 0);
  const maximumDuration = Math.max(minimumDuration, Number(options.clipDuration) - Number(note.start_time));
  return {
    ...note,
    duration: clamp(
      snapBeat(Number(note.duration) + Number(options.deltaTime), subdivision),
      minimumDuration,
      maximumDuration
    )
  };
}

export function nudgeNote(note, options) {
  const step = 1 / gridStepsPerBeat(options.subdivision);
  if (options.resize && (options.direction === "left" || options.direction === "right")) {
    return resizeNoteRight(note, {
      deltaTime: options.direction === "left" ? -step : step,
      subdivision: options.subdivision,
      clipDuration: options.clipDuration,
      minimumDuration: options.minimumDuration
    });
  }
  const deltaTime = options.direction === "left" ? -step : options.direction === "right" ? step : 0;
  const deltaPitch = options.direction === "up" ? 1 : options.direction === "down" ? -1 : 0;
  return moveNote(note, {
    deltaTime,
    deltaPitch,
    subdivision: options.subdivision,
    clipDuration: options.clipDuration
  });
}

export function velocityFromLanePosition(y, laneHeight, padding = 4) {
  const usableHeight = Math.max(1, Number(laneHeight) - padding * 2);
  return clamp(Math.round(((Number(laneHeight) - padding - Number(y)) / usableHeight) * 127), 1, 127);
}

export function hitTestNotes(notes, options) {
  const matches = notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) =>
      Number(note.pitch) === Number(options.pitch)
      && Number(options.time) >= Number(note.start_time)
      && Number(options.time) <= Number(note.start_time) + Number(note.duration)
    );
  return matches.at(-1);
}

export function hitTestNoteEntries(entries, options) {
  return (entries || []).filter((entry) =>
    Number(entry?.note?.pitch) === Number(options.pitch)
    && Number(options.time) >= Number(entry.note.start_time)
    && Number(options.time) <= Number(entry.note.start_time) + Number(entry.note.duration)
  ).at(-1);
}

export function assignedClipId(assignment) {
  return typeof assignment === "string" ? assignment : assignment?.clipId || "";
}

export function playerClipReferences(score, clipId) {
  const references = [];
  for (const [blockId, block] of Object.entries(score?.mesostructure || {})) {
    for (const [playerId, assignment] of Object.entries(block?.players || {})) {
      if (assignedClipId(assignment) === clipId) references.push({ blockId, playerId });
    }
  }
  return references;
}

export function orchestrationDestinations(score, blockId, source = {}) {
  const block = score?.mesostructure?.[blockId];
  const players = [...new Set([
    ...Object.keys(score?.voices || {}),
    ...Object.keys(score?.assignments || {}),
    ...Object.keys(block?.players || {})
  ])];
  return players.map((playerId) => {
    const assignment = block?.players?.[playerId];
    const clipId = assignedClipId(assignment);
    const clip = clipId ? score?.clips?.[clipId] : undefined;
    let state = "ready";
    if (playerId === source.playerId) state = "current";
    else if (!clipId) state = "create";
    else if (!clip) state = "broken";
    else if (clipId === source.clipId) state = "same-clip";
    return {
      playerId,
      label: score?.assignments?.[playerId]?.label || playerId,
      clipId,
      state,
      references: clipId && clip ? playerClipReferences(score, clipId) : []
    };
  });
}
