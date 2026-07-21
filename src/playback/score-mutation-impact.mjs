export function scoreMutationImpact(event = {}, previousScore = {}) {
  const score = event.score ?? {};
  const detail = event.detail ?? {};
  const scoreRevision = score.scoreRevision ?? score.version ?? 0;
  const base = {
    eventType: String(event.type ?? ""),
    scoreRevision,
    resource: resourceForEvent(event),
    blockIds: [],
    voiceIdsByBlock: {},
    timingChanged: false,
    routingChanged: false,
    scheduleChanged: false,
    invalidateAll: false
  };

  switch (event.type) {
    case "clip.added":
    case "clip.replaced":
    case "clip.removed": {
      addClipReferences(base, previousScore, detail.clipId);
      addClipReferences(base, score, detail.clipId);
      break;
    }
    case "clip.renamed": {
      addClipReferences(base, previousScore, detail.oldClipId);
      addClipReferences(base, score, detail.newClipId);
      break;
    }
    case "mesostructure.block.replaced": {
      const blockId = stringField(detail.blockId);
      addBlockVoices(base, blockId, previousScore.mesostructure?.[blockId]);
      addBlockVoices(base, blockId, score.mesostructure?.[blockId]);
      base.timingChanged = blockTimingFingerprint(previousScore.mesostructure?.[blockId]) !== blockTimingFingerprint(score.mesostructure?.[blockId]);
      break;
    }
    case "mesostructure.block.duplicated":
      addBlockVoices(base, detail.blockId, score.mesostructure?.[detail.blockId]);
      break;
    case "mesostructure.block.removed":
      addBlockVoices(base, detail.blockId, previousScore.mesostructure?.[detail.blockId]);
      break;
    case "mesostructure.scale.transformed":
      addBlockVoices(base, detail.blockId, score.mesostructure?.[detail.blockId]);
      base.timingChanged = true;
      break;
    case "context.updated":
      addEveryBlock(base, score);
      base.timingChanged = true;
      break;
    case "voice.notes.replaced":
      addVoiceReferences(base, previousScore, detail.voiceId);
      addVoiceReferences(base, score, detail.voiceId);
      break;
    case "voice.added":
    case "voice.removed":
    case "voice.assignment.replaced":
    case "voice.assignment.cleared":
    case "voice.assignment.reconciled":
      addVoiceReferences(base, previousScore, detail.voiceId);
      addVoiceReferences(base, score, detail.voiceId);
      base.routingChanged = true;
      break;
    case "voice.assignment.preset.applied":
      addEveryBlock(base, score);
      base.routingChanged = true;
      break;
    case "admin.legacyVoiceNotes.imported":
      addBlockVoices(base, detail.blockId, score.mesostructure?.[detail.blockId]);
      break;
    case "macrostructure.updated":
    case "structure.playhead.updated":
      base.scheduleChanged = true;
      break;
    case "admin.reset":
    case "admin.score.created":
    case "admin.score.initialized":
    case "admin.restore":
      base.invalidateAll = true;
      addEveryBlock(base, score);
      base.timingChanged = true;
      base.routingChanged = true;
      base.scheduleChanged = true;
      break;
    default:
      break;
  }

  base.blockIds = [...new Set(base.blockIds.filter(Boolean))].sort();
  base.voiceIdsByBlock = Object.fromEntries(base.blockIds.map((blockId) => [
    blockId,
    [...new Set(base.voiceIdsByBlock[blockId] ?? [])].sort()
  ]));
  return base;
}

export function impactAffectsRnbo(impact) {
  return Boolean(impact?.invalidateAll || impact?.blockIds?.some((blockId) => (impact.voiceIdsByBlock?.[blockId] ?? []).length));
}

export function impactVoicesForBlock(impact, blockId) {
  if (!impact || (impact.blockIds ?? []).includes(blockId) === false) return [];
  return [...(impact.voiceIdsByBlock?.[blockId] ?? [])];
}

function resourceForEvent(event) {
  const detail = event.detail ?? {};
  if (detail.clipId || detail.oldClipId) return { type: "clip", id: stringField(detail.clipId ?? detail.oldClipId) };
  if (detail.blockId) return { type: "block", id: stringField(detail.blockId) };
  if (detail.voiceId) return { type: "voice", id: stringField(detail.voiceId) };
  if (String(event.type ?? "").startsWith("macrostructure.")) return { type: "macrostructure", id: "macrostructure" };
  if (String(event.type ?? "").startsWith("context.")) return { type: "context", id: "context" };
  if (String(event.type ?? "").startsWith("admin.")) return { type: "score", id: "score" };
  return { type: "event", id: String(event.type ?? "") };
}

function addClipReferences(impact, score, clipId) {
  const id = stringField(clipId);
  if (!id) return;
  for (const [blockId, block] of Object.entries(score?.mesostructure ?? {})) {
    for (const [voiceId, assignment] of Object.entries(block?.players ?? {})) {
      if (assignment?.clipId === id) addVoice(impact, blockId, voiceId);
    }
  }
}

function addVoiceReferences(impact, score, voiceId) {
  const id = stringField(voiceId);
  if (!id) return;
  for (const [blockId, block] of Object.entries(score?.mesostructure ?? {})) {
    if (block?.players?.[id]) addVoice(impact, blockId, id);
  }
}

function addEveryBlock(impact, score) {
  for (const [blockId, block] of Object.entries(score?.mesostructure ?? {})) addBlockVoices(impact, blockId, block);
}

function addBlockVoices(impact, blockId, block) {
  const id = stringField(blockId);
  if (!id) return;
  impact.blockIds.push(id);
  for (const voiceId of Object.keys(block?.players ?? {})) addVoice(impact, id, voiceId);
}

function addVoice(impact, blockId, voiceId) {
  const block = stringField(blockId);
  const voice = stringField(voiceId);
  if (!block || !voice) return;
  impact.blockIds.push(block);
  (impact.voiceIdsByBlock[block] ??= []).push(voice);
}

function blockTimingFingerprint(block) {
  if (!block) return "";
  return JSON.stringify({
    duration: block.duration ?? null,
    scale: block.scale ?? null,
    timeSignature: block.timeSignature ?? null
  });
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
