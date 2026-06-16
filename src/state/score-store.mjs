import { EventEmitter } from "node:events";

export function createInitialScore(config) {
  const voices = {};
  const assignments = {};
  for (const voiceId of config.ensemble.voices) {
    voices[voiceId] = {
      version: 0,
      notes: []
    };
    assignments[voiceId] = createEmptyAssignment();
  }

  return {
    ensembleId: config.ensemble.id,
    version: 0,
    context: createDefaultContext(),
    assignments,
    voices
  };
}

export function createScoreStore(initialScore) {
  const events = new EventEmitter();
  let score = structuredClone(initialScore);

  return {
    events,
    getScore() {
      return structuredClone(score);
    },
    updateContext(nextContext, options = {}) {
      score = {
        ...score,
        version: score.version + 1,
        context: options.replace ? structuredClone(nextContext) : deepMerge(score.context, nextContext)
      };
      emitChange(events, "context.updated", score, { context: score.context });
      return structuredClone(score);
    },
    replaceVoiceAssignment(voiceId, assignmentDocument) {
      assertKnownVoice(score, voiceId);
      const assignment = normalizeAssignment(assignmentDocument);
      score = {
        ...score,
        version: score.version + 1,
        assignments: {
          ...ensureAssignments(score),
          [voiceId]: assignment
        }
      };
      emitChange(events, "voice.assignment.replaced", score, { voiceId, assignment });
      return structuredClone(score);
    },
    clearVoiceAssignment(voiceId) {
      assertKnownVoice(score, voiceId);
      const assignment = createEmptyAssignment();
      score = {
        ...score,
        version: score.version + 1,
        assignments: {
          ...ensureAssignments(score),
          [voiceId]: assignment
        }
      };
      emitChange(events, "voice.assignment.cleared", score, { voiceId, assignment });
      return structuredClone(score);
    },
    replaceVoiceNotes(voiceId, notesDocument) {
      assertKnownVoice(score, voiceId);
      const notes = normalizeNotesDocument(notesDocument);
      score = {
        ...score,
        version: score.version + 1,
        voices: {
          ...score.voices,
          [voiceId]: {
            version: score.voices[voiceId].version + 1,
            notes
          }
        }
      };
      emitChange(events, "voice.notes.replaced", score, { voiceId, notes });
      return structuredClone(score);
    },
    reset(options = {}) {
      if (!options.context && !options.voices && !options.assignments) {
        throw new Error("reset must include at least one of context, voices, or assignments");
      }
      const voices = options.voices ? resetVoices(score.voices) : score.voices;
      const assignments = options.assignments ? resetAssignments(score.voices) : ensureAssignments(score);
      score = {
        ...score,
        version: score.version + 1,
        context: options.context ? createDefaultContext() : score.context,
        assignments,
        voices
      };
      emitChange(events, "admin.reset", score, {
        context: Boolean(options.context),
        voices: Boolean(options.voices),
        assignments: Boolean(options.assignments)
      });
      return structuredClone(score);
    }
  };
}

function createDefaultContext() {
  return {
    clip: {},
    scale: {},
    grid: {},
    seed: 0
  };
}

function normalizeNotesDocument(notesDocument) {
  if (Array.isArray(notesDocument)) {
    return structuredClone(notesDocument);
  }
  if (notesDocument && Array.isArray(notesDocument.notes)) {
    return structuredClone(notesDocument.notes);
  }
  throw new Error("notes body must be an array or an object with a notes array");
}

function normalizeAssignment(assignmentDocument) {
  if (!assignmentDocument || typeof assignmentDocument !== "object" || Array.isArray(assignmentDocument)) {
    throw new Error("assignment body must be an object");
  }

  return {
    assignee: stringField(assignmentDocument.assignee ?? assignmentDocument.playerName),
    deviceId: stringField(assignmentDocument.deviceId),
    clientId: nullableStringField(assignmentDocument.clientId),
    label: stringField(assignmentDocument.label),
    color: stringField(assignmentDocument.color),
    locked: Boolean(assignmentDocument.locked)
  };
}

function createEmptyAssignment() {
  return {
    assignee: "",
    deviceId: "",
    clientId: null,
    label: "",
    color: "",
    locked: false
  };
}

function ensureAssignments(score) {
  return {
    ...resetAssignments(score.voices),
    ...(score.assignments ?? {})
  };
}

function resetAssignments(voices) {
  return Object.fromEntries(Object.keys(voices).map((voiceId) => [voiceId, createEmptyAssignment()]));
}

function resetVoices(voices) {
  return Object.fromEntries(
    Object.entries(voices).map(([voiceId, voice]) => [
      voiceId,
      {
        version: voice.version + 1,
        notes: []
      }
    ])
  );
}

function assertKnownVoice(score, voiceId) {
  if (!score.voices[voiceId]) {
    const known = Object.keys(score.voices).join(", ");
    throw new Error(`unknown voice '${voiceId}'. Known voices: ${known}`);
  }
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nullableStringField(value) {
  const stringValue = stringField(value);
  return stringValue ? stringValue : null;
}

function emitChange(events, type, score, detail) {
  events.emit("change", {
    type,
    version: score.version,
    detail,
    score: structuredClone(score)
  });
}

function deepMerge(base, override) {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
