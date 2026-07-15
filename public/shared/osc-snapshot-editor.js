const MOMENTARY_INPUT_PORTS = new Set(["get", "panic", "probe", "reset", "rtz", "setstage"]);

export function mountOscSnapshotPanel(parent, options = {}) {
  if (!parent) throw new Error("OSC snapshot panel requires a parent element");
  const section = document.createElement("section");
  section.className = "ss-osc-snapshot-panel";
  section.setAttribute("aria-label", "Mesostructural OSC clips");
  section.innerHTML = `
    <div class="ss-osc-snapshot-head"><div><h2>Mesostructural OSC Clips</h2><div class="ss-osc-snapshot-detail">Capture one live instance into score state. Immediate write targets remain independent.</div></div><div data-snapshot-active class="ss-osc-snapshot-detail">Active block: —</div></div>
    <div class="ss-osc-snapshot-fields">
      <label><span>Capture state from</span><select data-snapshot-source></select></label>
      <label><span>Clip name</span><input data-snapshot-clip-name type="text" placeholder="Opening state"></label>
      <label><span>Clip id</span><input data-snapshot-clip-id type="text" placeholder="list-opening"></label>
      <label><span>Assign clip to block</span><select data-snapshot-block></select></label>
      <label><span>Logical role</span><select data-snapshot-role></select></label>
      <label><span>OSC clip browser</span><select data-snapshot-clip></select></label>
    </div>
    <div class="ss-osc-snapshot-actions"><div><button data-snapshot-capture class="primary" type="button">Capture as OSC Clip</button><button data-snapshot-load type="button">Load Clip into Editor</button><button data-snapshot-assign type="button">Assign Existing Clip</button><button data-snapshot-duplicate type="button">Duplicate Clip</button><button data-snapshot-recall type="button">Recall Layer Now</button></div><label class="ss-osc-snapshot-ignore"><input data-snapshot-ignore type="checkbox"> Ignore Shadowscore recall</label></div>
    <div class="ss-osc-snapshot-status"><div data-snapshot-state class="ss-osc-snapshot-state" role="status">Loading OSC clip state…</div><div data-snapshot-last class="ss-osc-snapshot-detail">No recall recorded</div></div>
  `;
  parent.insertBefore(section, options.before ?? null);
  return {
    panel: section,
    sourceSelect: section.querySelector("[data-snapshot-source]"),
    clipNameInput: section.querySelector("[data-snapshot-clip-name]"),
    clipIdInput: section.querySelector("[data-snapshot-clip-id]"),
    clipSelect: section.querySelector("[data-snapshot-clip]"),
    blockSelect: section.querySelector("[data-snapshot-block]"),
    roleSelect: section.querySelector("[data-snapshot-role]"),
    captureButton: section.querySelector("[data-snapshot-capture]"),
    loadButton: section.querySelector("[data-snapshot-load]"),
    assignButton: section.querySelector("[data-snapshot-assign]"),
    duplicateButton: section.querySelector("[data-snapshot-duplicate]"),
    recallButton: section.querySelector("[data-snapshot-recall]"),
    ignoreInput: section.querySelector("[data-snapshot-ignore]"),
    activeBlock: section.querySelector("[data-snapshot-active]"),
    state: section.querySelector("[data-snapshot-state]"),
    lastRecall: section.querySelector("[data-snapshot-last]")
  };
}

