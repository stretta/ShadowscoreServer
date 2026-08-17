export function createPlaybackUpdateControl({
  root,
  serverUrl = () => "",
  getBlockId = () => "",
  pollIntervalMs = 500,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!root) throw new Error("playback update control root is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");

  root.classList.add("ss-playback-update");
  root.innerHTML = `
    <span class="ss-playback-update-state" data-playback-update-state>Loading playback state…</span>
    <span class="ss-transfer-summary" data-transfer-summary hidden></span>
    <button type="button" data-playback-update-action disabled>Apply next beat</button>
    <details data-playback-update-details>
      <summary>Players</summary>
      <div class="ss-playback-update-targets" data-playback-update-targets></div>
    </details>`;

  const stateElement = root.querySelector("[data-playback-update-state]");
  const transferElement = root.querySelector("[data-transfer-summary]");
  const actionElement = root.querySelector("[data-playback-update-action]");
  const detailsElement = root.querySelector("[data-playback-update-details]");
  const targetsElement = root.querySelector("[data-playback-update-targets]");
  let snapshot;
  let busy = false;
  let actionError = "";
  let timer;
  let stopped = false;

  actionElement.addEventListener("click", () => void apply());

  async function refresh() {
    if (stopped || busy) return snapshot;
    try {
      const response = await fetchImpl(`${normalizedServerUrl(serverUrl)}/playback/snapshot`, { cache: "no-store" });
      if (!response.ok) throw await responseError(response);
      snapshot = await response.json();
      render();
      return snapshot;
    } catch (error) {
      stateElement.textContent = `Playback status unavailable · ${error.message}`;
      stateElement.className = "ss-playback-update-state bad";
      actionElement.disabled = true;
      return undefined;
    }
  }

  async function apply() {
    const presentation = playbackUpdatePresentation(snapshot, getBlockId());
    if (!presentation.actionEnabled || busy) return;
    busy = true;
    actionError = "";
    actionElement.disabled = true;
    stateElement.textContent = presentation.running ? "Preparing affected players…" : "Updating players…";
    stateElement.className = "ss-playback-update-state";
    try {
      const endpoint = presentation.running ? "apply-next-beat" : "update-now";
      const response = await fetchImpl(`${normalizedServerUrl(serverUrl)}/playback/updates/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockId: presentation.blockId,
          expectedScoreRevision: presentation.scoreRevision
        })
      });
      if (!response.ok) throw await responseError(response);
      await response.json();
    } catch (error) {
      actionError = error.message;
    } finally {
      busy = false;
      await refresh();
    }
  }

  function render() {
    const presentation = playbackUpdatePresentation(snapshot, getBlockId());
    const transfers = transferStatusPresentation(snapshot?.transfers);
    stateElement.textContent = actionError ? `Playback update failed · ${actionError}` : presentation.label;
    stateElement.className = actionError
      ? "ss-playback-update-state bad"
      : `ss-playback-update-state${presentation.tone ? ` ${presentation.tone}` : ""}`;
    actionElement.textContent = presentation.actionLabel;
    actionElement.disabled = busy || !presentation.actionEnabled;
    actionElement.hidden = !presentation.showAction;
    transferElement.textContent = transfers.label;
    transferElement.className = `ss-transfer-summary${transfers.tone ? ` ${transfers.tone}` : ""}`;
    transferElement.hidden = !transfers.label;
    const playbackRows = presentation.targets.map((target) => {
      const row = document.createElement("div");
      row.className = `ss-playback-update-target ${target.tone}`;
      row.textContent = `${target.voiceId || target.targetId} · ${target.label}`;
      row.title = target.error || target.targetId;
      return row;
    });
    const transferRows = transfers.targets.map((target) => {
      const row = document.createElement("div");
      row.className = `ss-playback-update-target ${target.tone}`;
      row.textContent = `${target.voiceId || target.targetId} · ${target.label}`;
      row.title = target.targetId;
      return row;
    });
    detailsElement.hidden = playbackRows.length === 0 && transferRows.length === 0;
    targetsElement.replaceChildren(...playbackRows, ...transferRows);
  }

  function schedule() {
    if (stopped || pollIntervalMs <= 0) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, pollIntervalMs);
  }

  void refresh().finally(schedule);
  return {
    refresh,
    snapshot: () => structuredClone(snapshot),
    render,
    close() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}

export function transferStatusPresentation(transfers = {}) {
  const records = Object.values(transfers?.targets ?? {}).map(transferTargetPresentation);
  const summary = transfers?.summary ?? {};
  const total = Number(summary.targetCount ?? records.length);
  const inProgress = Number(summary.inProgressCount ?? records.filter((record) => record.inProgress).length);
  const failed = Number(summary.failedCount ?? records.filter((record) => record.tone === "bad").length);
  const ready = Number(summary.readyCount ?? records.filter((record) => record.state === "ready").length);
  const live = Number(summary.liveCount ?? records.filter((record) => record.state === "live").length);
  if (!total) return { label: "", tone: "", targets: records };
  if (failed) return { label: `Players · ${failed} transfer${failed === 1 ? "" : "s"} failed`, tone: "bad", targets: records };
  if (inProgress) return { label: `Players · ${ready + live}/${total} ready · ${inProgress} receiving`, tone: "warn", targets: records };
  if (ready) return { label: `Players · ${ready} ready`, tone: "ok", targets: records };
  if (live === total) return { label: "Players · all live", tone: "ok", targets: records };
  return { label: `Players · ${total} tracked`, tone: "", targets: records };
}

function transferTargetPresentation(record = {}) {
  const expected = Math.max(0, Number(record.expectedRows) || 0);
  const sent = Math.min(expected, Math.max(0, Number(record.sentRows) || 0));
  const confirmed = Math.min(expected, Math.max(0, Number(record.confirmedRows) || 0));
  const identity = { ...record, inProgress: ["sending", "awaiting-ack", "retrying", "applying"].includes(record.state) };
  if (record.state === "sending") return { ...identity, label: `Sending ${sent}/${expected}`, tone: "warn" };
  if (record.state === "awaiting-ack") return { ...identity, label: `Sent ${sent}/${expected} · awaiting confirmation`, tone: "warn" };
  if (record.state === "retrying") return { ...identity, label: `Resume ${confirmed}/${expected} · retry ${record.attempt ?? ""}`.trim(), tone: "warn" };
  if (record.state === "ready") return { ...identity, label: `Ready · ${confirmed}/${expected} confirmed`, tone: "ok" };
  if (record.state === "applying") return { ...identity, label: "Applying prepared transaction", tone: "warn" };
  if (record.state === "live") return { ...identity, label: `Live · txn ${record.liveTransaction ?? record.transactionId ?? ""}`.trim(), tone: "ok" };
  if (["failed", "activation-failed"].includes(record.state)) return { ...identity, label: `Failed · ${record.error || record.state}`, tone: "bad" };
  return { ...identity, label: record.state || "Tracked", tone: "" };
}

export function playbackUpdatePresentation(snapshot = {}, focusedBlockId = "") {
  const updates = snapshot?.updates ?? {};
  const transport = snapshot?.transport ?? {};
  const blockId = String(updates.blockId || transport.blockId || "");
  const focus = String(focusedBlockId || blockId);
  const running = Boolean(transport.running);
  const focusedElsewhere = Boolean(focus && blockId && focus !== blockId);
  const targets = Object.values(updates.targets ?? {}).map(targetPresentation);
  const unavailableCount = targets.filter((target) => target.unavailable).length;
  const affectedCount = Number(updates.affectedTargetCount ?? targets.filter((target) => target.state !== "active").length);
  const scoreRevision = updates.scoreRevision ?? snapshot.scoreRevision ?? 0;
  const actionLabel = running ? "Apply next beat" : "Update players now";

  if (focusedElsewhere) {
    return result(`Saved · ${focus} is upcoming`, "", false, false);
  }
  if (!targets.length) {
    return result("Saved · no assigned players", "warn", false, false);
  }
  if (unavailableCount) {
    return result(`Saved · ${unavailableCount} player${unavailableCount === 1 ? "" : "s"} unavailable`, "bad", true, false);
  }
  if (updates.state === "active" || affectedCount === 0) {
    return result("Live", "ok", false, false);
  }
  if (updates.state === "prepared") {
    return result(running ? "Ready · applies on next beat" : "Ready · players can update now", "ok", true, true);
  }
  if (updates.state === "failed") {
    return result("Saved · playback update failed", "bad", true, true);
  }
  return result("Saved · players running previous version", "warn", true, true);

  function result(label, tone, showAction, actionEnabled) {
    return { label, tone, showAction, actionEnabled, actionLabel, running, blockId, scoreRevision, targets };
  }
}

function targetPresentation(target = {}) {
  const error = target.lastError?.error || target.lastError?.status || "";
  const unavailable = ["unreachable", "offline"].includes(target.lastError?.status);
  if (target.state === "active") return { ...target, label: "Live", tone: "ok", unavailable: false, error };
  if (target.state === "prepared") return { ...target, label: "Ready", tone: "ok", unavailable: false, error };
  if (unavailable) return { ...target, label: "Unavailable", tone: "bad", unavailable: true, error };
  if (target.state === "failed") return { ...target, label: "Failed", tone: "bad", unavailable: false, error };
  return { ...target, label: "Saved · not live", tone: "warn", unavailable: false, error };
}

function normalizedServerUrl(value) {
  const resolved = typeof value === "function" ? value() : value;
  return String(resolved ?? "").replace(/\/+$/, "");
}

async function responseError(response) {
  try {
    const body = await response.clone().json();
    return new Error(body?.error || `${response.status} ${response.statusText}`);
  } catch {
    return new Error(`${response.status} ${response.statusText}`);
  }
}
