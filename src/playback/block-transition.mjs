export async function activatePreparedBlockTransition({ rnbo, nextBlockId, resetPhase }) {
  if (!rnbo?.applyBlockUpdate) throw new Error("RNBO block activation is unavailable");
  const update = await rnbo.applyBlockUpdate(nextBlockId, {
    activationMode: "continue",
    reusePrepared: true
  });
  if (!["active", "no-targets"].includes(update.state)) {
    throw new Error(`block '${nextBlockId}' activation did not reach ACTIVE on every required client`);
  }
  const phaseWrites = update.state === "no-targets" ? [] : await resetPhase();
  return {
    action: "ActivatePrepared",
    value: 1,
    writes: phaseWrites,
    activations: update.activations ?? [],
    update
  };
}
