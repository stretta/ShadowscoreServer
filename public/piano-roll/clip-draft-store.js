export function createClipDraftStore(clone = structuredClone) {
  const entries = new Map();

  function open(clipId, document, version) {
    if (!entries.has(clipId)) {
      entries.set(clipId, makeEntry(document, version));
    }
    return entries.get(clipId);
  }

  function markDirty(clipId) {
    const entry = entries.get(clipId);
    if (entry) entry.dirty = true;
    return entry;
  }

  function revert(clipId) {
    const entry = entries.get(clipId);
    if (!entry) return undefined;
    if (entry.serverDocument) {
      entry.snapshot = clone(entry.serverDocument);
      entry.baseVersion = entry.serverVersion;
    }
    entry.draft = clone(entry.snapshot);
    entry.dirty = false;
    entry.stale = false;
    entry.serverDocument = undefined;
    entry.serverVersion = undefined;
    return entry;
  }

  function saved(clipId, document, version) {
    const entry = makeEntry(document, version);
    entries.set(clipId, entry);
    return entry;
  }

  function reconcile(score) {
    for (const [clipId, entry] of entries) {
      const serverDocument = score.clips?.[clipId];
      if (!serverDocument) {
        entry.stale = entry.dirty;
        continue;
      }
      if (!entry.dirty) {
        entries.set(clipId, makeEntry(serverDocument, score.version));
      } else if (sameDocument(serverDocument, entry.snapshot)) {
        entry.baseVersion = score.version;
        entry.stale = false;
      } else {
        entry.stale = true;
        entry.serverDocument = clone(serverDocument);
        entry.serverVersion = score.version;
      }
    }
  }

  return {
    open,
    get: (clipId) => entries.get(clipId),
    markDirty,
    revert,
    saved,
    reconcile,
    dirtyCount: () => [...entries.values()].filter((entry) => entry.dirty).length,
    staleCount: () => [...entries.values()].filter((entry) => entry.stale).length,
    hasDirty: () => [...entries.values()].some((entry) => entry.dirty)
  };

  function makeEntry(document, version) {
    return {
      snapshot: clone(document),
      draft: clone(document),
      baseVersion: version,
      dirty: false,
      stale: false
    };
  }
}

function sameDocument(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
