export function createPlaybackPreparationState(options = {}) {
  const impactLimit = Math.max(1, Number(options.impactLimit) || 100);
  const impacts = [];
  const desiredHashes = new Map();
  const dirtyVoicesByBlock = new Map();
  let invalidateAll = false;

  return {
    recordImpact(impact, options = {}) {
      impacts.push(structuredClone(impact));
      if (impacts.length > impactLimit) impacts.splice(0, impacts.length - impactLimit);
      if (impact?.invalidateAll) invalidateAll = true;
      if (options.affectsPlayback !== true) return;
      for (const blockId of impact.blockIds ?? []) {
        const dirty = dirtyVoicesByBlock.get(blockId) ?? new Set();
        for (const voiceId of voicesForBlock(impact, blockId)) dirty.add(voiceId);
        dirtyVoicesByBlock.set(blockId, dirty);
      }
      for (const [key, cached] of desiredHashes) {
        if (!impact.invalidateAll && !(impact.blockIds ?? []).includes(cached.blockId)) continue;
        if (!impact.invalidateAll && !voicesForBlock(impact, cached.blockId).includes(cached.voiceId)) continue;
        desiredHashes.delete(key);
      }
    },
    impacts() {
      return structuredClone(impacts);
    },
    latestImpact() {
      return structuredClone(impacts.at(-1) ?? null);
    },
    invalidatesAll() {
      return invalidateAll;
    },
    selectVoices(blockId, assignedVoiceIds, hasRecord) {
      const assigned = [...assignedVoiceIds];
      if (invalidateAll) return assigned;
      const dirty = dirtyVoicesByBlock.get(blockId);
      const missing = assigned.filter((voiceId) => !hasRecord(voiceId));
      if (!dirty) return missing;
      return [...new Set([...dirty, ...missing])];
    },
    desiredHash(blockId, targetId) {
      return desiredHashes.get(cacheKey(blockId, targetId))?.hash ?? null;
    },
    cacheDesiredHash(blockId, targetId, voiceId, hash) {
      desiredHashes.set(cacheKey(blockId, targetId), { blockId, voiceId, hash });
      return hash;
    },
    clearPrepared(deliveries = []) {
      for (const delivery of deliveries) {
        if (delivery?.ok !== true) continue;
        const blockId = String(delivery.blockId ?? "").trim();
        const voiceId = String(delivery.voiceId ?? "").trim();
        dirtyVoicesByBlock.get(blockId)?.delete(voiceId);
        if (dirtyVoicesByBlock.get(blockId)?.size === 0) dirtyVoicesByBlock.delete(blockId);
      }
      if (dirtyVoicesByBlock.size === 0) invalidateAll = false;
    },
    clear() {
      impacts.length = 0;
      desiredHashes.clear();
      dirtyVoicesByBlock.clear();
      invalidateAll = false;
    }
  };
}

function voicesForBlock(impact, blockId) {
  if (!impact || !(impact.blockIds ?? []).includes(blockId)) return [];
  return [...(impact.voiceIdsByBlock?.[blockId] ?? [])];
}

function cacheKey(blockId, targetId) {
  return `${blockId}\u001f${targetId}`;
}
