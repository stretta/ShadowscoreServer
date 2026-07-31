import { randomUUID } from "node:crypto";

import { resolveOscAssignment } from "./assignments.mjs";
import { oscPacketByteLength, sendOscMessage } from "./send.mjs";
import { snapshotControlDisposition } from "./snapshot-contract.mjs";

const DEFAULT_HISTORY_LIMIT = 20;

export function compileOscSnapshot(snapshot, target, context = {}) {
  const writesByGroup = {
    params: [],
    inputPorts: [],
    late: [],
    preClock: [],
    clock: []
  };
  const missingControls = [];
  const excludedControls = [];

  for (const [name, value] of Object.entries(snapshot.params ?? {})) {
    compileControl({
      kind: "param",
      name,
      args: [value],
      liveControl: (target.parameters ?? []).find((entry) => (entry.key ?? entry.name) === name)
        ?? (target.parameters ?? []).find((entry) => entry.name === name),
      writesByGroup,
      missingControls,
      excludedControls,
      context
    });
  }
  for (const [name, args] of Object.entries(snapshot.inputPorts ?? {})) {
    compileControl({
      kind: "inputPort",
      name,
      args,
      liveControl: (target.inputPorts ?? []).find((entry) => entry.name === name),
      writesByGroup,
      missingControls,
      excludedControls,
      context
    });
  }

  compileRecallOptions(snapshot, target, writesByGroup, missingControls, context);

  const writes = [
    ...writesByGroup.params,
    ...writesByGroup.inputPorts,
    ...writesByGroup.late,
    ...writesByGroup.preClock,
    ...writesByGroup.clock
  ].map((write, index) => ({ ...write, index }));
  return { writes, missingControls, excludedControls };
}

function compileRecallOptions(snapshot, target, writesByGroup, missingControls, context) {
  if (snapshot.app !== "analogsequencer" || snapshot.recall?.rtzBeforePlay !== true || !clockStartsPlayback(snapshot.params)) return;
  const inputPort = (target.inputPorts ?? []).find((entry) => String(entry.name ?? "").toLowerCase() === "rtz");
  if (!inputPort?.address) {
    missingControls.push({ kind: "inputPort", name: "rtz", reason: "missing-live-control" });
    return;
  }
  writesByGroup.preClock.push({
    blockId: context.blockId,
    roleId: context.roleId,
    targetId: context.targetId,
    kind: "inputPort",
    name: inputPort.name,
    group: "preClock",
    address: inputPort.address,
    args: [1],
    packetBytes: oscPacketByteLength(inputPort.address, [1])
  });
}

function clockStartsPlayback(params = {}) {
  const entry = Object.entries(params).find(([name]) => name.toLowerCase() === "clock");
  if (!entry) return false;
  const value = String(entry[1]).trim().toLowerCase();
  return value === "on" || value === "1";
}

export function compileOscBlockRecall(score, blockId, targets, options = {}) {
  const block = score.mesostructure?.[blockId];
  if (!block) {
    throw new Error(`unknown mesostructural block '${blockId}'`);
  }
  const layers = block.oscLayers ?? {};
  const roleIds = normalizeRequestedRoles(options.roles, layers);
  return {
    blockId,
    roleIds,
    roles: roleIds.map((roleId) => compileRole(score, blockId, roleId, layers[roleId], targets))
  };
}

