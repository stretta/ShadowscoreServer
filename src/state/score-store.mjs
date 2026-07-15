import { EventEmitter } from "node:events";
import { reconcileOscAssignments as reconcileOscRoleAssignments } from "../osc/assignments.mjs";
import { normalizeOscClip } from "../osc/snapshot-contract.mjs";

export function createInitialScore(config) {
  const voices = {};
  const assignments = {};
  const voiceIds = config.ensemble.voices;
  for (const voiceId of voiceIds) {
    voices[voiceId] = {
      version: 0,
      notes: []
    };
    assignments[voiceId] = createEmptyAssignment(config.ensemble.assignmentDefaults?.[voiceId]);
  }

  return {
    ensembleId: config.ensemble.id,
    version: 0,
    scoreRevision: 0,
    structureRevision: 0,
    context: createDefaultContext(),
    clips: createDefaultClips(voiceIds),
    mesostructure: createDefaultMesostructure(voiceIds),
    macrostructure: createDefaultMacrostructure(),
    structureState: createDefaultStructureState(),
    assignments,
    oscAssignments: {},
    oscClips: {},
    voices
  };
}

export function createScoreStore(initialScore, options = {}) {
  const events = new EventEmitter();
  const defaultScore = withRevisionDefaults(structuredClone(options.defaultScore ?? initialScore));
  let score = withRevisionDefaults(structuredClone(initialScore));
  const assignmentDefaults = structuredClone(defaultScore.assignments ?? initialScore.assignments ?? {});

  return {
    events,
    getScore() {
      return structuredClone(score);
    },
    inspectOscClipReferences(clipId) {
      if (clipId !== undefined) {
        const id = normalizeOscClipId(clipId);
        if (!score.oscClips?.[id]) throw new Error(`unknown OSC clip '${id}'`);
        const references = oscClipReferences(score.mesostructure, id);
        return {
          clipId: id,
          references: structuredClone(references),
          orphan: references.length === 0
        };
      }
      const clips = Object.fromEntries(Object.keys(score.oscClips ?? {}).sort().map((id) => {
        const references = oscClipReferences(score.mesostructure, id);
        return [id, { references, orphan: references.length === 0 }];
      }));
      return {
        clips: structuredClone(clips),
        orphanClipIds: Object.entries(clips).filter(([, value]) => value.orphan).map(([id]) => id)
      };
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
        ...nextRevisionFields(score, { structure: true }),
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
        ...nextRevisionFields(score, { structure: true }),
        assignments: nextAssignments,
        voices: nextVoices
      };
      emitChange(events, "voice.removed", score, { voiceId }, options);
      return structuredClone(score);
    },
    updateContext(nextContext, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      score = {
        ...score,
        ...nextRevisionFields(score),
        context: options.replace ? structuredClone(nextContext) : deepMerge(score.context, nextContext)
      };
      emitChange(events, "context.updated", score, { context: score.context }, options);
      return structuredClone(score);
    },
    replaceMesoBlock(blockId, blockDocument, options = {}) {
      const id = normalizeBlockId(blockId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const block = normalizeMesoBlock(blockDocument);
      assertOscBlockReferences(id, block, score.oscAssignments, score.oscClips);
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: true }),
        mesostructure: {
          ...score.mesostructure,
          [id]: block
        }
      };
      emitChange(events, "mesostructure.block.replaced", score, { blockId: id, block }, options);
      return structuredClone(score);
    },
    addOscClip(clipId, clipDocument, options = {}) {
      const id = normalizeOscClipId(clipId);
      if (score.oscClips?.[id]) throw new Error(`OSC clip '${id}' already exists`);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const clip = normalizeOscClip(clipDocument);
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: true }),
        oscClips: { ...(score.oscClips ?? {}), [id]: clip }
      };
      emitChange(events, "osc.clip.added", score, { clipId: id, clip }, options);
      return structuredClone(score);
    },
    replaceOscClip(clipId, clipDocument, options = {}) {
      const id = normalizeOscClipId(clipId);
      if (!score.oscClips?.[id]) throw new Error(`unknown OSC clip '${id}'`);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const clip = normalizeOscClip(clipDocument);
      assertOscClipCompatibleWithReferences(id, clip, score.mesostructure, score.oscAssignments);
      score = { ...score, ...nextRevisionFields(score, { structure: true }), oscClips: { ...score.oscClips, [id]: clip } };
      emitChange(events, "osc.clip.replaced", score, { clipId: id, clip }, options);
      return structuredClone(score);
    },
    removeOscClip(clipId, options = {}) {
      const id = normalizeOscClipId(clipId);
      if (!score.oscClips?.[id]) throw new Error(`unknown OSC clip '${id}'`);
      const references = oscClipReferences(score.mesostructure, id);
      if (references.length) {
        const error = new Error(`OSC clip '${id}' is assigned in ${references.map(({ blockId, roleId }) => `${blockId}/${roleId}`).join(", ")}`);
        error.code = "OSC_CLIP_REFERENCED";
        error.references = references;
        throw error;
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const oscClips = { ...score.oscClips };
      delete oscClips[id];
      score = { ...score, ...nextRevisionFields(score, { structure: true }), oscClips };
      emitChange(events, "osc.clip.removed", score, { clipId: id }, options);
      return structuredClone(score);
    },
    assignOscLayer(blockId, roleId, clipId, options = {}) {
      const id = normalizeBlockId(blockId);
      const role = normalizeOscRoleId(roleId);
      const clip = normalizeOscClipId(clipId);
      const block = score.mesostructure[id];
      if (!block) throw new Error(`unknown mesostructural block '${id}'`);
      if (!score.oscAssignments?.[role]) throw new Error(`unknown OSC assignment role '${role}'`);
      if (!score.oscClips?.[clip]) throw new Error(`unknown OSC clip '${clip}'`);
      const roleApp = score.oscAssignments[role].app;
      const clipApp = score.oscClips[clip].app;
      if (roleApp && roleApp !== clipApp) throw new Error(`OSC clip '${clip}' app '${clipApp}' is incompatible with role '${role}' app '${roleApp}'`);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: true }),
        mesostructure: { ...score.mesostructure, [id]: { ...block, oscLayers: { ...(block.oscLayers ?? {}), [role]: { clipId: clip } } } }
      };
      emitChange(events, "mesostructure.oscLayer.assigned", score, { blockId: id, roleId: role, clipId: clip }, options);
      return structuredClone(score);
    },
    removeOscLayer(blockId, roleId, options = {}) {
      const id = normalizeBlockId(blockId);
      const role = normalizeOscRoleId(roleId);
      const block = score.mesostructure[id];
      if (!block) throw new Error(`unknown mesostructural block '${id}'`);
      if (!block.oscLayers?.[role]) throw new Error(`unknown OSC layer role '${role}' in block '${id}'`);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const oscLayers = { ...block.oscLayers };
      delete oscLayers[role];
      score = { ...score, ...nextRevisionFields(score, { structure: true }), mesostructure: { ...score.mesostructure, [id]: { ...block, oscLayers } } };
      emitChange(events, "mesostructure.oscLayer.removed", score, { blockId: id, roleId: role }, options);
      return structuredClone(score);
    },
    removeMesoBlock(blockId, options = {}) {
      const id = normalizeBlockId(blockId);
      if (!score.mesostructure[id]) {
        throw new Error(`unknown mesostructural block '${id}'`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const nextMesostructure = { ...score.mesostructure };
      delete nextMesostructure[id];
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: true }),
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
    duplicateMesoBlock(sourceBlockId, targetBlockId, options = {}) {
      const sourceId = normalizeBlockId(sourceBlockId);
      const targetId = normalizeBlockId(targetBlockId);
      const sourceBlock = score.mesostructure[sourceId];
      if (!sourceBlock) {
        throw new Error(`unknown mesostructural block '${sourceId}'`);
      }
      if (score.mesostructure[targetId]) {
        throw new Error(`mesostructural block '${targetId}' already exists`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);

      const nextClips = { ...score.clips };
      const clipCopies = new Map();
      const copiedClips = [];
      const players = {};
      for (const [playerId, assignment] of Object.entries(sourceBlock.players ?? {})) {
        const clipId = assignment?.clipId;
        if (!clipId) {
          players[playerId] = structuredClone(assignment);
          continue;
        }
        if (!nextClips[clipId]) {
          throw new Error(`assigned clip '${clipId}' for ${sourceId}/${playerId} does not exist`);
        }
        if (!clipCopies.has(clipId)) {
          const nextClipId = uniqueClipIdForDuplicate(nextClips, clipId, sourceId, targetId);
          nextClips[nextClipId] = structuredClone(nextClips[clipId]);
          clipCopies.set(clipId, nextClipId);
          copiedClips.push({ sourceClipId: clipId, clipId: nextClipId });
        }
        players[playerId] = {
          ...structuredClone(assignment),
          clipId: clipCopies.get(clipId)
        };
      }

      const block = {
        ...structuredClone(sourceBlock),
        players
      };
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: true }),
        clips: nextClips,
        mesostructure: {
          ...score.mesostructure,
          [targetId]: block
        }
      };
      emitChange(events, "mesostructure.block.duplicated", score, {
        sourceBlockId: sourceId,
        blockId: targetId,
        copiedClips
      }, options);
      return structuredClone(score);
    },
    updateMacrostructure(macrostructureDocument, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
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
        ...nextRevisionFields(score, { structure: true }),
        macrostructure,
        structureState: normalizeStructureState(score.structureState, score.mesostructure, macrostructure)
      };
      emitChange(events, "macrostructure.updated", score, { macrostructure }, options);
      return structuredClone(score);
    },
    updateStructureState(structureStateDocument = {}, options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
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
        ...nextRevisionFields(score),
        structureState
      };
      emitChange(events, "structure.playhead.updated", score, { structureState }, options);
      return structuredClone(score);
    },
    advanceStructurePlayhead(options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const blocks = score.macrostructure?.blocks ?? [];
      const current = normalizeStructureState(score.structureState, score.mesostructure, score.macrostructure);
      const nextIndex = blocks.length ? (current.macroIndex + 1) % blocks.length : 0;
      const structureState = normalizeStructureState({
        macroIndex: nextIndex,
        activeBlockId: blocks[nextIndex] ?? current.activeBlockId
      }, score.mesostructure, score.macrostructure);
      score = {
        ...score,
        ...nextRevisionFields(score),
        structureState
      };
      emitChange(events, "structure.playhead.updated", score, { structureState }, options);
      return structuredClone(score);
    },
    resetStructurePlayhead(options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const firstBlockId = score.macrostructure?.blocks?.[0];
      const structureState = normalizeStructureState({
        macroIndex: 0,
        activeBlockId: firstBlockId
      }, score.mesostructure, score.macrostructure);
      score = {
        ...score,
        ...nextRevisionFields(score),
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
        ...nextRevisionFields(score, { structure: true }),
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
      assertExpectedRevisions(score, options);
      const clip = normalizeClipDocument(clipDocument);
      score = {
        ...score,
        ...nextRevisionFields(score),
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
      assertExpectedRevisions(score, options);
      const clip = normalizeClipDocument(clipDocument);
      score = {
        ...score,
        ...nextRevisionFields(score),
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
      assertExpectedRevisions(score, options);
      const nextClips = { ...score.clips };
      nextClips[newId] = nextClips[oldId];
      if (oldId !== newId) {
        delete nextClips[oldId];
      }
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: oldId !== newId }),
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
      assertExpectedRevisions(score, options);
      const nextClips = { ...score.clips };
      delete nextClips[id];
      score = {
        ...score,
        ...nextRevisionFields(score),
        clips: nextClips
      };
      emitChange(events, "clip.removed", score, { clipId: id }, options);
      return structuredClone(score);
    },
    replaceVoiceAssignment(voiceId, assignmentDocument, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const assignment = normalizeAssignment(assignmentDocument);
      const assignments = {
        ...ensureAssignments(score),
        [voiceId]: assignment
      };
      assertUniqueRnboTargetAssignments(assignments);
      score = {
        ...score,
        ...nextRevisionFields(score),
        assignments
      };
      emitChange(events, "voice.assignment.replaced", score, { voiceId, assignment }, options);
      return structuredClone(score);
    },
    replaceOscAssignment(roleId, assignmentDocument, options = {}) {
      const role = normalizeOscRoleId(roleId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const assignment = normalizeOscAssignment(assignmentDocument);
      assertOscRoleCompatibleWithLayers(role, assignment, score.mesostructure, score.oscClips);
      score = {
        ...score,
        ...nextRevisionFields(score),
        oscAssignments: {
          ...(score.oscAssignments ?? {}),
          [role]: assignment
        }
      };
      emitChange(events, "osc.assignment.replaced", score, { roleId: role, assignment }, options);
      return structuredClone(score);
    },
    removeOscAssignment(roleId, options = {}) {
      const role = normalizeOscRoleId(roleId);
      if (!score.oscAssignments?.[role]) {
        throw new Error(`unknown OSC assignment role '${role}'`);
      }
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const oscAssignments = { ...score.oscAssignments };
      delete oscAssignments[role];
      score = {
        ...score,
        ...nextRevisionFields(score),
        oscAssignments
      };
      emitChange(events, "osc.assignment.removed", score, { roleId: role }, options);
      return structuredClone(score);
    },
    reconcileOscAssignments(targets = [], options = {}) {
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedRevisions(score, options);
      const result = reconcileOscRoleAssignments(score.oscAssignments ?? {}, targets);
      if (result.changed.length === 0) {
        return {
          changed: false,
          score: structuredClone(score),
          assignments: structuredClone(score.oscAssignments ?? {}),
          resolutions: structuredClone(result.resolutions),
          changes: []
        };
      }
      score = {
        ...score,
        ...nextRevisionFields(score),
        oscAssignments: normalizeOscAssignments(result.assignments)
      };
      emitChange(events, "osc.assignment.reconciled", score, { changes: result.changed }, options);
      return {
        changed: true,
        score: structuredClone(score),
        assignments: structuredClone(score.oscAssignments),
        resolutions: structuredClone(result.resolutions),
        changes: structuredClone(result.changed)
      };
    },
    clearVoiceAssignment(voiceId, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      const assignment = createEmptyAssignment(assignmentDefaults[voiceId]);
      score = {
        ...score,
        ...nextRevisionFields(score),
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
      assertUniqueRnboTargetAssignments(nextAssignments);
      score = {
        ...score,
        ...nextRevisionFields(score),
        assignments: nextAssignments
      };
      emitChange(events, "voice.assignment.preset.applied", score, { presetId: options.presetId ?? "" }, options);
      return structuredClone(score);
    },
    reconcileRegisteredHardwareUnit(unitDocument, options = {}) {
      if (!unitDocument || typeof unitDocument !== "object" || Array.isArray(unitDocument)) {
        throw new Error("hardware unit must be an object");
      }
      const unitId = stringField(unitDocument.id);
      if (!unitId) {
        throw new Error("hardware unit must include id");
      }

      const shadowScoreTargets = Array.isArray(unitDocument.targets)
        ? unitDocument.targets.filter(isShadowScoreRnboTarget)
        : [];
      const assignments = ensureAssignments(score, assignmentDefaults);
      const nextAssignments = { ...assignments };
      const reconciled = [];
      const ambiguous = [];

      for (const [voiceId, assignment] of Object.entries(assignments)) {
        if (!assignment?.deviceId || assignment.deviceId !== unitId || assignment.locked) {
          continue;
        }
        if (shadowScoreTargets.length === 0) {
          continue;
        }
        if (shadowScoreTargets.length > 1) {
          const nextAssignment = normalizeAssignment({
            ...assignment,
            routingStatus: "ambiguous",
            routingMessage: `Hardware unit '${unitId}' advertised ${shadowScoreTargets.length} ShadowScore RNBO targets.`
          });
          if (!sameAssignment(assignment, nextAssignment)) {
            nextAssignments[voiceId] = nextAssignment;
            ambiguous.push({ voiceId, deviceId: unitId, targetCount: shadowScoreTargets.length });
          }
          continue;
        }

        const target = shadowScoreTargets[0];
        const nextAssignment = normalizeAssignment({
          ...assignment,
          rnboTargetId: target.id,
          rnboHost: target.host,
          rnboPort: target.port,
          rnboAddress: target.address ?? target.messagePath,
          routingStatus: "",
          routingMessage: ""
        });
        if (!sameAssignment(assignment, nextAssignment)) {
          nextAssignments[voiceId] = nextAssignment;
          reconciled.push({ voiceId, deviceId: unitId, rnboTargetId: nextAssignment.rnboTargetId });
        }
      }

      if (reconciled.length === 0 && ambiguous.length === 0) {
        return {
          changed: false,
          score: structuredClone(score),
          reconciled,
          ambiguous
        };
      }

      score = {
        ...score,
        ...nextRevisionFields(score),
        assignments: nextAssignments
      };
      emitChange(events, "voice.assignment.reconciled", score, { unitId, reconciled, ambiguous }, options);
      return {
        changed: true,
        score: structuredClone(score),
        reconciled,
        ambiguous
      };
    },
    replaceVoiceNotes(voiceId, notesDocument, options = {}) {
      assertKnownVoice(score, voiceId);
      assertExpectedScoreVersion(score, options.expectedVersion);
      assertExpectedVoiceVersion(score, voiceId, options.expectedVoiceVersion);
      const notes = normalizeNotesDocument(notesDocument);
      score = {
        ...score,
        ...nextRevisionFields(score),
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
      if (!options.context && !options.voices && !options.assignments && !options.oscAssignments && !options.oscClips && !options.structure && !options.notes) {
        throw new Error("reset must include at least one of context, voices, assignments, oscAssignments, oscClips, structure, or notes");
      }
      const voices = options.voices || options.notes ? resetVoices(score.voices) : score.voices;
      const assignments = options.assignments ? resetAssignments(score.voices, assignmentDefaults) : ensureAssignments(score, assignmentDefaults);
      const seededClips = options.structure ? createDefaultClips(Object.keys(voices)) : score.clips;
      score = {
        ...score,
        ...nextRevisionFields(score, { structure: Boolean(options.structure || options.voices) }),
        context: options.context ? createDefaultContext() : score.context,
        clips: options.notes ? resetClipNotes(seededClips) : seededClips,
        mesostructure: options.structure ? createDefaultMesostructure(Object.keys(voices)) : score.mesostructure,
        macrostructure: options.structure ? createDefaultMacrostructure() : score.macrostructure,
        structureState: options.structure ? createDefaultStructureState() : score.structureState,
        assignments,
        oscAssignments: options.oscAssignments ? {} : score.oscAssignments,
        oscClips: options.oscClips || options.structure ? {} : score.oscClips,
        voices
      };
      emitChange(events, "admin.reset", score, {
        context: Boolean(options.context),
        voices: Boolean(options.voices),
        assignments: Boolean(options.assignments),
        oscAssignments: Boolean(options.oscAssignments),
        oscClips: Boolean(options.oscClips || options.structure),
        structure: Boolean(options.structure),
        notes: Boolean(options.notes)
      }, options);
      return structuredClone(score);
    },
    createNewScore(options = {}) {
      const previousVersion = score.version;
      score = {
        ...structuredClone(defaultScore),
        version: previousVersion + 1,
        scoreRevision: scoreRevisionFor(score) + 1,
        structureRevision: structureRevisionFor(score) + 1
      };
      emitChange(events, "admin.score.created", score, { previousVersion }, options);
      return structuredClone(score);
    },
    restore(nextScore, options = {}) {
      assertExpectedRevisions(score, options);
      const restored = normalizeScoreDocument(nextScore, assignmentDefaults, score);
      const previousVersion = score.version;
      score = {
        ...restored,
        ensembleId: score.ensembleId,
        version: Math.max(previousVersion + 1, restored.version + 1),
        scoreRevision: scoreRevisionFor(score) + 1,
        structureRevision: structureRevisionFor(score) + 1
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

function nextRevisionFields(score, options = {}) {
  return {
    version: Number.isFinite(score.version) ? score.version + 1 : 1,
    scoreRevision: scoreRevisionFor(score) + 1,
    structureRevision: structureRevisionFor(score) + (options.structure ? 1 : 0)
  };
}

function withRevisionDefaults(score) {
  const normalized = {
    ...score,
    scoreRevision: scoreRevisionFor(score),
    structureRevision: structureRevisionFor(score),
    mesostructure: normalizeMesostructure(score.mesostructure ?? {}),
    oscAssignments: normalizeOscAssignments(score.oscAssignments ?? {}),
    oscClips: normalizeOscClips(score.oscClips ?? {})
  };
  assertOscReferences(normalized.mesostructure, normalized.oscAssignments, normalized.oscClips);
  return normalized;
}

function scoreRevisionFor(score) {
  return Number.isFinite(score?.scoreRevision) ? score.scoreRevision : Number.isFinite(score?.version) ? score.version : 0;
}

function structureRevisionFor(score) {
  return Number.isFinite(score?.structureRevision) ? score.structureRevision : 0;
}

const DEFAULT_BLOCK_IDS = ["A", "B", "C", "D", "E", "F"];

function createDefaultClips(voiceIds = []) {
  return Object.fromEntries(
    DEFAULT_BLOCK_IDS.flatMap((blockId, blockIndex) => voiceIds.map((voiceId, voiceIndex) => {
      const clipId = defaultClipId(blockId, voiceId);
      return [clipId, createSeededClipDocument(blockIndex, voiceIndex)];
    }))
  );
}

function createSeededClipDocument(blockIndex, voiceIndex) {
  const pitch = 60 + (voiceIndex * 2) + (blockIndex % 2);
  return normalizeClipDocument({
    notes: [
      {
        note_id: 1,
        pitch,
        start_time: 0,
        duration: 1,
        velocity: 96
      },
      {
        note_id: 2,
        pitch: pitch + 7,
        start_time: 4,
        duration: 1,
        velocity: 88
      }
    ],
    context: {
      clip: {
        TimeSignature: {
          numerator: 4,
          denominator: 4
        }
      },
      scale: {},
      grid: {},
      seed: blockIndex
    },
    duration: { bars: 2 },
    playbackType: "looped"
  });
}

function createDefaultMesostructure(voiceIds = []) {
  return Object.fromEntries(
    DEFAULT_BLOCK_IDS.map((blockId) => [
      blockId,
      {
        duration: { bars: 4 },
        scale: {},
        oscLayers: {},
        players: Object.fromEntries(
          voiceIds.map((voiceId) => [voiceId, { clipId: defaultClipId(blockId, voiceId) }])
        )
      }
    ])
  );
}

function createDefaultMacrostructure() {
  return {
    tempo: 120,
    blocks: DEFAULT_BLOCK_IDS
  };
}

function defaultClipId(blockId, voiceId) {
  return `${blockId.toLowerCase()}-${voiceId}`;
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
    locked: Boolean(assignmentDocument.locked),
    routingStatus: stringField(assignmentDocument.routingStatus),
    routingMessage: stringField(assignmentDocument.routingMessage)
  };
}

function normalizeOscAssignments(assignmentsDocument) {
  if (!isPlainObject(assignmentsDocument)) {
    throw new Error("OSC assignments must be an object");
  }
  return Object.fromEntries(Object.entries(assignmentsDocument).map(([roleId, assignment]) => [
    normalizeOscRoleId(roleId),
    normalizeOscAssignment(assignment)
  ]));
}

function normalizeOscAssignment(assignmentDocument) {
  if (!isPlainObject(assignmentDocument)) {
    throw new Error("OSC assignment body must be an object");
  }
  return {
    label: stringField(assignmentDocument.label),
    app: cleanToken(assignmentDocument.app),
    deviceId: stringField(assignmentDocument.deviceId),
    oscTargetId: stringField(assignmentDocument.oscTargetId),
    ignoreRecall: Boolean(assignmentDocument.ignoreRecall),
    locked: Boolean(assignmentDocument.locked),
    routingStatus: stringField(assignmentDocument.routingStatus),
    routingMessage: stringField(assignmentDocument.routingMessage)
  };
}

function assertUniqueRnboTargetAssignments(assignments) {
  const seen = new Map();
  for (const [voiceId, assignment] of Object.entries(assignments ?? {})) {
    const targetId = assignment?.rnboTargetId;
    if (!targetId) {
      continue;
    }
    const existingVoiceId = seen.get(targetId);
    if (existingVoiceId) {
      throw new Error(`RNBO target '${targetId}' is already assigned to ${existingVoiceId}`);
    }
    seen.set(targetId, voiceId);
  }
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
  if (scoreDocument.oscAssignments !== undefined && !isPlainObject(scoreDocument.oscAssignments)) {
    throw new Error("score snapshot oscAssignments must be an object");
  }
  if (scoreDocument.oscClips !== undefined && !isPlainObject(scoreDocument.oscClips)) {
    throw new Error("score snapshot oscClips must be an object");
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
  const normalized = {
    ensembleId: stringField(scoreDocument.ensembleId),
    version: Number.isFinite(scoreDocument.version) ? scoreDocument.version : 0,
    scoreRevision: scoreRevisionFor(scoreDocument),
    structureRevision: structureRevisionFor(scoreDocument),
    context: structuredClone(scoreDocument.context),
    clips: normalizeClips(scoreDocument.clips ?? fallbackScore?.clips ?? {}),
    mesostructure,
    macrostructure,
    structureState: normalizeStructureState(scoreDocument.structureState ?? fallbackScore?.structureState ?? createDefaultStructureState(), mesostructure, macrostructure),
    assignments,
    oscAssignments: normalizeOscAssignments(scoreDocument.oscAssignments ?? {}),
    oscClips: normalizeOscClips(scoreDocument.oscClips ?? {}),
    voices
  };
  assertOscReferences(normalized.mesostructure, normalized.oscAssignments, normalized.oscClips);
  return normalized;
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

function normalizeOscClips(clipsDocument) {
  if (!isPlainObject(clipsDocument)) throw new Error("oscClips must be an object");
  return Object.fromEntries(Object.entries(clipsDocument).map(([clipId, clip]) => [normalizeOscClipId(clipId), normalizeOscClip(clip)]));
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

function uniqueClipIdForDuplicate(clips, sourceClipId, sourceBlockId, targetBlockId) {
  const sourcePrefix = `${sourceBlockId.toLowerCase()}-`;
  const targetPrefix = `${targetBlockId.toLowerCase()}-`;
  const base = sourceClipId.toLowerCase().startsWith(sourcePrefix)
    ? `${targetPrefix}${sourceClipId.slice(sourcePrefix.length)}`
    : `${targetPrefix}${sourceClipId}`;
  return uniqueId(base, clips);
}

function uniqueId(base, existing) {
  const cleanBase = normalizeClipId(base);
  if (!existing[cleanBase]) {
    return cleanBase;
  }
  let index = 2;
  while (existing[`${cleanBase}-${index}`]) {
    index += 1;
  }
  return `${cleanBase}-${index}`;
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
    duration: structuredClone(blockDocument.duration),
    scale: structuredClone(blockDocument.scale ?? {}),
    oscLayers: normalizeOscLayers(blockDocument.oscLayers ?? {}),
    players: normalizeMesoBlockPlayers(blockDocument.players ?? {})
  };
}

function normalizeOscLayers(layersDocument) {
  if (!isPlainObject(layersDocument)) {
    throw new Error("mesostructural block oscLayers must be an object");
  }
  return Object.fromEntries(Object.entries(layersDocument).map(([roleId, layer]) => [
    normalizeOscRoleId(roleId),
    normalizeOscLayer(layer)
  ]));
}

function normalizeOscLayer(document) {
  if (!isPlainObject(document)) throw new Error("OSC layer must be an object");
  return { clipId: normalizeOscClipId(document.clipId) };
}

function oscClipReferences(mesostructure, clipId) {
  return Object.entries(mesostructure ?? {}).flatMap(([blockId, block]) =>
    Object.entries(block.oscLayers ?? {}).flatMap(([roleId, layer]) => layer?.clipId === clipId ? [{ blockId, roleId }] : [])
  );
}

function assertOscReferences(mesostructure, assignments, clips) {
  for (const [blockId, block] of Object.entries(mesostructure ?? {})) {
    assertOscBlockReferences(blockId, block, assignments, clips);
  }
}

function assertOscBlockReferences(blockId, block, assignments, clips) {
  for (const [roleId, layer] of Object.entries(block.oscLayers ?? {})) {
    if (!assignments?.[roleId]) throw new Error(`OSC layer '${blockId}/${roleId}' references unknown role '${roleId}'`);
    const clip = clips?.[layer.clipId];
    if (!clip) throw new Error(`OSC layer '${blockId}/${roleId}' references unknown clip '${layer.clipId}'`);
    const roleApp = assignments[roleId].app;
    if (roleApp && roleApp !== clip.app) throw new Error(`OSC layer '${blockId}/${roleId}' assigns clip app '${clip.app}' to incompatible role app '${roleApp}'`);
  }
}

function assertOscClipCompatibleWithReferences(clipId, clip, mesostructure, assignments) {
  for (const { blockId, roleId } of oscClipReferences(mesostructure, clipId)) {
    const roleApp = assignments?.[roleId]?.app;
    if (roleApp && roleApp !== clip.app) throw new Error(`OSC clip '${clipId}' app '${clip.app}' is incompatible with referenced role '${blockId}/${roleId}' app '${roleApp}'`);
  }
}

function assertOscRoleCompatibleWithLayers(roleId, assignment, mesostructure, clips) {
  for (const [blockId, block] of Object.entries(mesostructure ?? {})) {
    const clipId = block.oscLayers?.[roleId]?.clipId;
    const clipApp = clips?.[clipId]?.app;
    if (clipApp && assignment.app && clipApp !== assignment.app) throw new Error(`OSC role '${roleId}' app '${assignment.app}' is incompatible with clip '${clipId}' app '${clipApp}' in block '${blockId}'`);
  }
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
    locked: Boolean(defaults.locked),
    routingStatus: stringField(defaults.routingStatus),
    routingMessage: stringField(defaults.routingMessage)
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

function sameAssignment(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isShadowScoreRnboTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }
  const haystack = [
    target.id,
    target.localId,
    target.name,
    target.address,
    target.messagePath
  ].map((value) => stringField(value).toLowerCase());
  return haystack.some((value) => value.includes("shadowscore"));
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

function resetClipNotes(clips) {
  return Object.fromEntries(
    Object.entries(clips).map(([clipId, clip]) => [
      clipId,
      {
        ...clip,
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

function normalizeOscClipId(clipId) {
  const id = stringField(clipId);
  if (!id) throw new Error("OSC clip id is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("OSC clip id must contain only letters, numbers, dots, dashes, and underscores");
  return id;
}

function normalizeOscRoleId(roleId) {
  const id = stringField(roleId);
  if (!id) {
    throw new Error("roleId is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error("roleId must start with a letter or number and contain only letters, numbers, '.', '_', ':', or '-'");
  }
  return id;
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
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

function assertExpectedRevisions(score, options = {}) {
  assertExpectedRevision(score, scoreRevisionFor(score), options.expectedScoreRevision, "score");
  assertExpectedRevision(score, structureRevisionFor(score), options.expectedStructureRevision, "structure");
}

function assertExpectedRevision(score, currentRevision, expectedRevision, label) {
  if (expectedRevision === undefined || expectedRevision === null) {
    return;
  }
  if (!Number.isInteger(expectedRevision)) {
    const error = new Error(`expected${capitalize(label)}Revision must be an integer`);
    error.code = "invalid_revision";
    throw error;
  }
  if (currentRevision !== expectedRevision) {
    const error = new Error(`stale ${label} revision ${expectedRevision}; current ${label} revision is ${currentRevision}`);
    error.code = `stale_${label}_revision`;
    error.currentScoreRevision = scoreRevisionFor(score);
    error.currentStructureRevision = structureRevisionFor(score);
    error.currentVersion = score.version;
    throw error;
  }
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
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
