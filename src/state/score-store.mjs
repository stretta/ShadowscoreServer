import { EventEmitter } from "node:events";

export function createInitialScore(config) {
  const voices = {};
  const assignments = {};
  for (const voiceId of config.ensemble.voices) {
    voices[voiceId] = {
      version: 0,
      notes: []
    };
    assignments[voiceId] = createEmptyAssignment(config.ensemble.assignmentDefaults?.[voiceId]);
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
  const assignmentDefaults = structuredClone(initialScore.assignments ?? {});

  return {
    events,
    getScore() {
      return structuredClone(score);
    },
    addVoice(voiceId, assignmentDocument = {}, options = {}) {
      const id = normalizeVoiceId(voiceId);
      if (score.voices[id]) {
        throw new Error(`voice '${id}' already exists`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const assignment = normalizeAssignment({
        ...assignmentDefaults[id],
        ...assignmentDocument
      });
      score = {
        ...score,
        version: score.version + 1,
        assignments: {
          ...ensureAssignments(score, assignmentDefaults),
          [id]: assignment
        },
        voices: {
          ...score.voices,
          [id]: {
            version: 0,
            notes: []
          }
        }
      };
      emitChange(events, "voice.added", score, { voiceId: id, assignment }, options);
      return structuredClone(score);
    },
    removeVoice(voiceId, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const nextVoices = { ...score.voices };
      const nextAssignments = { ...ensureAssignments(score, assignmentDefaults) };
      delete nextVoices[voiceId];
      delete nextAssignments[voiceId];
      score = {
        ...score,
        version: score.version + 1,
        assignments: nextAssignments,
        voices: nextVoices
      };
      emitChange(events, "voice.removed", score, { voiceId }, options);
      return structuredClone(score);
    },
    updateContext(nextContext, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      score = {
        ...score,
        version: score.version + 1,
        context: options.replace ? structuredClone(nextContext) : deepMerge(score.context, nextContext)
      };
      emitChange(events, "context.updated", score, { context: score.context }, options);
      return structuredClone(score);
    },
    replaceVoiceAssignment(voiceId, assignmentDocument, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const assignment = normalizeAssignment(assignmentDocument);
      score = {
        ...score,
        version: score.version + 1,
        assignments: {
          ...ensureAssignments(score),
          [voiceId]: assignment
        }
      };
      emitChange(events, "voice.assignment.replaced", score, { voiceId, assignment }, options);
      return structuredClone(score);
    },
    clearVoiceAssignment(voiceId, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const assignment = createEmptyAssignment(assignmentDefaults[voiceId]);
      score = {
        ...score,
        version: score.version + 1,
        assignments: {
          ...ensureAssignments(score),
          [voiceId]: assignment
        }
      };
      emitChange(events, "voice.assignment.cleared", score, { voiceId, assignment }, options);
      return structuredClone(score);
    },
    applyAssignmentPreset(assignmentsDocument, options = {}) {
      if (!assignmentsDocument || typeof assignmentsDocument !== "object" || Array.isArray(assignmentsDocument)) {
        throw new Error("assignment preset must be an object");
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const nextAssignments = { ...ensureAssignments(score, assignmentDefaults) };
      for (const [voiceId, assignmentDocument] of Object.entries(assignmentsDocument)) {
        assertKnownVoice(score, voiceId);
        nextAssignments[voiceId] = normalizeAssignment({
          ...nextAssignments[voiceId],
          ...assignmentDocument
        });
      }
      score = {
        ...score,
        version: score.version + 1,
        assignments: nextAssignments
      };
      emitChange(events, "voice.assignment.preset.applied", score, { presetId: options.presetId ?? "" }, options);
      return structuredClone(score);
    },
    replaceVoiceNotes(voiceId, notesDocument, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedVoiceVersion(score, voiceId, options.expectedVoiceVersion);
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
      emitChange(events, "voice.notes.replaced", score, { voiceId, notes }, options);
      return structuredClone(score);
    },
    reset(options = {}) {
      if (!options.context && !options.voices && !options.assignments) {
        throw new Error("reset must include at least one of context, voices, or assignments");
      }
      const voices = options.voices ? resetVoices(score.voices) : score.voices;
      const assignments = options.assignments ? resetAssignments(score.voices, assignmentDefaults) : ensureAssignments(score, assignmentDefaults);
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
      }, options);
      return structuredClone(score);
    },
    restore(nextScore, options = {}) {
      const restored = normalizeScoreDocument(nextScore, assignmentDefaults, score);
      const previousVersion = score.version;
      score = {
        ...restored,
        ensembleId: score.ensembleId,
        version: Math.max(previousVersion + 1, restored.version + 1)
      };
      emitChange(events, "admin.restore", score, { previousVersion }, options);
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
    rnboTargetId: stringField(assignmentDocument.rnboTargetId),
    rnboHost: stringField(assignmentDocument.rnboHost),
    rnboPort: nullableNumberField(assignmentDocument.rnboPort),
    rnboAddress: stringField(assignmentDocument.rnboAddress),
    label: stringField(assignmentDocument.label),
    color: stringField(assignmentDocument.color),
    locked: Boolean(assignmentDocument.locked)
  };
}

function normalizeScoreDocument(scoreDocument, assignmentDefaults = {}, fallbackScore) {
  if (!scoreDocument || typeof scoreDocument !== "object" || Array.isArray(scoreDocument)) {
    throw new Error("score snapshot must be an object");
  }
  if (!isPlainObject(scoreDocument.context)) {
    throw new Error("score snapshot context must be an object");
  }
  if (!isPlainObject(scoreDocument.voices)) {
    throw new Error("score snapshot voices must be an object");
  }
  const restoredVoices = {};
  for (const [voiceId, voice] of Object.entries(scoreDocument.voices)) {
    if (!isPlainObject(voice)) {
      throw new Error(`voice ${voiceId} must be an object`);
    }
    if (!Array.isArray(voice.notes)) {
      throw new Error(`voice ${voiceId}.notes must be an array`);
    }
    restoredVoices[voiceId] = {
      version: Number.isFinite(voice.version) ? voice.version : 0,
      notes: structuredClone(voice.notes)
    };
  }
  const voiceIds = [...new Set([
    ...Object.keys(fallbackScore?.voices ?? {}),
    ...Object.keys(restoredVoices)
  ])];
  const voices = Object.fromEntries(
    voiceIds.map((voiceId) => [
      voiceId,
      structuredClone(restoredVoices[voiceId] ?? fallbackScore.voices[voiceId])
    ])
  );
  const assignments = resetAssignments(voices, assignmentDefaults);
  for (const [voiceId, assignment] of Object.entries(scoreDocument.assignments ?? {})) {
    if (voices[voiceId]) {
      assignments[voiceId] = normalizeAssignment(assignment);
    }
  }
  return {
    ensembleId: stringField(scoreDocument.ensembleId),
    version: Number.isFinite(scoreDocument.version) ? scoreDocument.version : 0,
    context: structuredClone(scoreDocument.context),
    assignments,
    voices
  };
}

function createEmptyAssignment(defaults = {}) {
  return {
    assignee: stringField(defaults.assignee),
    deviceId: stringField(defaults.deviceId),
    clientId: nullableStringField(defaults.clientId),
    rnboTargetId: stringField(defaults.rnboTargetId),
    rnboHost: stringField(defaults.rnboHost),
    rnboPort: nullableNumberField(defaults.rnboPort),
    rnboAddress: stringField(defaults.rnboAddress),
    label: stringField(defaults.label),
    color: stringField(defaults.color),
    locked: Boolean(defaults.locked)
  };
}

function ensureAssignments(score, defaults = {}) {
  return {
    ...resetAssignments(score.voices, defaults),
    ...(score.assignments ?? {})
  };
}

function resetAssignments(voices, defaults = {}) {
  return Object.fromEntries(Object.keys(voices).map((voiceId) => [voiceId, createEmptyAssignment(defaults[voiceId])]));
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

function normalizeVoiceId(voiceId) {
  const id = stringField(voiceId);
  if (!id) {
    throw new Error("voiceId is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error("voiceId must start with a letter or number and contain only letters, numbers, '.', '_', ':', or '-'");
  }
  return id;
}

function assertExpectedScoreVersion(score, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) {
    return;
  }
  if (!Number.isInteger(expectedVersion)) {
    throw new Error("expectedVersion must be an integer");
  }
  if (score.version !== expectedVersion) {
    throw new Error(`stale score version ${expectedVersion}; current version is ${score.version}`);
  }
}

function assertExpectedVoiceVersion(score, voiceId, expectedVoiceVersion) {
  if (expectedVoiceVersion === undefined || expectedVoiceVersion === null) {
    return;
  }
  if (!Number.isInteger(expectedVoiceVersion)) {
    throw new Error("expectedVoiceVersion must be an integer");
  }
  const currentVersion = score.voices[voiceId].version;
  if (currentVersion !== expectedVoiceVersion) {
    throw new Error(`stale voice '${voiceId}' version ${expectedVoiceVersion}; current version is ${currentVersion}`);
  }
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nullableStringField(value) {
  const stringValue = stringField(value);
  return stringValue ? stringValue : null;
}

function nullableNumberField(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("numeric assignment field must be a finite number");
  }
  return number;
}

function emitChange(events, type, score, detail, options = {}) {
  events.emit("change", {
    type,
    version: score.version,
    sourceClientId: options.sourceClientId,
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
