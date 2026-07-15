export async function runAutomaticOscOnboarding({ store, config, loadTargets, captureTarget }) {
  const policy = config?.osc?.onboarding?.automatic ?? {};
  if (policy.enabled !== true) return { enabled: false, onboarded: [], skipped: [] };
  const templates = Array.isArray(policy.roles) ? policy.roles : [];
  const onboarded = [];
  const skipped = [];
  let targets;
  try {
    targets = await loadTargets();
  } catch (error) {
    return {
      enabled: true,
      onboarded,
      skipped: [{ roleId: "", status: "discovery-failed", message: error?.message || String(error) }]
    };
  }

  for (const template of templates) {
    const roleId = stringField(template?.roleId);
    const app = cleanToken(template?.app);
    const deviceId = stringField(template?.deviceId);
    if (!roleId || !app || !deviceId) {
      skipped.push({ roleId, status: "invalid-policy", message: "Automatic onboarding requires roleId, app, and deviceId." });
      continue;
    }
    const matches = targets.filter((target) => target.status === "online" && target.sendable === true
      && cleanToken(target.app) === app && [target.deviceId, target.unitId].map(stringField).includes(deviceId));
    if (matches.length !== 1) {
      skipped.push({
        roleId,
        status: matches.length ? "ambiguous" : "unavailable",
        targetIds: matches.map((target) => target.id),
        message: matches.length ? `${matches.length} live targets match the configured identity.` : "No live target matches the configured identity."
      });
      continue;
    }
    const target = matches[0];
    const before = store.getScore();
    const blockId = stringField(template.blockId) || before.structureState?.activeBlockId;
    if (!blockId || !before.mesostructure?.[blockId]) {
      skipped.push({ roleId, status: "invalid-block", message: `Unknown automatic onboarding block '${blockId || ""}'.` });
      continue;
    }
    const existingClipId = before.mesostructure[blockId]?.oscLayers?.[roleId]?.clipId;
    const clipId = stringField(template.clipId) || existingClipId || clipIdFor(blockId, roleId);
    let captured;
    try {
      captured = await captureTarget(target, template);
    } catch (error) {
      skipped.push({ roleId, status: "capture-failed", targetIds: [target.id], message: error?.message || String(error) });
      continue;
    }
    try {
      const assignment = {
        label: stringField(template.label) || target.label || roleId,
        app,
        deviceId,
        oscTargetId: target.id,
        ignoreRecall: Boolean(template.ignoreRecall),
        locked: Boolean(template.locked)
      };
      const score = store.onboardOscTarget(roleId, assignment, clipId, captured.clip, blockId);
      onboarded.push({
        roleId, clipId, blockId, targetId: target.id,
        complete: captured.complete, diagnostics: captured.diagnostics ?? [], scoreVersion: score.version
      });
    } catch (error) {
      skipped.push({ roleId, status: "mutation-rejected", targetIds: [target.id], message: error?.message || String(error) });
    }
  }
  return { enabled: true, onboarded, skipped };
}

function clipIdFor(blockId, roleId) {
  return `${String(blockId).toLowerCase()}-${roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
