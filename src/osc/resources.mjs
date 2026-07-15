import { resolveOscAssignments } from "./assignments.mjs";

export function buildOscResourceReport(assignments = {}, targets = []) {
  const resolutions = resolveOscAssignments(assignments, targets);
  const roles = Object.entries(assignments).sort(([left], [right]) => left.localeCompare(right)).map(([roleId, assignment]) => {
    const resolution = resolutions[roleId];
    return {
      roleId,
      label: assignment.label || roleId,
      app: assignment.app || "",
      deviceId: assignment.deviceId || "",
      targetId: resolution.target?.id || assignment.oscTargetId || "",
      status: roleResourceStatus(resolution),
      routingStatus: resolution.status,
      compatibleTargetIds: [...(resolution.compatibleTargetIds ?? [])],
      message: resolution.message
    };
  });
  const resources = targets.map((target) => {
    const mappedRoleIds = roles.filter((role) => role.targetId === target.id && role.status === "mapped").map((role) => role.roleId);
    const compatibleRoleIds = roles.filter((role) => role.compatibleTargetIds.includes(target.id) && !mappedRoleIds.includes(role.roleId)).map((role) => role.roleId);
    return {
      targetId: target.id,
      label: target.label || target.id,
      app: target.app || "",
      deviceId: target.deviceId || target.unitId || "",
      instance: target.instance || "",
      status: targetResourceStatus(target, mappedRoleIds, compatibleRoleIds),
      mappedRoleIds,
      compatibleRoleIds
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
  return { assignments, resolutions, targets, roles, resources };
}

function roleResourceStatus(resolution) {
  if (["online", "ignored"].includes(resolution.status) && resolution.target) return "mapped";
  if (resolution.status === "ambiguous") return "ambiguous";
  if (resolution.status === "offline") return "offline";
  if (resolution.compatibleTargetIds?.length) return "compatible";
  return "unmapped";
}

function targetResourceStatus(target, mappedRoleIds, compatibleRoleIds) {
  if (mappedRoleIds.length) return "mapped";
  if (target.status === "ambiguous") return "ambiguous";
  if (target.status !== "online" || !target.sendable) return "offline";
  if (compatibleRoleIds.length) return "compatible";
  return "unmapped";
}
