import { EventEmitter } from "node:events";

export function createInitialScore(config) {
  const voices = {};
  for (const voiceId of config.ensemble.voices) {
    voices[voiceId] = {
      version: 0,
      notes: []
    };
  }

  return {
    ensembleId: config.ensemble.id,
    version: 0,
    context: createDefaultContext(),
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
    replaceVoiceNotes(voiceId, notesDocument) {
      if (!score.voices[voiceId]) {
        const known = Object.keys(score.voices).join(", ");
        throw new Error(`unknown voice '${voiceId}'. Known voices: ${known}`);
      }
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