export function createOscSnapshotEditorClient(options) {
  const app = cleanToken(options.app);
  const elements = options.elements ?? {};
  if (!app || typeof options.serializeDraft !== "function" || typeof options.applySnapshot !== "function") {
    throw new Error("OSC snapshot editor client requires app, serializeDraft, and applySnapshot");
  }
  let score = null;
  let assignments = {};
  let resolutions = {};
  let targets = [];
  let events = null;

  bindEvents();

  return {
    async init() {
      await refreshContext();
      connectEvents();
      return snapshotState();
    },
    draftChanged() {
      renderStatus();
    },
    snapshotState,
    close() {
      events?.close?.();
    }
  };

  function bindEvents() {
    elements.blockSelect?.addEventListener("change", () => {
      selectLayerClip();
      renderStatus();
      loadLastRecall().catch(reportError);
    });
    elements.roleSelect?.addEventListener("change", () => { selectLayerClip(); renderStatus(); });
    elements.sourceSelect?.addEventListener("change", suggestClipIdentity);
    elements.clipSelect?.addEventListener("change", renderStatus);
    elements.clipIdInput?.addEventListener("input", renderStatus);
    elements.clipNameInput?.addEventListener("input", renderStatus);
    elements.captureButton?.addEventListener("click", () => capture().catch(reportError));
    elements.loadButton?.addEventListener("click", () => load().catch(reportError));
    elements.assignButton?.addEventListener("click", () => assign().catch(reportError));
    elements.duplicateButton?.addEventListener("click", () => duplicate().catch(reportError));
    elements.recallButton?.addEventListener("click", () => recall().catch(reportError));
    elements.ignoreInput?.addEventListener("change", () => saveIgnoreRecall().catch(reportError));
  }

  async function refreshContext() {
    const [nextScore, assignmentStatus, targetStatus] = await Promise.all([
      fetchJson("/score"),
      fetchJson("/osc/assignments?resolved=1"),
      fetchJson(`/osc/targets?app=${encodeURIComponent(app)}&status=online`)
    ]);
    score = nextScore;
    assignments = assignmentStatus.assignments ?? {};
    resolutions = assignmentStatus.resolutions ?? {};
    targets = targetStatus.targets ?? [];
    renderContext();
    await loadLastRecall();
  }

  function renderContext() {
    const previousBlock = elements.blockSelect.value;
    const previousRole = elements.roleSelect.value;
    const previousSource = elements.sourceSelect?.value;
    const previousClip = elements.clipSelect?.value;
    const blockIds = Object.keys(score?.mesostructure ?? {});
    elements.blockSelect.replaceChildren(...blockIds.map((blockId) => optionFor(blockId, blockId)));
    elements.blockSelect.value = blockIds.includes(previousBlock)
      ? previousBlock
      : blockIds.includes(score?.structureState?.activeBlockId) ? score.structureState.activeBlockId : blockIds[0] ?? "";

    const savedRoles = Object.values(score?.mesostructure ?? {}).flatMap((block) => Object.entries(block.oscLayers ?? {}))
      .filter(([, layer]) => cleanToken(score?.oscClips?.[layer?.clipId]?.app) === app)
      .map(([roleId]) => roleId);
    const roleIds = Array.from(new Set([
      ...Object.entries(assignments).filter(([, assignment]) => cleanToken(assignment.app) === app).map(([roleId]) => roleId),
      ...savedRoles
    ])).sort((left, right) => left.localeCompare(right));
    elements.roleSelect.replaceChildren(...roleIds.map((roleId) => optionFor(roleId, assignments[roleId]?.label || roleId)));
    if (roleIds.includes(previousRole)) elements.roleSelect.value = previousRole;

    elements.sourceSelect?.replaceChildren(...targets.map((target) => optionFor(target.id, target.label || target.id)));
    if (targets.some((target) => target.id === previousSource)) elements.sourceSelect.value = previousSource;
    const clips = compatibleClips();
    elements.clipSelect?.replaceChildren(...clips.map(([clipId, clip]) => optionFor(clipId, clip.name || clipId)));
    if (clips.some(([clipId]) => clipId === previousClip)) elements.clipSelect.value = previousClip;
    else selectLayerClip();
    suggestClipIdentity();

    elements.activeBlock.textContent = `Active block: ${score?.structureState?.activeBlockId || "—"}`;
    renderStatus();
  }

  function renderStatus() {
    const blockId = elements.blockSelect.value;
    const roleId = elements.roleSelect.value;
    const assignment = assignments[roleId];
    const resolution = resolutions[roleId];
    const selected = selectedClip();
    const layerClip = selectedLayerClip();
    const sourceId = elements.sourceSelect?.value;
    elements.captureButton.disabled = !(blockId && roleId && sourceId && elements.clipIdInput?.value.trim());
    elements.loadButton.disabled = !selected;
    elements.assignButton.disabled = !(blockId && roleId && selected);
    elements.duplicateButton.disabled = !(selected && elements.clipIdInput?.value.trim());
    elements.recallButton.disabled = !layerClip;
    elements.ignoreInput.disabled = !assignment;
    elements.ignoreInput.checked = Boolean(assignment?.ignoreRecall);
    if (!blockId) return setState("No mesostructural blocks available");
    if (!roleId) return setState(`Create an ${options.roleLabel || app} logical role in Admin`);
    const routing = resolution?.status ? ` · role ${resolution.status}` : "";
    if (!layerClip) return setState(`No OSC clip assigned to ${blockId}/${roleId}${routing}`);
    const capture = oscClipCaptureSummary(layerClip);
    try {
      const dirty = selected ? !sameOscSnapshot(options.serializeDraft(), selected) : false;
      setState(`${layerClip.name || selectedLayer()?.clipId} assigned to ${blockId}/${roleId}${routing}${capture ? ` · ${capture}` : ""}${dirty ? " · editor differs from selected clip" : ""}`);
    } catch (error) {
      setState(`Draft invalid: ${error.message}`);
    }
  }

  async function capture() {
    const blockId = elements.blockSelect.value;
    const roleId = elements.roleSelect.value;
    const targetId = elements.sourceSelect.value;
    const clipId = elements.clipIdInput.value.trim();
    elements.captureButton.disabled = true;
    const result = await fetchJson("/osc/clips/capture", {
      method: "POST",
      body: JSON.stringify({
        expectedStructureRevision: score?.structureRevision ?? 0,
        targetId, clipId, name: elements.clipNameInput.value.trim(), blockId, roleId
      })
    });
    score = result.score;
    renderContext();
    elements.clipSelect.value = clipId;
    const diagnosticCount = result.diagnostics?.length ?? 0;
    options.setStatus?.(`Captured ${targets.find((target) => target.id === targetId)?.label || targetId} as ${clipId} and assigned ${blockId}/${roleId} · ${result.complete ? "complete" : "incomplete"}${diagnosticCount ? ` (${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"})` : ""}`);
  }

  async function load() {
    const clip = selectedClip();
    if (!clip) throw new Error("Choose an OSC clip to load");
    await options.applySnapshot(structuredClone(clip));
    renderStatus();
    options.setStatus?.(`Loaded ${elements.clipSelect.value} into the editor; no OSC was sent`);
  }

  async function assign() {
    const blockId = elements.blockSelect.value;
    const roleId = elements.roleSelect.value;
    const clipId = elements.clipSelect.value;
    score = await fetchJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-layers/${encodeURIComponent(roleId)}`, {
      method: "PUT",
      body: JSON.stringify({ expectedStructureRevision: score.structureRevision, clipId })
    });
    renderContext();
    options.setStatus?.(`Assigned ${clipId} to ${blockId}/${roleId}`);
  }

  async function duplicate() {
    const clip = selectedClip();
    if (!clip) throw new Error("Choose an OSC clip to duplicate");
    const clipId = elements.clipIdInput.value.trim();
    score = await fetchJson("/osc/clips", {
      method: "POST",
      body: JSON.stringify({ expectedStructureRevision: score.structureRevision, clipId, ...clip, name: elements.clipNameInput.value.trim() || `${clip.name || elements.clipSelect.value} copy` })
    });
    renderContext();
    elements.clipSelect.value = clipId;
    options.setStatus?.(`Duplicated OSC clip as ${clipId}; no layer changed`);
  }

  async function recall() {
    const blockId = elements.blockSelect.value;
    const roleId = elements.roleSelect.value;
    const saved = selectedLayerClip();
    if (!saved) throw new Error("No OSC clip is assigned to this block and role");
    elements.recallButton.disabled = true;
    try {
      const result = await fetchJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-layers/recall`, {
        method: "POST",
        body: JSON.stringify({ roles: [roleId] })
      });
      const summary = oscRecallSummary(result);
      elements.lastRecall.textContent = summary;
      const clockNotice = oscClockRecallNotice(saved);
      options.setStatus?.(`${summary}${clockNotice ? `; ${clockNotice}` : ""}`);
    } finally {
      renderStatus();
    }
  }

  async function saveIgnoreRecall() {
    const roleId = elements.roleSelect.value;
    const assignment = assignments[roleId];
    if (!assignment) throw new Error("The selected role has no assignment to update");
    score = await fetchJson(`/osc/assignments/${encodeURIComponent(roleId)}`, {
      method: "PUT",
      body: JSON.stringify({
        expectedScoreRevision: score?.scoreRevision ?? score?.version ?? 0,
        ...assignment,
        ignoreRecall: elements.ignoreInput.checked
      })
    });
    await refreshContext();
    options.setStatus?.(`${elements.ignoreInput.checked ? "Ignoring" : "Allowing"} Shadowscore recall for ${roleId}`);
  }

  async function loadLastRecall() {
    const blockId = elements.blockSelect.value;
    if (!blockId) {
      elements.lastRecall.textContent = "No recall recorded";
      return;
    }
    const status = await fetchJson(`/mesostructure/${encodeURIComponent(blockId)}/osc-layers/recall`);
    elements.lastRecall.textContent = oscRecallSummary(status.last);
  }

  function connectEvents() {
    events = new EventSource("/events");
    const updateScore = (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.score) return;
      score = payload.score;
      assignments = score.oscAssignments ?? {};
      renderContext();
      if (event.type.startsWith("osc.assignment.")) refreshAssignments().catch(reportError);
    };
    for (const eventName of [
      "snapshot", "osc.clip.added", "osc.clip.captured", "osc.clip.replaced", "osc.clip.removed",
      "mesostructure.oscLayer.assigned", "mesostructure.oscLayer.removed",
      "structure.playhead.updated", "osc.assignment.replaced", "osc.assignment.removed",
      "osc.assignment.reconciled", "admin.reset", "admin.score.created", "admin.restore"
    ]) events.addEventListener(eventName, updateScore);
  }

  async function refreshAssignments() {
    const status = await fetchJson("/osc/assignments?resolved=1");
    assignments = status.assignments ?? {};
    resolutions = status.resolutions ?? {};
    renderContext();
  }

  function selectedSnapshot() {
    return selectedLayerClip();
  }

  function compatibleClips() { return Object.entries(score?.oscClips ?? {}).filter(([, clip]) => cleanToken(clip.app) === app).sort(([a], [b]) => a.localeCompare(b)); }
  function selectedClip() { return score?.oscClips?.[elements.clipSelect?.value] ?? null; }
  function selectedLayer() { return score?.mesostructure?.[elements.blockSelect.value]?.oscLayers?.[elements.roleSelect.value] ?? null; }
  function selectedLayerClip() { const layer = selectedLayer(); return layer?.clipId ? score?.oscClips?.[layer.clipId] ?? null : null; }
  function selectLayerClip() { const clipId = selectedLayer()?.clipId; if (clipId && elements.clipSelect) elements.clipSelect.value = clipId; }
  function suggestClipIdentity() {
    if (!elements.clipIdInput || elements.clipIdInput.value.trim()) return;
    const role = elements.roleSelect?.value || app;
    const block = elements.blockSelect?.value?.toLowerCase() || "clip";
    elements.clipIdInput.value = `${block}-${role}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    if (elements.clipNameInput && !elements.clipNameInput.value.trim()) elements.clipNameInput.value = `${elements.blockSelect?.value || "OSC"} · ${assignments[role]?.label || role}`;
  }

  function snapshotState() {
    return {
      score: structuredClone(score),
      assignments: structuredClone(assignments),
      resolutions: structuredClone(resolutions),
      blockId: elements.blockSelect.value,
      roleId: elements.roleSelect.value,
      snapshot: structuredClone(selectedSnapshot())
    };
  }

  function reportError(error) {
    renderStatus();
    setState(error.message || String(error));
    options.setStatus?.(error.message || String(error));
  }

  function setState(text) {
    elements.state.textContent = text;
  }
}

export function createOscEditorSnapshot({ app, paramEntries = [], inputPortEntries = [] } = {}) {
  const normalizedApp = cleanToken(app);
  if (!normalizedApp) throw new Error("Snapshot app is required");
  return {
    schemaVersion: 1,
    app: normalizedApp,
    params: Object.fromEntries(paramEntries.map(({ name, value, values }) => {
      const semanticName = controlName(name, "parameter");
      return [semanticName, oscSnapshotParamValue({ name: semanticName, value, values })];
    })),
    inputPorts: Object.fromEntries(inputPortEntries
      .filter(({ name, meta }) => !isMomentaryInputPort(name, meta))
      .map(({ name, value }) => [controlName(name, "input port"), parseNumericList(value, name)]))
  };
}

export function oscSnapshotParamValue({ name, value, values } = {}) {
  const choices = uniqueChoices(values);
  if (choices.length) {
    const index = choices.findIndex((choice) => choice === String(value));
    if (index >= 0) return index;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name || "parameter"} must be numeric or a reported enum choice before saving`);
  return number;
}

