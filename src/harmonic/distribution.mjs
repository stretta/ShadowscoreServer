import { normalizeTtid } from "./scale.mjs";
import { sendOscMessage } from "../osc/send.mjs";

export async function distributeBlockTtid(score, blockId, targets, options = {}) {
  const block = score?.mesostructure?.[blockId];
  if (!block) throw new Error(`unknown mesostructural block '${blockId}'`);
  const ttid = normalizeTtid(block.ttid);
  const selected = options.targetIds === undefined ? null : new Set(options.targetIds.map(String));
  const candidates = (targets ?? []).filter((target) => (target.capabilities ?? []).includes("ttid-edit"));
  const results = await Promise.all(candidates.map(async (target) => {
    if (selected && !selected.has(target.id) && !selected.has(target.rnboTargetId)) {
      return skipped(target, "not-selected");
    }
    if (target.status !== "online" || !target.sendable) return skipped(target, target.status || "offline");
    if (targetIgnoresScale(score, target)) return skipped(target, "ignore-scale");
    const parameter = (target.parameters ?? []).find((entry) => isTtidParameter(entry));
    if (!parameter?.address) return skipped(target, "missing-ttid-parameter");
    try {
      const send = await sendOscMessage(target, parameter.address, [ttid], { sender: options.sender });
      return { ok: true, status: "sent", targetId: target.id, parameter: parameter.name, address: parameter.address, ttid, send };
    } catch (error) {
      return { ok: false, status: "failed", targetId: target.id, parameter: parameter.name, address: parameter.address, ttid, error: error?.message ?? String(error) };
    }
  }));
  return {
    ok: results.every((entry) => entry.ok || entry.status === "skipped"),
    blockId,
    ttid,
    attemptedCount: results.filter((entry) => entry.status === "sent" || entry.status === "failed").length,
    succeededCount: results.filter((entry) => entry.status === "sent").length,
    failedCount: results.filter((entry) => entry.status === "failed").length,
    skippedCount: results.filter((entry) => entry.status === "skipped").length,
    results
  };
}

export function isTtidParameter(parameter) {
  const editor = parameter?.meta?.editor;
  return Array.isArray(editor)
    ? editor.some((value) => String(value).trim().toLowerCase() === "ttid")
    : String(editor ?? "").trim().toLowerCase() === "ttid";
}

function targetIgnoresScale(score, target) {
  if (target.ignoreScale === true || target.metadata?.ignoreScale === true || target.meta?.ignoreScale === true) return true;
  return Object.values(score?.oscAssignments ?? {}).some((assignment) => assignment?.ignoreScale === true && (
    assignment.oscTargetId === target.id
    || assignment.oscTargetId === target.rnboTargetId
    || (assignment.deviceId && [target.deviceId, target.unitId].includes(assignment.deviceId))
  ));
}

function skipped(target, reason) {
  return { ok: true, status: "skipped", targetId: target.id, reason };
}
