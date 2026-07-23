export function reconcilePlayerStructure({ voices = {}, clips = {}, mesostructure = {} } = {}) {
  const knownPlayers = new Set(Object.keys(voices));
  const removedClipIds = new Set();

  const nextMesostructure = Object.fromEntries(
    Object.entries(mesostructure).map(([blockId, block]) => {
      const players = Object.fromEntries(
        Object.entries(block?.players ?? {}).filter(([playerId, assignment]) => {
          if (knownPlayers.has(playerId)) return true;
          const clipId = assignedClipId(assignment);
          if (clipId) removedClipIds.add(clipId);
          return false;
        })
      );
      return [blockId, { ...block, players }];
    })
  );

  const referencedClipIds = new Set(
    Object.values(nextMesostructure).flatMap((block) =>
      Object.values(block?.players ?? {}).map(assignedClipId).filter(Boolean)
    )
  );
  const orphanedRemovedClipIds = [...removedClipIds].filter((clipId) => !referencedClipIds.has(clipId));
  const orphanedRemovedClipIdSet = new Set(orphanedRemovedClipIds);
  const nextClips = Object.fromEntries(
    Object.entries(clips).filter(([clipId]) => !orphanedRemovedClipIdSet.has(clipId))
  );

  return {
    clips: nextClips,
    mesostructure: nextMesostructure,
    removedClipIds: orphanedRemovedClipIds.sort()
  };
}

function assignedClipId(assignment) {
  if (typeof assignment === "string") return assignment.trim();
  return typeof assignment?.clipId === "string" ? assignment.clipId.trim() : "";
}
