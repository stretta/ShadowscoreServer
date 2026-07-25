const MOMENTARY_INPUT_PORTS = new Set(["get", "panic", "probe", "reset", "rtz", "setstage"]);

export function mountOscSnapshotPanel(parent, options = {}) {
  if (!parent) throw new Error("OSC snapshot panel requires a parent element");
  const section = document.createElement("section");
  section.className = "ss-osc-snapshot-panel";
  section.setAttribute("aria-label", "Block state");
  section.innerHTML = `
    <div class="ss-osc-snapshot-head">
      <div><h2>Block State</h2><div class="ss-osc-snapshot-detail">Focus chooses what is displayed and written. Control gestures go to compatible checked instances.</div></div>
      <div class="ss-osc-snapshot-head-actions"><div data-snapshot-focus class="ss-osc-snapshot-focus">Editing from: — · Live output to: 0 checked instances</div><button data-snapshot-copy-open type="button">Copy Checked…</button><button data-snapshot-clear-open type="button">Clear State…</button></div>
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
      <div class="ss-osc-snapshot-actions"><div><button data-snapshot-recall type="button">Recall — Now</button></div></div>
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
    <dialog data-snapshot-clear-dialog class="ss-osc-clear-dialog">
      <form data-snapshot-clear-form method="dialog">
        <div><h3>Clear State</h3><p>Choose which Written Block State slots become Unspecified. This sends no OSC and preserves assignments and clips.</p></div>
        <label><input type="radio" name="snapshot-clear-scope" value="instance-block" checked><span><strong>This instance · this block</strong><small data-snapshot-clear-instance>0 Written states</small></span></label>
        <label><input type="radio" name="snapshot-clear-scope" value="block"><span><strong>All instances · this block</strong><small data-snapshot-clear-block>0 Written states</small></span></label>
        <label><input type="radio" name="snapshot-clear-scope" value="all"><span><strong>All instances · all blocks</strong><small data-snapshot-clear-all>0 Written states</small></span></label>
        <div class="ss-osc-clear-actions"><button data-snapshot-clear-cancel type="button">Cancel</button><button data-snapshot-clear-confirm class="danger" type="submit">Clear selected scope</button></div>
      </form>
    </dialog>
    <dialog data-snapshot-copy-dialog class="ss-osc-clear-dialog">
      <form data-snapshot-copy-form method="dialog">
        <div><h3>Copy Checked Block State</h3><p>Copy each checked instance's Written state from the EDITING block into another block. Copies are independent and no OSC is sent.</p></div>
        <label><span><strong>Destination block</strong><select data-snapshot-copy-block aria-label="Destination block"></select><small data-snapshot-copy-summary>Choose a destination block</small></span></label>
        <div class="ss-osc-clear-actions"><button data-snapshot-copy-cancel type="button">Cancel</button><button data-snapshot-copy-confirm class="primary" type="submit">Copy checked state</button></div>
      </form>
    </dialog>
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
    assignButton: section.querySelector("[data-snapshot-assign]"),
    duplicateButton: section.querySelector("[data-snapshot-duplicate]"),
    recallButton: section.querySelector("[data-snapshot-recall]"),
    clearOpenButton: section.querySelector("[data-snapshot-clear-open]"),
    clearDialog: section.querySelector("[data-snapshot-clear-dialog]"),
    clearForm: section.querySelector("[data-snapshot-clear-form]"),
    clearCancelButton: section.querySelector("[data-snapshot-clear-cancel]"),
    clearConfirmButton: section.querySelector("[data-snapshot-clear-confirm]"),
    clearInstanceCount: section.querySelector("[data-snapshot-clear-instance]"),
    clearBlockCount: section.querySelector("[data-snapshot-clear-block]"),
    clearAllCount: section.querySelector("[data-snapshot-clear-all]"),
    copyOpenButton: section.querySelector("[data-snapshot-copy-open]"),
    copyDialog: section.querySelector("[data-snapshot-copy-dialog]"),
    copyForm: section.querySelector("[data-snapshot-copy-form]"),
    copyBlockSelect: section.querySelector("[data-snapshot-copy-block]"),
    copySummary: section.querySelector("[data-snapshot-copy-summary]"),
    copyCancelButton: section.querySelector("[data-snapshot-copy-cancel]"),
    copyConfirmButton: section.querySelector("[data-snapshot-copy-confirm]"),
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
  const serializeState = options.serializeState;
  const displayState = options.displayState;
  if (!app || typeof serializeState !== "function" || typeof displayState !== "function") {
    throw new Error("OSC snapshot editor client requires app, serializeState, and displayState");
  }
  let score = null;
  let assignments = {};
  let resolutions = {};
  let targets = [];
  let events = null;
  let playback = { running: false, mode: "stopped", activeBlockId: "" };
  let playbackPoll = null;
  let chase = readChasePreference();
  let activeGesture = null;
  let deferredChase = null;
  let writeStatus = { state: "idle", error: "" };
  const submittedStates = new Map();
  const writeQueue = createOscStateWriteQueue({
    write: persistInstantState,
    onStatus(status) {
      writeStatus = status;
      renderStatus();
    }
  });

  bindEvents();

  return {
    async init() {
      await refreshContext();
      connectEvents();
      playbackPoll = window.setInterval(() => refreshPlayback().catch(reportError), 2000);
      return snapshotState();
    },
    beginGesture() {
      if (activeGesture && !activeGesture.completed) return activeGesture;
      activeGesture = instantWriteContext();
      return activeGesture;
    },
    commitGesture(gesture = activeGesture) {
      if (!gesture || gesture.completed) return false;
      gesture.completed = true;
      commitInstantState(gesture);
      if (activeGesture === gesture) activeGesture = null;
      flushDeferredChase().catch(reportError);
      return true;
    },
    cancelGesture(gesture = activeGesture) {
      if (!gesture || gesture.completed) return false;
      gesture.completed = true;
      if (activeGesture === gesture) activeGesture = null;
      flushDeferredChase().catch(reportError);
      return true;
    },
    commitEdit() {
      commitInstantState(instantWriteContext());
      return true;
    },
    whenIdle() {
      return writeQueue?.whenIdle() ?? Promise.resolve();
    },
    retrySave() {
      return writeQueue?.retry() ?? false;
    },
    syncScore(nextScore) {
      if (!nextScore || typeof nextScore !== "object") return false;
      score = structuredClone(nextScore);
      assignments = score.oscAssignments ?? {};
      if (chase) selectPlayingBlock();
      renderContext();
      return true;
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
    elements.assignButton?.addEventListener("click", () => assign().catch(reportError));
    elements.duplicateButton?.addEventListener("click", () => duplicate().catch(reportError));
    elements.recallButton?.addEventListener("click", () => recall().catch(reportError));
    elements.clearOpenButton?.addEventListener("click", openClearDialog);
    elements.clearCancelButton?.addEventListener("click", closeClearDialog);
    elements.clearForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const scope = new FormData(elements.clearForm).get("snapshot-clear-scope");
      clearState(scope).catch(reportError);
    });
    elements.copyOpenButton?.addEventListener("click", openCopyDialog);
    elements.copyCancelButton?.addEventListener("click", closeCopyDialog);
    elements.copyBlockSelect?.addEventListener("change", renderCopyAvailability);
    elements.copyForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      copyCheckedState().catch(reportError);
    });
    options.liveTargetRoot?.addEventListener("change", () => {
      renderLiveRouting();
      renderCopyAvailability();
      renderStatus();
    });
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
    synchronizeClipIdentity();
    renderPlayback();
    renderInstances();
    renderSlots();
    renderStatus();
  }

  function renderStatus() {
    const blockId = elements.blockSelect?.value;
    const roleId = elements.roleSelect?.value;
    const sourceId = elements.sourceSelect?.value;
    const source = targets.find((target) => target.id === sourceId);
    const destinationIds = selectedLiveTargetIds(options.liveTargetRoot);
    const layerClip = selectedLayerClip();
    elements.recallButton.textContent = `Recall ${blockId || "—"} Now`;
    elements.recallButton.disabled = !layerClip;
    elements.assignButton.disabled = !(blockId && roleId && selectedClip());
    elements.duplicateButton.disabled = !(selectedClip() && elements.clipIdInput?.value.trim());
    renderClearAvailability();
    renderCopyAvailability();
    if (writeStatus.state === "failed") return setState(`Save failed: ${writeStatus.error}`);
    if (writeStatus.state === "saving") return setState(`Saving ${writeStatus.job.blockId} state…`);
    if (writeStatus.state === "queued") return setState(`${writeStatus.job.blockId} state queued…`);
    if (!blockId) return setState("No mesostructural blocks available");
    if (!sourceId) return setState(`No online ${options.roleLabel || app} instance is focused`);
    if (!destinationIds.length) return setState("Check at least one destination before editing");
    const playbackNote = playback?.running ? ` · PLAYING ${playingBlockId()}` : "";
    if (!roleId || !layerClip) {
      return setState(`${source?.label || sourceId} · ${blockId} has no saved state · the first edit will create it${playbackNote}`);
    }
    setState(`${blockId} state saved for ${destinationIds.length} checked instance${destinationIds.length === 1 ? "" : "s"}${playbackNote}`);
  }

  function instantWriteContext() {
    return {
      blockId: elements.blockSelect?.value || "",
      targetIds: selectedLiveTargetIds(options.liveTargetRoot),
      completed: false
    };
  }

  function commitInstantState(context) {
    if (!context?.blockId) return reportError(new Error("Choose an EDITING block before changing state"));
    if (!context.targetIds?.length) return reportError(new Error("Check at least one destination before editing"));
    let snapshot;
    try {
      snapshot = structuredClone(serializeState());
    } catch (error) {
      return reportError(error);
    }
    const targetIds = [...new Set(context.targetIds)].sort();
    const key = `${context.blockId}|${targetIds.join(",")}`;
    if (sameOscSnapshot(submittedStates.get(key), snapshot)) return;
    submittedStates.set(key, structuredClone(snapshot));
    writeQueue.enqueue({ key, blockId: context.blockId, targetIds, snapshot });
  }

  async function persistInstantState(job) {
    const send = () => fetchJson("/osc/block-state", {
      method: "PUT",
      body: JSON.stringify({
        expectedStructureRevision: score?.structureRevision ?? 0,
        targets: job.targetIds,
        blockId: job.blockId,
        snapshot: job.snapshot
      })
    });
    let result;
    try {
      result = await send();
    } catch (error) {
      if (error?.code !== "stale_structure_revision") {
        if (sameOscSnapshot(submittedStates.get(job.key), job.snapshot)) submittedStates.delete(job.key);
        throw error;
      }
      score = await fetchJson("/score");
      assignments = score.oscAssignments ?? {};
      if (!score.mesostructure?.[job.blockId]) {
        if (sameOscSnapshot(submittedStates.get(job.key), job.snapshot)) submittedStates.delete(job.key);
        throw new Error(`Cannot save: block ${job.blockId} no longer exists`);
      }
      try {
        result = await send();
      } catch (retryError) {
        if (sameOscSnapshot(submittedStates.get(job.key), job.snapshot)) submittedStates.delete(job.key);
        throw retryError;
      }
    }
    score = result.score;
    assignments = score.oscAssignments ?? {};
    renderContext();
    options.setStatus?.(`Saved ${job.blockId} state to ${job.targetIds.length} checked instance${job.targetIds.length === 1 ? "" : "s"}`);
    return result;
  }

  async function flushDeferredChase() {
    if ((activeGesture && !activeGesture.completed) || !deferredChase) return;
    const pendingChase = deferredChase;
    deferredChase = null;
    await hydrateChasedPlayingBlock(pendingChase.previousBlockId, { force: pendingChase.force });
    await loadLastRecall();
  }

  function openClearDialog() {
    renderClearAvailability();
    const choices = Array.from(elements.clearForm?.querySelectorAll?.('[name="snapshot-clear-scope"]') ?? []);
    const defaultChoice = choices.find((input) => input.value === "instance-block" && !input.disabled)
      ?? choices.find((input) => !input.disabled);
    if (defaultChoice) defaultChoice.checked = true;
    if (typeof elements.clearDialog?.showModal === "function") elements.clearDialog.showModal();
    else elements.clearDialog?.setAttribute("open", "");
  }

  function closeClearDialog() {
    if (typeof elements.clearDialog?.close === "function") elements.clearDialog.close();
    else elements.clearDialog?.removeAttribute("open");
  }

  async function clearState(scope) {
    const blockId = elements.blockSelect?.value;
    const roleId = elements.roleSelect?.value;
    const scopes = oscClearStateScopes(score, blockId, roleId);
    const selected = scopes[scope];
    if (!selected || selected.count === 0) throw new Error("There are no Written Block States in that scope");
    if (scope !== "instance-block" && !window.confirm(selected.confirmation)) return;
    elements.clearConfirmButton.disabled = true;
    try {
      const result = await fetchJson("/osc/block-state/clear", {
        method: "POST",
        body: JSON.stringify({ expectedStructureRevision: score?.structureRevision ?? 0, scope, blockId, roleId })
      });
      score = result.score;
      assignments = score.oscAssignments ?? {};
      closeClearDialog();
      renderContext();
      options.setStatus?.(`Cleared ${result.clearedCount} Written Block State${result.clearedCount === 1 ? "" : "s"}; no OSC was sent`);
    } finally {
      elements.clearConfirmButton.disabled = false;
    }
  }

  function checkedRoleIds() {
    return selectedLiveTargetIds(options.liveTargetRoot).map((targetId) =>
      resolveFocusedOscRole({ app, targetId, targets, assignments, resolutions })
    ).filter(Boolean);
  }

  function openCopyDialog() {
    const sourceBlockId = elements.blockSelect?.value;
    const blockIds = Object.keys(score?.mesostructure ?? {}).filter((blockId) => blockId !== sourceBlockId);
    const previous = elements.copyBlockSelect?.value;
    elements.copyBlockSelect?.replaceChildren(...blockIds.map((blockId) => optionFor(blockId, blockId)));
    if (blockIds.includes(previous)) elements.copyBlockSelect.value = previous;
    renderCopyAvailability();
    if (typeof elements.copyDialog?.showModal === "function") elements.copyDialog.showModal();
    else elements.copyDialog?.setAttribute("open", "");
  }

  function closeCopyDialog() {
    if (typeof elements.copyDialog?.close === "function") elements.copyDialog.close();
    else elements.copyDialog?.removeAttribute("open");
  }

  function renderCopyAvailability() {
    if (!elements.copyOpenButton && !elements.copyConfirmButton) return;
    const sourceBlockId = elements.blockSelect?.value;
    const destinationBlockId = elements.copyBlockSelect?.value;
    const targetIds = selectedLiveTargetIds(options.liveTargetRoot);
    const roleIds = checkedRoleIds();
    const availability = oscCopyStateAvailability({ score, sourceBlockId, destinationBlockId, targetIds, roleIds });
    if (elements.copyOpenButton) elements.copyOpenButton.disabled = !sourceBlockId || targetIds.length === 0 || Object.keys(score?.mesostructure ?? {}).length < 2;
    if (elements.copyConfirmButton) elements.copyConfirmButton.disabled = !availability.allowed;
    if (elements.copySummary) elements.copySummary.textContent = availability.reason || availability.summary;
  }

  async function copyCheckedState() {
    const sourceBlockId = elements.blockSelect?.value;
    const destinationBlockId = elements.copyBlockSelect?.value;
    const targetIds = selectedLiveTargetIds(options.liveTargetRoot);
    const roleIds = checkedRoleIds();
    const availability = oscCopyStateAvailability({ score, sourceBlockId, destinationBlockId, targetIds, roleIds });
    if (!availability.allowed) throw new Error(availability.reason);
    if (availability.replacementCount > 0 && !window.confirm(
      `Replace ${availability.replacementCount} Written Block State${availability.replacementCount === 1 ? "" : "s"} in block ${destinationBlockId} and copy all ${targetIds.length} checked instances from block ${sourceBlockId}?`
    )) return;
    elements.copyConfirmButton.disabled = true;
    try {
      const result = await fetchJson("/osc/block-state/duplicate", {
        method: "POST",
        body: JSON.stringify({
          expectedStructureRevision: score?.structureRevision ?? 0,
          sourceBlockId,
          destinationBlockId,
          targets: targetIds,
          replace: availability.replacementCount > 0
        })
      });
      score = result.score;
      assignments = score.oscAssignments ?? {};
      closeCopyDialog();
      renderContext();
      options.setStatus?.(`Copied ${result.copiedCount} checked instance state${result.copiedCount === 1 ? "" : "s"} from ${sourceBlockId} to ${destinationBlockId}; no OSC was sent`);
    } finally {
      elements.copyConfirmButton.disabled = false;
    }
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
      "osc.blockState.written", "osc.blockState.replaced", "osc.blockState.batchWritten", "osc.blockState.cleared",
      "mesostructure.oscLayer.assigned", "mesostructure.oscLayer.removed",
      "mesostructure.ttid.updated",
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
    if (elements.blockSelect) elements.blockSelect.value = blockId;
    setChase(false);
    selectLayerClip();
    synchronizeClipIdentity();
    await hydrateEditingContext({ readLiveWhenUnspecified: !options.readOnBlockChange });
    if (options.readOnBlockChange) {
      await options.onFocusChange?.(elements.sourceSelect?.value);
    }
    renderContext();
    await loadLastRecall();
  }

  async function changeFocusedInstance() {
    synchronizeFocusedRole();
    selectExclusiveOscTarget(options.liveTargetRoot, elements.sourceSelect?.value);
    selectLayerClip();
    synchronizeClipIdentity();
    await options.onFocusChange?.(elements.sourceSelect?.value);
    await hydrateEditingContext();
    renderContext();
  }

  async function hydrateEditingContext({ readLiveWhenUnspecified = false } = {}) {
    const blockId = elements.blockSelect?.value;
    const targetId = elements.sourceSelect?.value;
    const roleId = synchronizeFocusedRole();
    if (!blockId || !targetId) return;
    const written = oscBlockSlotState(score, blockId, roleId).clip;
    if (written) {
      await displayState(structuredClone(written));
    } else if (readLiveWhenUnspecified) {
      await options.onFocusChange?.(targetId);
    }
  }

  function renderInstances() {
    if (!elements.instances) return;
    const focusedId = elements.sourceSelect?.value;
    const blockIds = Object.keys(score?.mesostructure ?? {});
    elements.instances.replaceChildren(...targets.map((target) => {
      const roleId = resolveFocusedOscRole({ app, targetId: target.id, targets, assignments, resolutions });
      const assignment = assignments[roleId];
      const writtenCount = roleId ? blockIds.filter((blockId) => oscBlockSlotState(score, blockId, roleId).status === "Written").length : 0;
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
      state.textContent = roleId ? `${assignment?.ignoreRecall ? "Ignored" : "Mapped"} · ${writtenCount}/${blockIds.length} Written` : "Available";
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
    renderLiveRouting();
  }
  function renderLiveRouting() {
    const target = targets.find((entry) => entry.id === elements.sourceSelect?.value);
    const checkedCount = options.liveTargetRoot?.querySelectorAll?.("[data-target]:checked")?.length ?? 0;
    if (elements.focus) elements.focus.textContent = `Editing from: ${target?.label || elements.sourceSelect?.value || "—"} · Live output to: ${checkedCount} checked instance${checkedCount === 1 ? "" : "s"}`;
  }
  function renderClearAvailability() {
    const scopes = oscClearStateScopes(score, elements.blockSelect?.value, elements.roleSelect?.value);
    if (elements.clearInstanceCount) elements.clearInstanceCount.textContent = writtenStateCountLabel(scopes["instance-block"].count);
    if (elements.clearBlockCount) elements.clearBlockCount.textContent = writtenStateCountLabel(scopes.block.count);
    if (elements.clearAllCount) elements.clearAllCount.textContent = writtenStateCountLabel(scopes.all.count);
    if (elements.clearOpenButton) elements.clearOpenButton.disabled = scopes.all.count === 0;
    for (const input of elements.clearForm?.querySelectorAll?.('[name="snapshot-clear-scope"]') ?? []) input.disabled = scopes[input.value]?.count === 0;
  }
  function renderSlots() {
    if (!elements.slots) return;
    const roleId = elements.roleSelect?.value;
    const editingBlock = elements.blockSelect?.value;
    const playingBlock = playingBlockId();
    elements.slots.replaceChildren(...Object.keys(score?.mesostructure ?? {}).map((blockId) => {
      const slot = oscBlockSlotState(score, blockId, roleId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ss-osc-snapshot-slot ${slot.status.toLowerCase()}${blockId === editingBlock ? " editing" : ""}${blockId === playingBlock ? " playing" : ""}`;
      button.dataset.blockId = blockId;
      button.setAttribute("aria-pressed", String(blockId === editingBlock));
      button.innerHTML = `<strong>${escapeText(blockId)}</strong><span>${escapeText(slot.status)}</span>`;
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
    if (activeGesture && !activeGesture.completed) {
      deferredChase = { previousBlockId, force };
      return { status: "Deferred", clip: null };
    }
    const focusedTargetId = elements.sourceSelect?.value;
    await displayState(structuredClone(hydration.clip));
    if (elements.sourceSelect?.value !== focusedTargetId) elements.sourceSelect.value = focusedTargetId;
    renderContext();
    options.setStatus?.(`Chased PLAYING ${blockId} saved state into the editor; no OSC was sent by the editor`);
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
      snapshot: structuredClone(selectedSnapshot()),
      write: writeQueue?.snapshot() ?? null
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
  const compatible = Object.entries(assignments).filter(([, assignment]) => {
    if (cleanToken(assignment.app) !== normalizedApp || assignment.deviceId !== (target.deviceId || target.unitId)) return false;
    const assignedTargetId = String(assignment.oscTargetId ?? "");
    return !assignedTargetId || !targets.some((entry) => entry.id === assignedTargetId);
  });
  return compatible.length === 1 ? compatible[0][0] : "";
}

