export function resolveOscAssignments(assignments = {}, targets = []) {
  return Object.fromEntries(Object.entries(assignments).map(([roleId, assignment]) => [
    roleId,
    resolveOscAssignment(roleId, assignment, targets)
  ]));
}

export function resolveOscAssignment(roleId, assignment = {}, targets = []) {
  const role = stringField(roleId);
  const app = cleanToken(assignment.app);
  const deviceId = stringField(assignment.deviceId);
  const currentTargetId = stringField(assignment.oscTargetId);
  const locked = Boolean(assignment.locked);
  const ignored = Boolean(assignment.ignoreRecall);
  const exactTarget = targets.find((target) => target.id === currentTargetId);
  const compatible = targets.filter((target) => targetMatches(target, { app, deviceId }));
  const onlineCompatible = compatible.filter(targetIsOnline);
  const ambiguousCompatible = compatible.filter((target) => target.status === "ambiguous");

  if (!currentTargetId && !deviceId) {
    return resolution(role, assignment, "unassigned", undefined, compatible, "Role has no stable device or target assignment.");
  }

  if (locked) {
    if (!exactTarget) {
      return resolution(role, assignment, "offline", undefined, compatible, `Locked target '${currentTargetId || deviceId}' is unavailable.`);
    }
    if (exactTarget.status === "ambiguous") {
      return resolution(role, assignment, "ambiguous", undefined, compatible, `Locked target '${currentTargetId}' is ambiguous.`);
    }
    if (!targetIsOnline(exactTarget)) {
      return resolution(role, assignment, "offline", exactTarget, compatible, `Locked target '${currentTargetId}' is offline or not sendable.`);
    }
    return resolution(role, assignment, ignored ? "ignored" : "online", exactTarget, compatible,
      ignored ? "Recall is disabled for this role." : "Locked target is online.");
  }

  if (exactTarget && targetIsOnline(exactTarget) && targetMatches(exactTarget, { app, deviceId }, { allowEmptyDevice: true })) {
    return resolution(role, assignment, ignored ? "ignored" : "online", exactTarget, compatible,
      ignored ? "Recall is disabled for this role." : "Assigned target is online.");
  }

  if (ambiguousCompatible.length || onlineCompatible.length > 1) {
    return resolution(role, assignment, "ambiguous", undefined, compatible,
      `${Math.max(ambiguousCompatible.length, onlineCompatible.length)} compatible live targets require an explicit locked selection.`);
  }

  if (onlineCompatible.length === 1) {
    const target = onlineCompatible[0];
    return resolution(role, assignment, ignored ? "ignored" : "online", target, compatible,
      ignored ? "Recall is disabled for this role." : "Assigned target is online.");
  }

  return resolution(role, assignment, "offline", exactTarget, compatible,
    `No online target matches device '${deviceId || "unassigned"}' and app '${app || "unassigned"}'.`);
}

export function reconcileOscAssignments(assignments = {}, targets = []) {
  const resolutions = resolveOscAssignments(assignments, targets);
  const nextAssignments = {};
  const changed = [];
  for (const [roleId, assignment] of Object.entries(assignments)) {
    const resolved = resolutions[roleId];
    const next = {
      ...assignment,
      ...(!assignment.locked && resolved.target?.id ? { oscTargetId: resolved.target.id } : {}),
      routingStatus: ["online", "ignored"].includes(resolved.status) ? "" : resolved.status,
      routingMessage: resolved.message
    };
    nextAssignments[roleId] = next;
    if (!sameDocument(assignment, next)) {
      changed.push({
        roleId,
        previousTargetId: stringField(assignment.oscTargetId),
        targetId: stringField(next.oscTargetId),
        status: resolved.status,
        message: resolved.message
      });
    }
  }
  return { assignments: nextAssignments, resolutions, changed };
}

function resolution(roleId, assignment, status, target, compatible, message) {
  return {
    roleId,
    status,
    targetId: target?.id ?? stringField(assignment.oscTargetId),
    target,
    compatibleTargetIds: compatible.map((entry) => entry.id),
    locked: Boolean(assignment.locked),
    ignored: Boolean(assignment.ignoreRecall),
    sendable: status === "online" && Boolean(target?.sendable),
    message
  };
}

function targetMatches(target, identity, options = {}) {
  const app = cleanToken(identity.app);
  const deviceId = stringField(identity.deviceId);
  const targetDeviceId = stringField(target.deviceId ?? target.unitId);
  const appMatches = !app || cleanToken(target.app) === app || (target.capabilities ?? []).includes(`${app}-edit`);
  const deviceMatches = !deviceId ? Boolean(options.allowEmptyDevice) : targetDeviceId === deviceId || stringField(target.unitId) === deviceId;
  return appMatches && deviceMatches;
}

function targetIsOnline(target) {
  return target?.status === "online" && target.sendable === true;
}

function sameDocument(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
