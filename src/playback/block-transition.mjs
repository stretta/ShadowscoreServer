export async function activatePreparedBlockTransition({ rnbo, nextBlockId }) {
  if (!rnbo?.applyBlockUpdate) throw new Error("RNBO block activation is unavailable");
  const update = rnbo.activatePreparedBlock
    ? await rnbo.activatePreparedBlock(nextBlockId, { boundary: "next-cycle" })
    : await rnbo.applyBlockUpdate(nextBlockId, {
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