export function oscBlockSlotState(score, blockId, roleId) {
  const layer = score?.mesostructure?.[blockId]?.oscLayers?.[roleId];
  const clip = layer?.clipId ? score?.oscClips?.[layer.clipId] : null;
  return clip ? { status: "Written", clipId: layer.clipId, clip } : { status: "Unspecified", clipId: "", clip: null };
}

export function oscClearStateScopes(score, blockId, roleId) {
  const blockLayers = score?.mesostructure?.[blockId]?.oscLayers ?? {};
  const instanceCount = roleId && blockLayers[roleId] ? 1 : 0;
  const blockCount = Object.keys(blockLayers).length;
  const allCount = Object.values(score?.mesostructure ?? {}).reduce((count, block) => count + Object.keys(block?.oscLayers ?? {}).length, 0);
  return {
    "instance-block": {
      count: instanceCount,
      confirmation: `Clear ${instanceCount} Written state for this instance in block ${blockId || "—"}?`
    },
    block: {
      count: blockCount,
      confirmation: `Clear ${blockCount} Written Block State${blockCount === 1 ? "" : "s"} across all instances in block ${blockId || "—"}?`
    },
    all: {
      count: allCount,
      confirmation: `Clear ${allCount} Written Block State${allCount === 1 ? "" : "s"} across all instances in all blocks?`
    }
  };
}

