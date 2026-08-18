export async function activatePreparedBlockTransition({ rnbo, nextBlockId }) {
  if (!rnbo?.applyBlockUpdate) throw new Error("RNBO block activation is unavailable");
  const update = await rnbo.applyBlockUpdate(nextBlockId, {
    activationMode: "continue",
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
