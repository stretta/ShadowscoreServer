import { sendOscMessage } from "../osc/send.mjs";
import { normalizeSwing, normalizeSwingAmt } from "./swing.mjs";

const SEQUENCER_APPS = new Set([
  "analogsequencer",
  "listsequencer",
  "listvelsequencer",
  "triggerseq",
  "triggersequencer"
]);

export async function distributeBlockSwing(score, blockId, targets, options = {}) {
  const block = score?.mesostructure?.[blockId];
  if (!block) throw new Error(`unknown mesostructural block '${blockId}'`);
  const swing = normalizeSwing(block.swing);
  const swingAmt = normalizeSwingAmt(block.swingAmt);
  const selected = options.targetIds === undefined ? null : new Set(options.targetIds.map(String));
  const candidates = (targets ?? []).filter(isSequencerSwingTarget);
  const results = await Promise.all(candidates.map(async (target) => {
    if (selected && !selected.has(target.id) && !selected.has(target.rnboTargetId)) return skipped(target, "not-selected");
    if (target.status !== "online" || !target.sendable) return skipped(target, target.status || "offline");
    const swingParameter = findParameter(target, "swing");
    const amountParameter = findParameter(target, "swingamt");
    if (!swingParameter?.address || !amountParameter?.address) return skipped(target, "missing-swing-parameters");
    const writes = [
      { parameter: amountParameter, args: [swingAmt] },
      { parameter: swingParameter, args: [swingWireValue(swingParameter, swing)] }
    ];
    const sent = [];
    try {
      for (const write of writes) {
        const send = await sendOscMessage(target, write.parameter.address, write.args, { sender: options.sender });
        sent.push({ parameter: write.parameter.name, address: write.parameter.address, args: write.args, send });
      }
      return { ok: true, status: "sent", targetId: target.id, swing, swingAmt, writes: sent };
    } catch (error) {
      return { ok: false, status: "failed", targetId: target.id, swing, swingAmt, writes: sent, error: error?.message ?? String(error) };
    }
  }));
  return {
    ok: results.every((entry) => entry.ok || entry.status === "skipped"),
    blockId,
    swing,
    swingAmt,
    attemptedCount: results.filter((entry) => entry.status === "sent" || entry.status === "failed").length,
    succeededCount: results.filter((entry) => entry.status === "sent").length,
    failedCount: results.filter((entry) => entry.status === "failed").length,
    skippedCount: results.filter((entry) => entry.status === "skipped").length,
    results
  };
}

export function isSequencerSwingTarget(target) {
  const app = String(target?.app ?? "").trim().toLowerCase();
  return SEQUENCER_APPS.has(app) && Boolean(findParameter(target, "swing") && findParameter(target, "swingamt"));
}

function findParameter(target, semanticName) {
  return (target?.parameters ?? []).find((parameter) => normalizeName(parameter?.key ?? parameter?.name) === semanticName)
    ?? (target?.parameters ?? []).find((parameter) => normalizeName(parameter?.name) === semanticName);
}

function normalizeName(value) {
  return String(value ?? "").split("/").at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function swingWireValue(parameter, swing) {
  if (parameter?.type !== "s" || !Array.isArray(parameter.values)) return swing;
  const desired = swing ? "on" : "off";
  return parameter.values.map(String).find((value) => value.trim().toLowerCase() === desired) ?? swing;
}

function skipped(target, reason) {
  return { ok: true, status: "skipped", targetId: target.id, reason };
}