export function oscCopyStateAvailability({
  score,
  sourceBlockId = "",
  destinationBlockId = "",
  targetIds = [],
  roleIds = []
} = {}) {
  if (!sourceBlockId) return { allowed: false, reason: "Choose an EDITING source block", summary: "", replacementCount: 0 };
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    return { allowed: false, reason: "Check at least one live destination to copy", summary: "", replacementCount: 0 };
  }
  if (roleIds.length !== targetIds.length) {
    return { allowed: false, reason: "Every checked instance must have a score role before its Block State can be copied", summary: "", replacementCount: 0 };
  }
  if (!destinationBlockId) return { allowed: false, reason: "Choose a destination block", summary: "", replacementCount: 0 };
  if (destinationBlockId === sourceBlockId) return { allowed: false, reason: "Choose a different destination block", summary: "", replacementCount: 0 };
  const sourceLayers = score?.mesostructure?.[sourceBlockId]?.oscLayers ?? {};
  const destinationLayers = score?.mesostructure?.[destinationBlockId]?.oscLayers ?? {};
  const missingCount = roleIds.filter((roleId) => !sourceLayers[roleId]?.clipId || !score?.oscClips?.[sourceLayers[roleId].clipId]).length;
  if (missingCount) {
    return {
      allowed: false,
      reason: `${missingCount} checked instance${missingCount === 1 ? " is" : "s are"} Unspecified in block ${sourceBlockId}`,
      summary: "",
      replacementCount: 0
    };
  }
  const replacementCount = roleIds.filter((roleId) => Boolean(destinationLayers[roleId]?.clipId)).length;
  return {
    allowed: true,
    reason: "",
    replacementCount,
    summary: `Copy ${roleIds.length} Written state${roleIds.length === 1 ? "" : "s"} from ${sourceBlockId} to ${destinationBlockId}${replacementCount ? ` · replace ${replacementCount}` : ""}`
  };
}

