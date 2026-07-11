export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

export function snapBeat(value, subdivision) {
  const stepsPerBeat = Math.max(1, Math.round(Number(subdivision) || 1));
  return Math.round(Number(value) * stepsPerBeat) / stepsPerBeat;
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
  const subdivision = Math.max(1, Math.round(Number(options.subdivision) || 1));
  const minimumDuration = 1 / subdivision;
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
  const subdivision = Math.max(1, Math.round(Number(options.subdivision) || 1));
  const minimumDuration = Math.max(1 / subdivision, Number(options.minimumDuration) || 0);
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
