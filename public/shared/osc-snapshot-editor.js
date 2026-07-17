const MOMENTARY_INPUT_PORTS = new Set(["get", "panic", "probe", "reset", "rtz", "setstage"]);

export function mountOscSnapshotPanel(parent, options = {}) {
  if (!parent) throw new Error("OSC snapshot panel requires a parent element");
  const section = document.createElement("section");
  section.className = "ss-osc-snapshot-panel";
  section.setAttribute("aria-label", "Block state");
  section.innerHTML = `
    <div class="ss-osc-snapshot-head">
      <div><h2>Block State</h2><div class="ss-osc-snapshot-detail">Focus chooses what is displayed and written, and makes that instance the sole live-send destination.</div></div>
      <div data-snapshot-focus class="ss-osc-snapshot-focus">Focused instance: —</div>
    </div>
    <div data-snapshot-instances class="ss-osc-snapshot-instances" aria-label="Block State instances"></div>
    <div class="ss-osc-snapshot-transport">
      <div class="ss-osc-snapshot-transport-card"><span>PLAYING</span><strong data-snapshot-playing>—</strong><small data-snapshot-playback>Stopped</small></div>
      <label class="ss-osc-snapshot-editing"><span>EDITING</span><select data-snapshot-block aria-label="Editing block"></select></label>
      <label class="ss-osc-snapshot-chase"><input data-snapshot-chase type="checkbox" checked> CHASE</label>
      <label data-snapshot-source-field class="ss-osc-snapshot-editing"><span>INSTANCE FOCUS</span><select data-snapshot-source aria-label="Instance focus"></select></label>
    </div>
    <div data-snapshot-slots class="ss-osc-snapshot-slots" aria-label="Available block state slots"></div>
    <select data-snapshot-role hidden aria-hidden="true"></select>
    <div class="ss-osc-snapshot-footer">
      <div class="ss-osc-snapshot-actions"><div><button data-snapshot-capture class="primary" type="button">Write — State</button><button data-snapshot-load type="button">Reload Written State</button><button data-snapshot-recall type="button">Recall — Now</button></div></div>
      <div class="ss-osc-snapshot-copy"><label><span>Save Copy To</span><select data-snapshot-copy-target aria-label="Copy Block State to instance"></select></label><button data-snapshot-copy type="button">Save Copy</button></div>
      <div class="ss-osc-snapshot-status"><div data-snapshot-state class="ss-osc-snapshot-state" role="status">Loading OSC clip state…</div><div data-snapshot-last class="ss-osc-snapshot-detail">No recall recorded</div></div>
    </div>
    <details class="ss-osc-snapshot-advanced">
      <summary>Advanced clip tools</summary>
      <div class="ss-osc-snapshot-fields">
        <label><span>Clip name</span><input data-snapshot-clip-name type="text"></label>
        <label><span>Clip id</span><input data-snapshot-clip-id type="text"></label>
        <label><span>Compatible clips</span><select data-snapshot-clip></select></label>
      </div>
      <div class="ss-osc-snapshot-actions"><div><button data-snapshot-assign type="button">Assign Selected Clip</button><button data-snapshot-duplicate type="button">Duplicate Selected Clip</button></div></div>
    </details>
  `;
  parent.insertBefore(section, options.before ?? null);
  const internalSourceSelect = section.querySelector("[data-snapshot-source]");
  const sourceSelect = options.sourceSelect ?? internalSourceSelect;
  if (options.sourceSelect) {
    section.querySelector("[data-snapshot-source-field]")?.remove();
    sourceSelect.hidden = true;
    sourceSelect.setAttribute("aria-hidden", "true");
    const sourceLabel = Array.from(sourceSelect.ownerDocument.querySelectorAll("label")).find((label) => label.htmlFor === sourceSelect.id);
    if (sourceLabel) sourceLabel.hidden = true;
  }
  return {
    panel: section,
    sourceSelect,
    instances: section.querySelector("[data-snapshot-instances]"),
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
    copyTargetSelect: section.querySelector("[data-snapshot-copy-target]"),
    copyButton: section.querySelector("[data-snapshot-copy]"),
    playingBlock: section.querySelector("[data-snapshot-playing]"),
    playbackState: section.querySelector("[data-snapshot-playback]"),
    chaseInput: section.querySelector("[data-snapshot-chase]"),
    slots: section.querySelector("[data-snapshot-slots]"),
    focus: section.querySelector("[data-snapshot-focus]"),
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
  let playback = { running: false, mode: "stopped", activeBlockId: "" };
  let playbackPoll = null;
  let chase = readChasePreference();
  const drafts = new Map();
  const savedDrafts = new Map();
  let activeDraftKey = "";
  let applyingDraft = false;

  bindEvents();

  return {
    async init() {
      await refreshContext();
      connectEvents();
      playbackPoll = window.setInterval(() => refreshPlayback().catch(reportError), 2000);
      return snapshotState();
    },
    draftChanged() {
      synchronizeFocusedRole();
      rememberDisplayedDraft();
      synchronizeClipIdentity();
      renderPlayback();
      renderInstances();
      renderSlots();
      renderStatus();
    },
    snapshotState,
    close() {
      events?.close?.();
      if (playbackPoll) window.clearInterval(playbackPoll);
    }
  };

  function bindEvents() {
    elements.blockSelect?.addEventListener("change", () => changeEditingBlock(elements.blockSelect.value).catch(reportError));
    elements.chaseInput?.addEventListener("change", () => {
      rememberDisplayedDraft();
      setChase(elements.chaseInput.checked);
      if (chase) selectPlayingBlock();
      renderContext();
      if (chase) hydrateChasedPlayingBlock("", { force: true }).catch(reportError);
      loadLastRecall().catch(reportError);
    });
    elements.sourceSelect?.addEventListener("change", () => changeFocusedInstance().catch(reportError));
    elements.clipSelect?.addEventListener("change", renderStatus);
    elements.clipIdInput?.addEventListener("input", renderStatus);
    elements.clipNameInput?.addEventListener("input", renderStatus);
    elements.copyTargetSelect?.addEventListener("change", renderStatus);
    elements.captureButton?.addEventListener("click", () => capture().catch(reportError));
    elements.copyButton?.addEventListener("click", () => copy().catch(reportError));
    elements.loadButton?.addEventListener("click", () => load().catch(reportError));
    elements.assignButton?.addEventListener("click", () => assign().catch(reportError));
    elements.duplicateButton?.addEventListener("click", () => duplicate().catch(reportError));
    elements.recallButton?.addEventListener("click", () => recall().catch(reportError));
  }

  async function refreshContext() {
    const [nextScore, assignmentStatus, targetStatus, playbackStatus] = await Promise.all([
      fetchJson("/score"),
      fetchJson("/osc/assignments?resolved=1"),
      fetchJson(`/osc/targets?app=${encodeURIComponent(app)}&status=online`),
      fetchJson("/macrostructure/playback")
    ]);
    score = nextScore;
    assignments = assignmentStatus.assignments ?? {};
    resolutions = assignmentStatus.resolutions ?? {};
    targets = targetStatus.targets ?? [];
    playback = playbackStatus;
    renderContext();
    await hydrateEditingContext({ readLiveWhenUnspecified: true });
    await loadLastRecall();
  }

  function renderContext() {
    const previousBlock = elements.blockSelect.value;
    const previousRole = elements.roleSelect.value;
    const previousSource = elements.sourceSelect?.value;
    const previousClip = elements.clipSelect?.value;
    const blockIds = Object.keys(score?.mesostructure ?? {});
    elements.blockSelect.replaceChildren(...blockIds.map((blockId) => optionFor(blockId, blockId)));
    const playing = playingBlockId();
    elements.blockSelect.value = chase && blockIds.includes(playing)
      ? playing
      : blockIds.includes(previousBlock) ? previousBlock : blockIds.includes(playing) ? playing : blockIds[0] ?? "";

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
    synchronizeFocusedRole();
    const clips = compatibleClips();
    elements.clipSelect?.replaceChildren(...clips.map(([clipId, clip]) => optionFor(clipId, clip.name || clipId)));
    if (clips.some(([clipId]) => clipId === previousClip)) elements.clipSelect.value = previousClip;
    else selectLayerClip();
    renderCopyTargets();
    synchronizeClipIdentity();
    renderPlayback();
    renderInstances();
    renderSlots();
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
    const source = targets.find((target) => target.id === sourceId);
    const written = Boolean(layerClip);
    let draft = null;
    let draftError = "";
    try { draft = options.serializeDraft(); } catch (error) { draftError = error.message; }
    const baseline = savedDrafts.get(draftKey(roleId, sourceId, blockId)) ?? layerClip;
    const dirty = Boolean(draft && (!written || !sameOscSnapshot(draft, baseline)));
    const writeAvailability = oscWriteAvailability({ blockId, targetId: sourceId, complete: Boolean(draft), written, dirty });
    elements.captureButton.textContent = oscWriteActionLabel({ blockId, written, label: source?.label || assignment?.label || sourceId });
    elements.recallButton.textContent = `Recall ${blockId || "—"} Now`;
    elements.captureButton.disabled = !writeAvailability.allowed;
    elements.loadButton.disabled = !layerClip;
    elements.assignButton.disabled = !(blockId && roleId && selected);
    elements.duplicateButton.disabled = !(selected && elements.clipIdInput?.value.trim());
    elements.recallButton.disabled = !layerClip;
    if (elements.copyButton) elements.copyButton.disabled = !draft || !elements.copyTargetSelect?.value;
    if (!blockId) return setState("No mesostructural blocks available");
    if (!sourceId) return setState(`No online ${options.roleLabel || app} instance is focused`);
    if (draftError) return setState(`Draft incomplete: ${draftError}`);
    if (!writeAvailability.allowed) return setState(writeAvailability.reason);
    const routing = resolution?.status ? ` · role ${resolution.status}` : "";
    const playbackNote = playback?.running ? ` · PLAYING ${playingBlockId()}; saving changes ${blockId}'s next recall only` : "";
    if (!roleId) return setState(`${source?.label || sourceId} is Available · ${blockId} is Unspecified · first Write creates its score role${playbackNote}`);
    if (!layerClip) return setState(`${blockId} is Unspecified for ${source?.label || assignment?.label || roleId}${draft ? " · Unwritten Draft" : ""}. Playback leaves this instance unchanged.${routing}${playbackNote}`);
    const capture = oscClipCaptureSummary(layerClip);
    setState(`${blockId} is Written for ${source?.label || assignment?.label || roleId}${routing}${capture ? ` · ${capture}` : ""}${dirty ? " · Dirty draft" : " · Saved"}${playbackNote}`);
  }

  async function capture() {
    const blockId = elements.blockSelect.value;
    const targetId = elements.sourceSelect.value;
    const layer = selectedLayer();
    const draft = options.serializeDraft();
    elements.captureButton.disabled = true;
    const result = await fetchJson("/osc/block-state/write", {
      method: "POST",
      body: JSON.stringify({
        expectedStructureRevision: score?.structureRevision ?? 0,
        targetId, blockId, snapshot: draft, replace: Boolean(layer)
      })
    });
    score = result.score;
    assignments = score.oscAssignments ?? {};
    activeDraftKey = draftKey(result.roleId, targetId, blockId);
    drafts.set(activeDraftKey, structuredClone(draft));
    savedDrafts.set(activeDraftKey, structuredClone(draft));
    renderContext();
    elements.clipSelect.value = result.clipId;
    options.setStatus?.(`${layer ? "Replaced" : "Wrote"} ${blockId} state for ${targets.find((target) => target.id === targetId)?.label || targetId}; no OSC was sent`);
  }

  async function copy() {
    const targetId = elements.copyTargetSelect?.value;
    if (!targetId) throw new Error("Choose an instance for Save Copy To");
    const blockId = elements.blockSelect.value;
    const draft = options.serializeDraft();
    const destinationRole = resolveFocusedOscRole({ app, targetId, targets, assignments, resolutions });
    const destinationWritten = Boolean(destinationRole && oscBlockSlotState(score, blockId, destinationRole).clip);
    const replace = destinationWritten
      ? window.confirm(`${blockId} is already Written for ${targets.find((target) => target.id === targetId)?.label || targetId}. Replace it with an independent copy?`)
      : false;
    if (destinationWritten && !replace) return;
    elements.copyButton.disabled = true;
    const result = await fetchJson("/osc/block-state/copy", {
      method: "POST",
      body: JSON.stringify({ expectedStructureRevision: score?.structureRevision ?? 0, targetId, blockId, snapshot: draft, replace })
    });
    score = result.score;
    assignments = score.oscAssignments ?? {};
    const destinationKey = draftKey(result.roleId, targetId, blockId);
    drafts.set(destinationKey, structuredClone(draft));
    savedDrafts.set(destinationKey, structuredClone(draft));
    renderContext();
    options.setStatus?.(`Saved an independent copy of ${blockId} state to ${targets.find((target) => target.id === targetId)?.label || targetId}; focus and live clients were unchanged`);
  }

  async function load() {
    const clip = selectedLayerClip();
    if (!clip) throw new Error("This instance is Unspecified in the editing block");
    await options.applySnapshot(structuredClone(clip));
    renderStatus();
    options.setStatus?.(`Loaded written ${elements.blockSelect.value} state into the editor; no OSC was sent`);
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

  async function saveIgnoreRecall(roleId, checked) {
    const assignment = assignments[roleId];
    if (!assignment) throw new Error("The selected role has no assignment to update");
    score = await fetchJson(`/osc/assignments/${encodeURIComponent(roleId)}`, {
      method: "PUT",
      body: JSON.stringify({
        expectedScoreRevision: score?.scoreRevision ?? score?.version ?? 0,
        ...assignment,
        ignoreRecall: checked
      })
    });
    await refreshContext();
    options.setStatus?.(`${checked ? "Ignoring" : "Allowing"} Shadowscore recall for ${roleId}`);
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

  async function refreshPlayback() {
    const previousPlaying = playingBlockId();
    const previousRunning = Boolean(playback?.running);
    playback = await fetchJson("/macrostructure/playback");
    if (chase && playingBlockId() !== previousPlaying) {
      rememberDisplayedDraft();
      selectPlayingBlock();
      renderContext();
      await hydrateChasedPlayingBlock(previousPlaying);
      await loadLastRecall();
      return;
    }
    if (previousRunning !== Boolean(playback?.running) || previousPlaying !== playingBlockId()) renderStatus();
    renderPlayback();
  }

  function connectEvents() {
    events = new EventSource("/events");
    const updateScore = (event) => {
      const previousPlaying = playingBlockId();
      const payload = JSON.parse(event.data);
      if (!payload.score) return;
      score = payload.score;
      assignments = score.oscAssignments ?? {};
      if (chase) selectPlayingBlock();
      renderContext();
      if (chase && playingBlockId() !== previousPlaying) {
        hydrateChasedPlayingBlock(previousPlaying).catch(reportError);
      }
      if (event.type.startsWith("osc.assignment.")) refreshAssignments().catch(reportError);
    };
    for (const eventName of [
      "snapshot", "osc.clip.added", "osc.clip.captured", "osc.clip.replaced", "osc.clip.removed",
      "osc.blockState.written", "osc.blockState.replaced",
      "mesostructure.oscLayer.assigned", "mesostructure.oscLayer.removed",
      "structure.playhead.updated", "osc.assignment.replaced", "osc.assignment.removed",
      "osc.assignment.reconciled", "admin.reset", "admin.score.created", "admin.score.initialized", "admin.restore"
    ]) events.addEventListener(eventName, updateScore);
  }

  async function refreshAssignments() {
    const status = await fetchJson("/osc/assignments?resolved=1");
    assignments = status.assignments ?? {};
    resolutions = status.resolutions ?? {};
    renderContext();
  }

  async function changeEditingBlock(blockId) {
    rememberDisplayedDraft();
    if (elements.blockSelect) elements.blockSelect.value = blockId;
    setChase(false);
    selectLayerClip();
    synchronizeClipIdentity();
    await hydrateEditingContext({ readLiveWhenUnspecified: !options.readOnBlockChange });
    if (options.readOnBlockChange) {
      await options.onFocusChange?.(elements.sourceSelect?.value);
      rememberDisplayedDraft();
    }
    renderContext();
    await loadLastRecall();
  }

  async function changeFocusedInstance() {
    rememberDisplayedDraft();
    const roleId = synchronizeFocusedRole();
    selectExclusiveOscTarget(options.liveTargetRoot, elements.sourceSelect?.value);
    selectLayerClip();
    synchronizeClipIdentity();
    activeDraftKey = draftKey(roleId, elements.sourceSelect?.value, elements.blockSelect?.value);
    applyingDraft = true;
    try { await options.onFocusChange?.(elements.sourceSelect?.value); } finally { applyingDraft = false; }
    await hydrateEditingContext();
    rememberDisplayedDraft();
    renderContext();
  }

  async function hydrateEditingContext({ readLiveWhenUnspecified = false } = {}) {
    const blockId = elements.blockSelect?.value;
    const targetId = elements.sourceSelect?.value;
    const roleId = synchronizeFocusedRole();
    if (!blockId || !targetId) return;
    activeDraftKey = draftKey(roleId, targetId, blockId);
    const cached = drafts.get(activeDraftKey);
    if (cached) {
      applyingDraft = true;
      try { await options.applySnapshot(structuredClone(cached)); } finally { applyingDraft = false; }
      return;
    }
    const written = oscBlockSlotState(score, blockId, roleId).clip;
    if (written) {
      applyingDraft = true;
      try { await options.applySnapshot(structuredClone(written)); } finally { applyingDraft = false; }
      const normalizedDraft = structuredClone(options.serializeDraft());
      drafts.set(activeDraftKey, normalizedDraft);
      savedDrafts.set(activeDraftKey, structuredClone(normalizedDraft));
      return;
    }
    if (readLiveWhenUnspecified) {
      await options.onFocusChange?.(targetId);
      rememberDisplayedDraft();
    }
  }

  function rememberDisplayedDraft() {
    if (!activeDraftKey || applyingDraft) return;
    try { drafts.set(activeDraftKey, structuredClone(options.serializeDraft())); } catch {}
  }

  function renderInstances() {
    if (!elements.instances) return;
    const focusedId = elements.sourceSelect?.value;
    const blockIds = Object.keys(score?.mesostructure ?? {});
    elements.instances.replaceChildren(...targets.map((target) => {
      const roleId = resolveFocusedOscRole({ app, targetId: target.id, targets, assignments, resolutions });
      const assignment = assignments[roleId];
      const writtenCount = roleId ? blockIds.filter((blockId) => oscBlockSlotState(score, blockId, roleId).status === "Written").length : 0;
      const keyPrefix = roleId ? `role:${roleId}|` : `target:${target.id}|`;
      const dirtyCount = Array.from(drafts.entries()).filter(([key, draft]) => {
        if (!key.startsWith(keyPrefix)) return false;
        const blockId = key.slice(key.lastIndexOf("|") + 1);
        const saved = savedDrafts.get(key) ?? (roleId ? oscBlockSlotState(score, blockId, roleId).clip : null);
        return !saved || !sameOscSnapshot(draft, saved);
      }).length;
      const card = document.createElement("div");
      card.className = `ss-osc-instance-card${target.id === focusedId ? " focused" : ""}`;
      const focusLabel = document.createElement("label");
      focusLabel.className = "ss-osc-instance-focus";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `osc-block-state-focus-${app}`;
      radio.checked = target.id === focusedId;
      radio.setAttribute("aria-label", `Focus ${target.label || target.id}`);
      radio.addEventListener("change", () => {
        if (!radio.checked || !elements.sourceSelect) return;
        elements.sourceSelect.value = target.id;
        elements.sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const title = document.createElement("span");
      title.innerHTML = `<strong>${escapeText(target.label || target.id)}</strong><small>${escapeText(target.deviceId || target.unitId || target.host || "")}</small>`;
      focusLabel.append(radio, title);
      const state = document.createElement("span");
      state.className = "ss-osc-instance-state";
      state.textContent = roleId ? `${assignment?.ignoreRecall ? "Ignored" : "Mapped"} · ${writtenCount}/${blockIds.length} Written${dirtyCount ? ` · ${dirtyCount} draft${dirtyCount === 1 ? "" : "s"}` : ""}` : `Available${dirtyCount ? ` · ${dirtyCount} unwritten draft${dirtyCount === 1 ? "" : "s"}` : ""}`;
      const ignore = document.createElement("label");
      ignore.className = "ss-osc-instance-ignore";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(assignment?.ignoreRecall);
      checkbox.disabled = !assignment;
      checkbox.addEventListener("change", () => saveIgnoreRecall(roleId, checkbox.checked).catch(reportError));
      ignore.append(checkbox, document.createTextNode(" Ignore recall"));
      card.append(focusLabel, state, ignore);
      return card;
    }));
  }

  function renderCopyTargets() {
    if (!elements.copyTargetSelect) return;
    const previous = elements.copyTargetSelect.value;
    const focusedId = elements.sourceSelect?.value;
    const destinations = targets.filter((target) => target.id !== focusedId);
    elements.copyTargetSelect.replaceChildren(optionFor("", destinations.length ? "Choose instance…" : "No other instance"), ...destinations.map((target) => optionFor(target.id, target.label || target.id)));
    if (destinations.some((target) => target.id === previous)) elements.copyTargetSelect.value = previous;
  }

  function selectedSnapshot() {
    return selectedLayerClip();
  }

  function compatibleClips() { return Object.entries(score?.oscClips ?? {}).filter(([, clip]) => cleanToken(clip.app) === app).sort(([a], [b]) => a.localeCompare(b)); }
  function selectedClip() { return score?.oscClips?.[elements.clipSelect?.value] ?? null; }
  function selectedLayer() { return score?.mesostructure?.[elements.blockSelect.value]?.oscLayers?.[elements.roleSelect.value] ?? null; }
  function selectedLayerClip() { const layer = selectedLayer(); return layer?.clipId ? score?.oscClips?.[layer.clipId] ?? null : null; }
  function selectLayerClip() { const clipId = selectedLayer()?.clipId; if (clipId && elements.clipSelect) elements.clipSelect.value = clipId; }
  function synchronizeFocusedRole() {
    const roleId = resolveFocusedOscRole({ app, targetId: elements.sourceSelect?.value, targets, assignments, resolutions });
    if (elements.roleSelect) elements.roleSelect.value = roleId;
    return roleId;
  }
  function synchronizeClipIdentity() {
    const blockId = elements.blockSelect?.value;
    const roleId = elements.roleSelect?.value;
    const layer = blockId && roleId ? score?.mesostructure?.[blockId]?.oscLayers?.[roleId] : null;
    const clipId = layer?.clipId || generatedClipId(blockId, roleId);
    if (elements.clipIdInput) elements.clipIdInput.value = clipId;
    if (elements.clipNameInput) elements.clipNameInput.value = blockId && roleId ? `${blockId} · ${assignments[roleId]?.label || roleId}` : "";
  }
  function renderPlayback() {
    if (elements.playingBlock) elements.playingBlock.textContent = playingBlockId() || "—";
    if (elements.playbackState) elements.playbackState.textContent = playback?.running ? `Running · ${playback.mode || "auto"}` : "Stopped";
    if (elements.chaseInput) elements.chaseInput.checked = chase;
    const target = targets.find((entry) => entry.id === elements.sourceSelect?.value);
    if (elements.focus) elements.focus.textContent = `Focused instance: ${target?.label || elements.sourceSelect?.value || "—"}`;
  }
  function renderSlots() {
    if (!elements.slots) return;
    const roleId = elements.roleSelect?.value;
    const editingBlock = elements.blockSelect?.value;
    const playingBlock = playingBlockId();
    const targetId = elements.sourceSelect?.value;
    elements.slots.replaceChildren(...Object.keys(score?.mesostructure ?? {}).map((blockId) => {
      const slot = oscBlockSlotState(score, blockId, roleId);
      const key = draftKey(roleId, targetId, blockId);
      const draft = drafts.get(key);
      const baseline = savedDrafts.get(key) ?? slot.clip;
      const dirty = Boolean(draft && (!slot.clip || !sameOscSnapshot(draft, baseline)));
      const displayStatus = slot.status === "Written" ? (dirty ? "Dirty" : "Written") : (draft ? "Unwritten Draft" : "Unspecified");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ss-osc-snapshot-slot ${slot.status.toLowerCase()}${dirty ? " dirty" : ""}${draft && !slot.clip ? " provisional" : ""}${blockId === editingBlock ? " editing" : ""}${blockId === playingBlock ? " playing" : ""}`;
      button.dataset.blockId = blockId;
      button.setAttribute("aria-pressed", String(blockId === editingBlock));
      button.innerHTML = `<strong>${escapeText(blockId)}</strong><span>${escapeText(displayStatus)}</span>`;
      button.addEventListener("click", () => changeEditingBlock(blockId).catch(reportError));
      return button;
    }));
  }
  function selectPlayingBlock() {
    const blockId = playingBlockId();
    if (blockId && score?.mesostructure?.[blockId] && elements.blockSelect) elements.blockSelect.value = blockId;
  }
  async function hydrateChasedPlayingBlock(previousBlockId, { force = false } = {}) {
    const blockId = playingBlockId();
    const targetId = elements.sourceSelect?.value;
    const roleId = synchronizeFocusedRole();
    const hydration = oscChaseHydration({
      score,
      previousBlockId,
      blockId,
      roleId,
      chase,
      ignored: Boolean(assignments[roleId]?.ignoreRecall),
      force
    });
    if (hydration.status !== "Written") return hydration;
    const focusedTargetId = elements.sourceSelect?.value;
    activeDraftKey = draftKey(roleId, targetId, blockId);
    applyingDraft = true;
    try { await options.applySnapshot(structuredClone(hydration.clip)); } finally { applyingDraft = false; }
    if (elements.sourceSelect?.value !== focusedTargetId) elements.sourceSelect.value = focusedTargetId;
    const normalizedDraft = structuredClone(options.serializeDraft());
    drafts.set(activeDraftKey, normalizedDraft);
    savedDrafts.set(activeDraftKey, structuredClone(normalizedDraft));
    renderContext();
    options.setStatus?.(`Chased PLAYING ${blockId} written state into the editor; no OSC was sent by the editor`);
    return hydration;
  }
  function playingBlockId() {
    return score?.structureState?.activeBlockId || playback?.activeBlockId || "";
  }
  function setChase(value) {
    chase = Boolean(value);
    if (elements.chaseInput) elements.chaseInput.checked = chase;
    try { window.localStorage.setItem(`shadowscore.oscEditor.${app}.chase`, chase ? "1" : "0"); } catch {}
  }
  function readChasePreference() {
    try { return window.localStorage.getItem(`shadowscore.oscEditor.${app}.chase`) !== "0"; } catch { return true; }
  }

  function snapshotState() {
    return {
      score: structuredClone(score),
      assignments: structuredClone(assignments),
      resolutions: structuredClone(resolutions),
      blockId: elements.blockSelect.value,
      roleId: elements.roleSelect.value,
      playingBlockId: playingBlockId(),
      chase,
      playback: structuredClone(playback),
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

export function resolveFocusedOscRole({ app, targetId, targets = [], assignments = {}, resolutions = {} } = {}) {
  const normalizedApp = cleanToken(app);
  const target = targets.find((entry) => entry.id === targetId);
  if (!targetId || !target) return "";
  const exact = Object.entries(assignments).find(([, assignment]) => cleanToken(assignment.app) === normalizedApp
    && assignment.oscTargetId === targetId);
  if (exact) return exact[0];
  const resolved = Object.entries(resolutions).find(([roleId, resolution]) => cleanToken(assignments[roleId]?.app) === normalizedApp
    && (resolution?.targetId === targetId || resolution?.target?.id === targetId));
  if (resolved) return resolved[0];
  const compatible = Object.entries(assignments).filter(([, assignment]) => cleanToken(assignment.app) === normalizedApp
    && assignment.deviceId === (target.deviceId || target.unitId));
  return compatible.length === 1 ? compatible[0][0] : "";
}

export function oscBlockSlotState(score, blockId, roleId) {
  const layer = score?.mesostructure?.[blockId]?.oscLayers?.[roleId];
  const clip = layer?.clipId ? score?.oscClips?.[layer.clipId] : null;
  return clip ? { status: "Written", clipId: layer.clipId, clip } : { status: "Unspecified", clipId: "", clip: null };
}

export function oscChaseHydration({
  score,
  previousBlockId = "",
  blockId = "",
  roleId = "",
  chase = false,
  ignored = false,
  force = false
} = {}) {
  if (!chase || ignored || !blockId || !roleId || (!force && blockId === previousBlockId)) {
    return { status: "Unchanged", clip: null };
  }
  const slot = oscBlockSlotState(score, blockId, roleId);
  return slot.status === "Written"
    ? { status: "Written", clip: slot.clip }
    : { status: "Unspecified", clip: null };
}

export function oscWriteActionLabel({ blockId, written, label = "" } = {}) {
  if (!blockId) return "Write to —";
  const destination = label ? ` for ${label}` : "";
  return written ? `Replace ${blockId} State${destination}` : `Write ${blockId} State${destination}`;
}

export function oscWriteAvailability({ blockId = "", targetId = "", complete = false, written = false, dirty = false } = {}) {
  if (!blockId) return { allowed: false, reason: "Choose an EDITING block" };
  if (!targetId) return { allowed: false, reason: "Focus an online instance" };
  if (!complete) return { allowed: false, reason: "Complete the displayed draft before writing" };
  if (written && !dirty) return { allowed: false, reason: `${blockId} State is saved` };
  return { allowed: true, reason: "" };
}

export function oscBlockDraftKey({ roleId = "", targetId = "", blockId = "" } = {}) {
  const identity = roleId ? `role:${roleId}` : `target:${targetId}`;
  return `${identity}|${blockId}`;
}

export function oscBlockDraftState({ draft = null, saved = null } = {}) {
  if (!draft) return saved ? "Written" : "Unspecified";
  if (!saved) return "Unwritten Draft";
  return sameOscSnapshot(draft, saved) ? "Saved" : "Dirty";
}

export function selectExclusiveOscTarget(root, targetId) {
  if (!root || !targetId || typeof root.querySelectorAll !== "function") return false;
  let matched = false;
  for (const input of root.querySelectorAll("[data-target]")) {
    const selected = input.dataset?.target === targetId;
    input.checked = selected;
    matched ||= selected;
  }
  return matched;
}

export function oscPlaybackWiperVisible({ editingBlockId = "", playingBlockId = "", running = false } = {}) {
  return Boolean(running && editingBlockId && editingBlockId === playingBlockId);
}

function generatedClipId(blockId, roleId) {
  if (!blockId || !roleId) return "";
  return `${blockId}-${roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function draftKey(roleId, targetId, blockId) {
  return oscBlockDraftKey({ roleId, targetId, blockId });
}

export function createOscEditorSnapshot({ app, paramEntries = [], inputPortEntries = [] } = {}) {
  const normalizedApp = cleanToken(app);
  if (!normalizedApp) throw new Error("Snapshot app is required");
  return {
    schemaVersion: 1,
    app: normalizedApp,
    params: Object.fromEntries(paramEntries
      .filter(({ name, meta }) => String(meta?.editor ?? "").trim().toLowerCase() !== "ttid" && !["scale", "ttid"].includes(String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")))
      .map(({ name, value, values }) => {
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

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
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