export function createOscStateWriteQueue({ write, onStatus = () => {} } = {}) {
  if (typeof write !== "function") throw new Error("OSC state write queue requires a write function");
  const queue = [];
  const idleResolvers = [];
  let running = false;
  let sequence = 0;
  let failedJob = null;

  return {
    enqueue(job) {
      const next = { ...structuredClone(job), sequence: ++sequence };
      const existingIndex = queue.findIndex((entry) => entry.key === next.key);
      if (existingIndex >= 0) queue[existingIndex] = next;
      else queue.push(next);
      onStatus({ state: "queued", job: structuredClone(next), error: "" });
      drain();
      return next.sequence;
    },
    retry() {
      if (!failedJob) return false;
      const job = failedJob;
      failedJob = null;
      this.enqueue(job);
      return true;
    },
    whenIdle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    snapshot() {
      return {
        running,
        queued: queue.map((entry) => structuredClone(entry)),
        failed: failedJob ? structuredClone(failedJob) : null
      };
    }
  };

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      onStatus({ state: "saving", job: structuredClone(job), error: "" });
      try {
        await write(structuredClone(job));
        failedJob = null;
        onStatus({ state: "saved", job: structuredClone(job), error: "" });
      } catch (error) {
        failedJob = structuredClone(job);
        onStatus({ state: "failed", job: structuredClone(job), error: error?.message || String(error) });
      }
    }
    running = false;
    for (const resolve of idleResolvers.splice(0)) resolve();
  }
}