export async function dispatchOscBlockRecall(score, blockId, targets, options = {}) {
  const clock = options.now ?? Date.now;
  const monotonicClock = options.monotonicNow
    ?? (options.now ? clock : globalThis.performance?.now?.bind(globalThis.performance))
    ?? clock;
  const startedMs = clock();
  const dispatchStartedMonotonic = monotonicClock();
  const compiled = compileOscBlockRecall(score, blockId, targets, options);
  const resultByRole = new Map();
  const targetGroups = new Map();

  for (const role of compiled.roles) {
    if (role.skippedReason) {
      resultByRole.set(role.roleId, skippedRoleResult(role, startedMs, clock()));
      continue;
    }
    if (!targetGroups.has(role.targetId)) targetGroups.set(role.targetId, []);
    targetGroups.get(role.targetId).push(role);
  }

  await Promise.all([...targetGroups.values()].map(async (roles) => {
    for (const role of roles) {
      resultByRole.set(role.roleId, await dispatchRole(role, {
        dryRun: Boolean(options.dryRun),
        sender: options.sender,
        now: clock,
        monotonicNow: monotonicClock,
        dispatchStartedMonotonic
      }));
    }
  }));

  const roleResults = compiled.roleIds.map((roleId) => resultByRole.get(roleId));
  const completedMs = clock();
  const totals = totalResults(roleResults);
  const dispatchOffsets = roleResults.flatMap((role) => role.writes ?? [])
    .filter((write) => write.status !== "planned")
    .flatMap((write) => [write.startedOffsetMs, write.completedOffsetMs])
    .filter(Number.isFinite);
  return {
    id: options.id ?? randomUUID(),
    ok: totals.failedWriteCount === 0,
    blockId,
    dryRun: Boolean(options.dryRun),
    requestedRoles: options.roles ? compiled.roleIds : [],
    startedAt: isoTime(startedMs),
    completedAt: isoTime(completedMs),
    durationMs: duration(startedMs, completedMs),
    dispatchDurationMs: dispatchOffsets.length ? Math.max(...dispatchOffsets) - Math.min(...dispatchOffsets) : 0,
    ...totals,
    roles: roleResults
  };
}

export function createOscSnapshotRecallService(options = {}) {
  const historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  const history = [];
  return {
    async recall(document) {
      const result = await dispatchOscBlockRecall(document.score, document.blockId, document.targets, {
        roles: document.roles,
        dryRun: document.dryRun,
        sender: document.sender ?? options.sender,
        now: options.now,
        monotonicNow: options.monotonicNow,
        id: options.idFactory?.()
      });
      history.unshift(structuredClone(result));
      history.length = Math.min(history.length, historyLimit);
      return result;
    },
    snapshot(filters = {}) {
      const entries = filters.blockId
        ? history.filter((entry) => entry.blockId === filters.blockId)
        : history;
      return {
        historyLimit,
        last: structuredClone(entries[0] ?? null),
        history: structuredClone(entries)
      };
    }
  };
}

function compileRole(score, blockId, roleId, layer, targets) {
  const assignment = score.oscAssignments?.[roleId];
  if (!assignment) {
    return skippedRole(blockId, roleId, {}, "missing-role", `OSC role '${roleId}' does not exist.`);
  }
  if (!layer?.clipId) {
    return skippedRole(blockId, roleId, assignment, "missing-layer", "No OSC clip is assigned to this role in the block.");
  }
  const clip = score.oscClips?.[layer.clipId];
  if (!clip) {
    return { ...skippedRole(blockId, roleId, assignment, "missing-clip", `OSC clip '${layer.clipId}' does not exist.`), clipId: layer.clipId };
  }
  const resolution = resolveOscAssignment(roleId, assignment, targets);
  if (resolution.status !== "online" || !resolution.target) {
    return { ...skippedRole(blockId, roleId, assignment, resolution.status, resolution.message, resolution), clipId: layer.clipId };
  }
  if (!targetSupportsApp(resolution.target, clip.app)) {
    return { ...skippedRole(blockId, roleId, assignment, "app-mismatch",
      `Resolved target '${resolution.target.id}' does not support OSC clip app '${clip.app}'.`, resolution), clipId: layer.clipId };
  }
  const compiled = compileOscSnapshot(clip, resolution.target, { blockId, roleId, targetId: resolution.target.id });
  if (compiled.writes.length === 0) {
    return {
      ...skippedRole(blockId, roleId, assignment, "no-supported-controls", "No saved controls are supported by the resolved target.", resolution),
      clipId: layer.clipId,
      ...compiled
    };
  }
  return {
    blockId,
    roleId,
    clipId: layer.clipId,
    targetId: resolution.target.id,
    routingStatus: resolution.status,
    assignment: structuredClone(assignment),
    target: resolution.target,
    ...compiled
  };
}

