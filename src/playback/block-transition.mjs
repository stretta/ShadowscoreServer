export async function activatePreparedBlockTransition({ coordinator, rnbo, nextBlockId }) {
  const playback = coordinator ?? rnbo;
  if (!playback?.applyBlockUpdate) throw new Error("playback block activation is unavailable");
  const update = playback.activatePreparedBlock
    ? await playback.activatePreparedBlock(nextBlockId, { boundary: "next-cycle" })
    : await playback.applyBlockUpdate(nextBlockId, {
        activationMode: "continue",
        boundary: "next-cycle",
        reusePrepared: true
      });
  if (!["active", "no-targets"].includes(update.state)) {
    throw new Error(`block '${nextBlockId}' activation did not reach ACTIVE on every required client`);
  }
  return {
    action: "ActivatePrepared",
    value: 1,
    writes: [],
    activations: update.activations ?? [],
    update
  };
}