function writtenStateCountLabel(count) {
  return `${count} Written state${count === 1 ? "" : "s"}`;
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

function selectedLiveTargetIds(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(root.querySelectorAll("[data-target]:checked"), (input) => input.dataset?.target).filter(Boolean);
}

export function oscPlaybackWiperVisible({ editingBlockId = "", playingBlockId = "" } = {}) {
  return Boolean(editingBlockId && editingBlockId === playingBlockId);
}

function generatedClipId(blockId, roleId) {
  if (!blockId || !roleId) return "";
  return `${blockId}-${roleId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createOscEditorSnapshot({ app, paramEntries = [], inputPortEntries = [], recall = {} } = {}) {
  const normalizedApp = cleanToken(app);
  if (!normalizedApp) throw new Error("Snapshot app is required");
  const rtzBeforePlay = recall?.rtzBeforePlay === true;
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
      .map(({ name, value }) => [controlName(name, "input port"), parseNumericList(value, name)])),
    ...(rtzBeforePlay ? { recall: { rtzBeforePlay: true } } : {})
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
    inputPortEntries: Object.entries(snapshot?.inputPorts ?? {}).map(([name, value]) => ({ name, value })),
    recall: snapshot?.recall
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
    inputPorts: sortedObject(snapshot.inputPorts, (value) => (value ?? []).map(Number)),
    recall: snapshot.recall?.rtzBeforePlay === true ? { rtzBeforePlay: true } : {}
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
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `${url}: ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.code = body.code;
    error.body = body;
    throw error;
  }
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
