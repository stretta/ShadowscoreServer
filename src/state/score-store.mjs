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
    clips: {},
    mesostructure: createDefaultMesostructure(),
    macrostructure: createDefaultMacrostructure(),
    structureState: createDefaultStructureState(),
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
    replaceMesoBlock(blockId, blockDocument, options = {}) {
      const id = normalizeBlockId(blockId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const block = normalizeMesoBlock(blockDocument);
      score = {
        ...score,
        version: score.version + 1,
        mesostructure: {
          ...score.mesostructure,
          [id]: block
        }
      };
      emitChange(events, "mesostructure.block.replaced", score, { blockId: id, block }, options);
      return structuredClone(score);
    },
    removeMesoBlock(blockId, options = {}) {
      const id = normalizeBlockId(blockId);
      if (!score.mesostructure[id]) {
        throw new Error(`unknown mesostructural block '${id}'`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const nextMesostructure = { ...score.mesostructure };
      delete nextMesostructure[id];
      score = {
        ...score,
        version: score.version + 1,
        mesostructure: nextMesostructure,
        macrostructure: {
          ...score.macrostructure,
          blocks: (score.macrostructure.blocks ?? []).filter((entry) => entry !== id)
        },
        structureState: normalizeStructureState(score.structureState, nextMesostructure, {
          ...score.macrostructure,
          blocks: (score.macrostructure.blocks ?? []).filter((entry) => entry !== id)
        })
      };
      emitChange(events, "mesostructure.block.removed", score, { blockId: id }, options);
      return structuredClone(score);
    },
    updateMacrostructure(macrostructureDocument, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      const macrostructure = normalizeMacrostructure(
        options.replace ? macrostructureDocument : deepMerge(score.macrostructure, macrostructureDocument)
      );
      for (const blockId of macrostructure.blocks) {
        if (!score.mesostructure[blockId]) {
          throw new Error(`macrostructure references unknown mesostructural block '${blockId}'`);
        }
      }
      score = {
        ...score,
        version: score.version + 1,
        macrostructure,
        structureState: normalizeStructureState(score.structureState, score.mesostructure, macrostructure)
      };
      emitChange(events, "macrostructure.updated", score, { macrostructure }, options);
      return structuredClone(score);
    },
    updateStructureState(structureStateDocument = {}, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      if (structureStateDocument.activeBlockId !== undefined && !score.mesostructure[stringField(structureStateDocument.activeBlockId)]) {
        throw new Error(`unknown mesostructural block '${structureStateDocument.activeBlockId}'`);
      }
      const structureState = normalizeStructureState(
        {
          ...score.structureState,
          ...structureStateDocument
        },
        score.mesostructure,
        score.macrostructure
      );
      score = {
        ...score,
        version: score.version + 1,
        structureState
      };
      emitChange(events, "structure.playhead.updated", score, { structureState }, options);
      return structuredClone(score);
    },
    advanceStructurePlayhead(options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      const blocks = score.macrostructure?.blocks ?? [];
      const current = normalizeStructureState(score.structureState, score.mesostructure, score.macrostructure);
      const nextIndex = blocks.length ? (current.macroIndex + 1) % blocks.length : 0;
      const structureState = normalizeStructureState({
        macroIndex: nextIndex,
        activeBlockId: blocks[nextIndex] ?? current.activeBlockId
      }, score.mesostructure, score.macrostructure);
      score = {
        ...score,
        version: score.version + 1,
        structureState
      };
      emitChange(events, "structure.playhead.updated", score, { structureState }, options);
      return structuredClone(score);
    },
    resetStructurePlayhead(options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      const structureState = normalizeStructureState(createDefaultStructureState(), score.mesostructure, score.macrostructure);
      score = {
        ...score,
        version: score.version + 1,
        structureState
      };
      emitChange(events, "structure.playhead.updated", score, { structureState }, options);
      return structuredClone(score);
    },
    importLegacyVoiceNotes(options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      const blockId = normalizeBlockId(options.blockId ?? "A");
      if (!score.mesostructure[blockId]) {
        throw new Error(`unknown mesostructural block '${blockId}'`);
      }
      const suffix = normalizeClipId(options.suffix ?? "main");
      const overwriteClips = Boolean(options.overwriteClips);
      const includeEmpty = Boolean(options.includeEmpty);
      const nextClips = { ...score.clips };
      const targetBlock = score.mesostructure[blockId];
      const nextPlayers = { ...(targetBlock.players ?? {}) };
      const imported = [];
      const assigned = [];
      const skipped = [];

      for (const [voiceId, voice] of Object.entries(score.voices)) {
        const notes = Array.isArray(voice.notes) ? voice.notes : [];
        const clipId = normalizeClipId(`${voiceId}-${suffix}`);
        if (!includeEmpty && notes.length === 0) {
          skipped.push({ voiceId, clipId, reason: "empty" });
          continue;
        }
        if (nextClips[clipId] && !overwriteClips) {
          skipped.push({ voiceId, clipId, reason: "clip-exists" });
        } else {
          nextClips[clipId] = normalizeClipDocument({
            notes,
            context: score.context ?? createDefaultContext(),
            duration: { bars: 1 },
            playbackType: "looped"
          });
          imported.push({ voiceId, clipId, noteCount: notes.length });
        }
        if (nextClips[clipId]) {
          nextPlayers[voiceId] = {
            ...(nextPlayers[voiceId] ?? {}),
            clipId
          };
          assigned.push({ voiceId, clipId, blockId });
        }
      }

      if (imported.length === 0 && assigned.length === 0) {
        throw new Error("no legacy voice notes were available to import");
      }

      score = {
        ...score,
        version: score.version + 1,
        clips: nextClips,
        mesostructure: {
          ...score.mesostructure,
          [blockId]: {
            ...targetBlock,
            players: nextPlayers
          }
        }
      };
      emitChange(events, "admin.legacyVoiceNotes.imported", score, { blockId, imported, assigned, skipped }, options);
      return structuredClone(score);
    },
    addClip(clipId, clipDocument = {}, options = {}) {
      const id = normalizeClipId(clipId);
      if (score.clips[id]) {
        throw new Error(`clip '${id}' already exists`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const clip = normalizeClipDocument(clipDocument);
      score = {
        ...score,
        version: score.version + 1,
        clips: {
          ...score.clips,
          [id]: clip
        }
      };
      emitChange(events, "clip.added", score, { clipId: id, clip }, options);
      return structuredClone(score);
    },
    replaceClip(clipId, clipDocument = {}, options = {}) {
      const id = normalizeClipId(clipId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const clip = normalizeClipDocument(clipDocument);
      score = {
        ...score,
        version: score.version + 1,
        clips: {
          ...score.clips,
          [id]: clip
        }
      };
      emitChange(events, "clip.replaced", score, { clipId: id, clip }, options);
      return structuredClone(score);
    },
    renameClip(oldClipId, newClipId, options = {}) {
      const oldId = normalizeClipId(oldClipId);
      const newId = normalizeClipId(newClipId);
      if (!score.clips[oldId]) {
        throw new Error(`unknown clip '${oldId}'`);
      }
      if (oldId !== newId && score.clips[newId]) {
        throw new Error(`clip '${newId}' already exists`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const nextClips = { ...score.clips };
      nextClips[newId] = nextClips[oldId];
      if (oldId !== newId) {
        delete nextClips[oldId];
      }
      score = {
        ...score,
        version: score.version + 1,
        clips: nextClips,
        mesostructure: renameClipReferences(score.mesostructure, oldId, newId)
      };
      emitChange(events, "clip.renamed", score, { oldClipId: oldId, newClipId: newId }, options);
      return structuredClone(score);
    },
    removeClip(clipId, options = {}) {
      const id = normalizeClipId(clipId);
      if (!score.clips[id]) {
        throw new Error(`unknown clip '${id}'`);
      }
      const references = clipReferences(score.mesostructure, id);
      if (references.length) {
        throw new Error(`clip '${id}' is assigned in ${references.join(", ")}`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      const nextClips = { ...score.clips };
      delete nextClips[id];
      score = {
        ...score,
        version: score.version + 1,
        clips: nextClips
      };
      emitChange(events, "clip.removed", score, { clipId: id }, options);
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
      if (!options.context && !options.voices && !options.assignments && !options.structure) {
        throw new Error("reset must include at least one of context, voices, assignments, or structure");
      }
      const voices = options.voices ? resetVoices(score.voices) : score.voices;
      const assignments = options.assignments ? resetAssignments(score.voices, assignmentDefaults) : ensureAssignments(score, assignmentDefaults);
      score = {
        ...score,
        version: score.version + 1,
        context: options.context ? createDefaultContext() : score.context,
        clips: options.structure ? {} : score.clips,
        mesostructure: options.structure ? createDefaultMesostructure() : score.mesostructure,
        macrostructure: options.structure ? createDefaultMacrostructure() : score.macrostructure,
        structureState: options.structure ? createDefaultStructureState() : score.structureState,
        assignments,
        voices
      };
      emitChange(events, "admin.reset", score, {
        context: Boolean(options.context),
        voices: Boolean(options.voices),
        assignments: Boolean(options.assignments),
        structure: Boolean(options.structure)
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

function createDefaultMesostructure() {
  return Object.fromEntries(
    ["A", "B", "C", "D", "E", "F"].map((blockId) => [
      blockId,
      {
        duration: { bars: 8 },
        scale: {},
        players: {}
      }
    ])
  );
}

function createDefaultMacrostructure() {
  return {
    tempo: 120,
    blocks: ["A", "B", "C", "D", "E", "F"]
  };
}

function createDefaultStructureState() {
  return {
    activeBlockId: "A",
    macroIndex: 0
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
  if (scoreDocument.clips !== undefined && !isPlainObject(scoreDocument.clips)) {
    throw new Error("score snapshot clips must be an object");
  }
  if (scoreDocument.mesostructure !== undefined && !isPlainObject(scoreDocument.mesostructure)) {
    throw new Error("score snapshot mesostructure must be an object");
  }
  if (scoreDocument.macrostructure !== undefined && !isPlainObject(scoreDocument.macrostructure)) {
    throw new Error("score snapshot macrostructure must be an object");
  }
  if (scoreDocument.structureState !== undefined && !isPlainObject(scoreDocument.structureState)) {
    throw new Error("score snapshot structureState must be an object");
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
  const mesostructure = normalizeMesostructure(scoreDocument.mesostructure ?? fallbackScore?.mesostructure ?? createDefaultMesostructure());
  const macrostructure = normalizeMacrostructure(scoreDocument.macrostructure ?? fallbackScore?.macrostructure ?? createDefaultMacrostructure());
  return {
    ensembleId: stringField(scoreDocument.ensembleId),
    version: Number.isFinite(scoreDocument.version) ? scoreDocument.version : 0,
    context: structuredClone(scoreDocument.context),
    clips: normalizeClips(scoreDocument.clips ?? fallbackScore?.clips ?? {}),
    mesostructure,
    macrostructure,
    structureState: normalizeStructureState(scoreDocument.structureState ?? fallbackScore?.structureState ?? createDefaultStructureState(), mesostructure, macrostructure),
    assignments,
    voices
  };
}

function normalizeClips(clipsDocument) {
  if (!isPlainObject(clipsDocument)) {
    throw new Error("clips must be an object");
  }
  return Object.fromEntries(
    Object.entries(clipsDocument).map(([clipId, clip]) => [
      normalizeClipId(clipId),
      normalizeClipDocument(clip)
    ])
  );
}

function normalizeClipDocument(clipDocument = {}) {
  if (!isPlainObject(clipDocument)) {
    throw new Error("clip must be an object");
  }
  if (clipDocument.notes !== undefined && !Array.isArray(clipDocument.notes)) {
    throw new Error("clip notes must be an array");
  }
  if (clipDocument.context !== undefined && !isPlainObject(clipDocument.context)) {
    throw new Error("clip context must be an object");
  }
  if (clipDocument.behavior !== undefined && !isPlainObject(clipDocument.behavior)) {
    throw new Error("clip behavior must be an object");
  }
  if (clipDocument.duration !== undefined && !isPlainObject(clipDocument.duration)) {
    throw new Error("clip duration must be an object");
  }
  return {
    notes: structuredClone(clipDocument.notes ?? []),
    context: structuredClone(clipDocument.context ?? createDefaultContext()),
    duration: normalizeDuration(clipDocument.duration),
    playbackType: normalizePlaybackType(clipDocument.playbackType),
    behavior: normalizeClipBehavior(clipDocument.behavior ?? {})
  };
}

function normalizeDuration(duration) {
  if (duration === undefined) {
    return {};
  }
  return structuredClone(duration);
}

function normalizePlaybackType(value) {
  const playbackType = stringField(value || "looped");
  if (playbackType !== "looped" && playbackType !== "one-shot") {
    throw new Error("clip playbackType must be 'looped' or 'one-shot'");
  }
  return playbackType;
}

function normalizeClipBehavior(behavior) {
  return {
    followsPitch: behavior.followsPitch === undefined ? true : Boolean(behavior.followsPitch),
    followsScale: behavior.followsScale === undefined ? true : Boolean(behavior.followsScale),
    transposeMode: stringField(behavior.transposeMode) || "scale-degree"
  };
}

function clipReferences(mesostructure, clipId) {
  const references = [];
  for (const [blockId, block] of Object.entries(mesostructure ?? {})) {
    for (const [playerId, assignment] of Object.entries(block.players ?? {})) {
      if (assignment?.clipId === clipId) {
        references.push(`${blockId}/${playerId}`);
      }
    }
  }
  return references;
}

function renameClipReferences(mesostructure, oldClipId, newClipId) {
  return Object.fromEntries(
    Object.entries(mesostructure ?? {}).map(([blockId, block]) => [
      blockId,
      {
        ...block,
        players: Object.fromEntries(
          Object.entries(block.players ?? {}).map(([playerId, assignment]) => [
            playerId,
            assignment?.clipId === oldClipId ? { ...assignment, clipId: newClipId } : assignment
          ])
        )
      }
    ])
  );
}

function normalizeMesostructure(mesostructureDocument) {
  if (!isPlainObject(mesostructureDocument)) {
    throw new Error("mesostructure must be an object");
  }
  return Object.fromEntries(
    Object.entries(mesostructureDocument).map(([blockId, block]) => [
      normalizeBlockId(blockId),
      normalizeMesoBlock(block)
    ])
  );
}

function normalizeMesoBlock(blockDocument) {
  if (!isPlainObject(blockDocument)) {
    throw new Error("mesostructural block must be an object");
  }
  if (!isPlainObject(blockDocument.duration)) {
    throw new Error("mesostructural block duration must be an object");
  }
  if (blockDocument.players !== undefined && !isPlainObject(blockDocument.players)) {
    throw new Error("mesostructural block players must be an object");
  }
  if (blockDocument.scale !== undefined && !isPlainObject(blockDocument.scale)) {
    throw new Error("mesostructural block scale must be an object");
  }
  return {
    ...structuredClone(blockDocument),
    duration: structuredClone(blockDocument.duration),
    scale: structuredClone(blockDocument.scale ?? {}),
    players: normalizeMesoBlockPlayers(blockDocument.players ?? {})
  };
}

function normalizeMesoBlockPlayers(players) {
  return Object.fromEntries(
    Object.entries(players).map(([playerId, assignment]) => [
      playerId,
      typeof assignment === "string" ? { clipId: normalizeClipId(assignment) } : structuredClone(assignment)
    ])
  );
}

function normalizeMacrostructure(macrostructureDocument) {
  if (!isPlainObject(macrostructureDocument)) {
    throw new Error("macrostructure must be an object");
  }
  if (!Number.isFinite(macrostructureDocument.tempo)) {
    throw new Error("macrostructure tempo must be numeric");
  }
  if (!Array.isArray(macrostructureDocument.blocks)) {
    throw new Error("macrostructure blocks must be an array");
  }
  return {
    ...structuredClone(macrostructureDocument),
    tempo: Number(macrostructureDocument.tempo),
    blocks: macrostructureDocument.blocks.map((blockId) => normalizeBlockId(blockId))
  };
}

function normalizeStructureState(structureStateDocument = {}, mesostructure = {}, macrostructure = createDefaultMacrostructure()) {
  if (!isPlainObject(structureStateDocument)) {
    throw new Error("structureState must be an object");
  }
  const blocks = macrostructure.blocks ?? [];
  const requestedBlockId = stringField(structureStateDocument.activeBlockId);
  const fallbackBlockId = blocks.find((blockId) => mesostructure[blockId]) ?? Object.keys(mesostructure)[0] ?? "";
  const activeBlockId = requestedBlockId && mesostructure[requestedBlockId] ? requestedBlockId : fallbackBlockId;
  const requestedIndex = Number.isFinite(structureStateDocument.macroIndex) ? Math.max(0, Math.floor(structureStateDocument.macroIndex)) : blocks.indexOf(activeBlockId);
  const activeIndex = blocks.indexOf(activeBlockId);
  const requestedIndexMatchesActiveBlock = blocks[requestedIndex] === activeBlockId;
  const macroIndex = blocks.length
    ? Math.min(blocks.length - 1, Math.max(0, requestedIndexMatchesActiveBlock ? requestedIndex : activeIndex >= 0 ? activeIndex : requestedIndex))
    : 0;
  return {
    ...structuredClone(structureStateDocument),
    activeBlockId,
    macroIndex
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

function normalizeBlockId(blockId) {
  const id = stringField(blockId);
  if (!id) {
    throw new Error("blockId is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error("blockId must start with a letter or number and contain only letters, numbers, '.', '_', ':', or '-'");
  }
  return id;
}

function normalizeClipId(clipId) {
  const id = stringField(clipId);
  if (!id) {
    throw new Error("clipId is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error("clipId must start with a letter or number and contain only letters, numbers, '.', '_', ':', or '-'");
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