function compileControl(options) {
  const { kind, name, args, liveControl, writesByGroup, missingControls, excludedControls, context } = options;
  if (!liveControl?.address) {
    missingControls.push({ kind, name, reason: "missing-live-control" });
    return;
  }
  const disposition = snapshotControlDisposition({ kind, name, meta: liveControl.meta });
  if (disposition.state === "excluded") {
    excludedControls.push({ kind, name, reason: disposition.reason });
    return;
  }
  const wireArgs = kind === "param" ? liveParameterArgs(liveControl, args, missingControls, name) : args;
  if (!wireArgs) return;
  const group = disposition.state === "clock"
    ? "clock"
    : disposition.state === "late"
      ? "late"
      : kind === "param" ? "params" : "inputPorts";
  writesByGroup[group].push({
    blockId: context.blockId,
    roleId: context.roleId,
    targetId: context.targetId,
    kind,
    name,
    group,
    address: liveControl.address,
    args: structuredClone(wireArgs),
    packetBytes: oscPacketByteLength(liveControl.address, wireArgs)
  });
}

function liveParameterArgs(control, args, missingControls, name) {
  if (control.type !== "s" || !Array.isArray(control.values) || control.values.length === 0) return args;
  const choices = Array.from(new Set(control.values.map(String)));
  const index = Number(args[0]);
  if (isMaxCountName(name) && Number.isInteger(index) && index >= 0 && index < choices.length) {
    // AnalogSequencer reports stages from 1, but MaxCnt is the zero-based terminal
    // counter value. A saved UI count of 16 is enum index 15 and must send "15".
    const terminalCount = String(Math.max(1, index));
    if (choices.includes(terminalCount)) return [terminalCount];
  }
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
    const legacyChoice = choices.find((choice) => choice === String(args[0]));
    if (legacyChoice !== undefined) return [legacyChoice];
    missingControls.push({ kind: "param", name, reason: "invalid-enum-index", value: args[0], choiceCount: choices.length });
    return null;
  }
  return [choices[index]];
}

function isMaxCountName(name) {
  return /^(?:maxcount|maxcnt)$/i.test(String(name ?? ""));
}

async function dispatchRole(role, options) {
  const startedMs = options.now();
  const writes = [];
  if (options.dryRun) {
    for (const write of role.writes) writes.push({
      ...withoutTarget(write),
      status: "planned",
      startedOffsetMs: null,
      completedOffsetMs: null,
      durationMs: 0
    });
  } else {
    for (const write of role.writes) {
      const writeStartedMonotonic = options.monotonicNow();
      try {
        await sendOscMessage(role.target, write.address, write.args, { sender: options.sender });
        const writeCompletedMonotonic = options.monotonicNow();
        writes.push(timedWrite(write, "sent", writeStartedMonotonic, writeCompletedMonotonic, options.dispatchStartedMonotonic));
      } catch (error) {
        const writeCompletedMonotonic = options.monotonicNow();
        writes.push({
          ...timedWrite(write, "failed", writeStartedMonotonic, writeCompletedMonotonic, options.dispatchStartedMonotonic),
          error: messageForError(error)
        });
      }
    }
  }
  const completedMs = options.now();
  const succeededWriteCount = writes.filter((write) => write.status === "sent").length;
  const failedWriteCount = writes.filter((write) => write.status === "failed").length;
  return {
    blockId: role.blockId,
    roleId: role.roleId,
    clipId: role.clipId,
    assignment: structuredClone(role.assignment),
    targetId: role.targetId,
    routingStatus: role.routingStatus,
    status: options.dryRun
      ? "dry-run"
      : failedWriteCount === 0
        ? role.missingControls.length || role.excludedControls.length ? "sent-with-warnings" : "sent"
        : succeededWriteCount ? "partial" : "failed",
    plannedWriteCount: role.writes.length,
    attemptedWriteCount: options.dryRun ? 0 : writes.length,
    succeededWriteCount,
    failedWriteCount,
    plannedPacketBytes: sum(writes, "packetBytes"),
    attemptedPacketBytes: options.dryRun ? 0 : sum(writes, "packetBytes"),
    succeededPacketBytes: sum(writes.filter((write) => write.status === "sent"), "packetBytes"),
    failedPacketBytes: sum(writes.filter((write) => write.status === "failed"), "packetBytes"),
    missingControls: structuredClone(role.missingControls),
    excludedControls: structuredClone(role.excludedControls),
    writes,
    startedAt: isoTime(startedMs),
    completedAt: isoTime(completedMs),
    durationMs: duration(startedMs, completedMs)
  };
}