export function oscEditorParamValue(param, snapshotValue) {
  const choices = uniqueChoices(param?.values);
  const index = Number(snapshotValue);
  return choices.length && Number.isInteger(index) && index >= 0 && index < choices.length
    ? choices[index]
    : snapshotValue;
}

export function sameOscSnapshot(left, right) {
  return JSON.stringify(canonicalSnapshot(left)) === JSON.stringify(canonicalSnapshot(right));
}

export function oscRecallSummary(result) {
  if (!result) return "No recall recorded";
  const attempted = Number(result.attemptedWriteCount ?? 0);
  const failed = Number(result.failedWriteCount ?? 0);
  const skipped = Number(result.skippedRoleCount ?? 0);
  const bytes = Number(result.attemptedPacketBytes ?? 0);
  const dispatchMs = Number(result.dispatchDurationMs ?? 0);
  return `${failed ? "Recall completed with errors" : "Recall complete"}: ${attempted} write${attempted === 1 ? "" : "s"}${bytes ? `, ${bytes} bytes` : ""}${Number.isFinite(dispatchMs) && attempted ? `, ${formatMilliseconds(dispatchMs)} ms dispatch` : ""}${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} role${skipped === 1 ? "" : "s"} skipped` : ""}`;
}

export function oscClockRecallNotice(snapshot) {
  if (!Object.hasOwn(snapshot?.params ?? {}, "Clock")) return "";
  return Number(snapshot.params.Clock) === 0
    ? "Clock 0 suspends immediately"
    : "Clock 1 arms for the next observed shared beat";
}

export function oscClipCaptureSummary(clip) {
  const capture = clip?.capture;
  if (!capture) return "";
  const source = capture.targetId || capture.deviceId || "unknown source";
  const diagnosticCount = capture.diagnostics?.length ?? 0;
  return `captured from ${source} · ${capture.complete === false ? "incomplete" : "complete"}${diagnosticCount ? ` · ${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}` : ""}`;
}

function normalizeEditorSnapshot(snapshot, app) {
  const normalized = createOscEditorSnapshot({
    app: snapshot?.app ?? app,
    paramEntries: Object.entries(snapshot?.params ?? {}).map(([name, value]) => ({ name, value })),
    inputPortEntries: Object.entries(snapshot?.inputPorts ?? {}).map(([name, value]) => ({ name, value }))
  });
  if (normalized.app !== app) throw new Error(`Snapshot app must be '${app}'`);
  return normalized;
}

function parseNumericList(value, name) {
  const parts = Array.isArray(value) ? value : String(value ?? "").trim().split(/[\s,]+/g).filter(Boolean);
  return parts.map((part) => {
    const number = Number(part);
    if (!Number.isFinite(number)) throw new Error(`${name} contains a nonnumeric value '${part}'`);
    return number;
  });
}

function canonicalSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    schemaVersion: Number(snapshot.schemaVersion ?? 1),
    app: cleanToken(snapshot.app),
    params: sortedObject(snapshot.params, Number),
    inputPorts: sortedObject(snapshot.inputPorts, (value) => (value ?? []).map(Number))
  };
}

function sortedObject(value, mapValue) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => [name, mapValue(entry)]));
}

function isMomentaryInputPort(name, meta = {}) {
  if (meta?.snapshot === true || meta?.snapshot_state === true) return false;
  if (meta?.snapshot === false || meta?.snapshot_state === false) return true;
  const normalized = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return MOMENTARY_INPUT_PORTS.has(normalized) || normalized.endsWith("probe") || normalized.endsWith("panic") || normalized.endsWith("ack");
}

function optionFor(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `${url}: ${response.status} ${response.statusText}`);
  return body;
}

function controlName(value, label) {
  const name = String(value ?? "").trim();
  if (!name || name.includes("/")) throw new Error(`Snapshot ${label} name must be semantic`);
  return name;
}

function cleanToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatMilliseconds(value) {
  return Number(value).toFixed(value < 10 ? 2 : 1).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function uniqueChoices(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(String)));
}