function timedWrite(write, status, startedMonotonic, completedMonotonic, dispatchStartedMonotonic) {
  return {
    ...withoutTarget(write),
    status,
    startedOffsetMs: duration(dispatchStartedMonotonic, startedMonotonic),
    completedOffsetMs: duration(dispatchStartedMonotonic, completedMonotonic),
    durationMs: duration(startedMonotonic, completedMonotonic)
  };
}

function skippedRole(blockId, roleId, assignment, reason, message, resolution = {}) {
  return {
    blockId,
    roleId,
    assignment: structuredClone(assignment),
    targetId: resolution.targetId ?? assignment.oscTargetId ?? "",
    routingStatus: resolution.status ?? assignment.routingStatus ?? "unassigned",
    skippedReason: reason,
    skippedMessage: message,
    writes: [],
    missingControls: [],
    excludedControls: []
  };
}

function skippedRoleResult(role, startedMs, completedMs) {
  return {
    blockId: role.blockId,
    roleId: role.roleId,
    clipId: role.clipId,
    assignment: structuredClone(role.assignment),
    targetId: role.targetId,
    routingStatus: role.routingStatus,
    status: "skipped",
    skippedReason: role.skippedReason,
    skippedMessage: role.skippedMessage,
    plannedWriteCount: 0,
    attemptedWriteCount: 0,
    succeededWriteCount: 0,
    failedWriteCount: 0,
    plannedPacketBytes: 0,
    attemptedPacketBytes: 0,
    succeededPacketBytes: 0,
    failedPacketBytes: 0,
    missingControls: structuredClone(role.missingControls),
    excludedControls: structuredClone(role.excludedControls),
    writes: [],
    startedAt: isoTime(startedMs),
    completedAt: isoTime(completedMs),
    durationMs: duration(startedMs, completedMs)
  };
}

function normalizeRequestedRoles(roles, snapshots) {
  if (roles === undefined || roles === null) return Object.keys(snapshots);
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string" || !role.trim())) {
    throw new Error("roles must be an array of non-empty role ids");
  }
  return [...new Set(roles.map((role) => role.trim()))];
}

function targetSupportsApp(target, app) {
  const normalized = cleanToken(app);
  return cleanToken(target.app) === normalized || (target.capabilities ?? []).includes(`${normalized}-edit`);
}

function totalResults(roles) {
  return {
    roleCount: roles.length,
    sentRoleCount: roles.filter((role) => ["sent", "sent-with-warnings"].includes(role.status)).length,
    partialRoleCount: roles.filter((role) => role.status === "partial").length,
    skippedRoleCount: roles.filter((role) => role.status === "skipped").length,
    failedRoleCount: roles.filter((role) => role.status === "failed").length,
    dryRunRoleCount: roles.filter((role) => role.status === "dry-run").length,
    plannedWriteCount: sum(roles, "plannedWriteCount"),
    attemptedWriteCount: sum(roles, "attemptedWriteCount"),
    succeededWriteCount: sum(roles, "succeededWriteCount"),
    failedWriteCount: sum(roles, "failedWriteCount"),
    plannedPacketBytes: sum(roles, "plannedPacketBytes"),
    attemptedPacketBytes: sum(roles, "attemptedPacketBytes"),
    succeededPacketBytes: sum(roles, "succeededPacketBytes"),
    failedPacketBytes: sum(roles, "failedPacketBytes")
  };
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + (entry[field] ?? 0), 0);
}

function withoutTarget(write) {
  return structuredClone(write);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function duration(startedMs, completedMs) {
  return Math.max(0, completedMs - startedMs);
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function cleanToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
