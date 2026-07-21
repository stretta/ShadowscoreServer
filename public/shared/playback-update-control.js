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
    <button type="button" data-playback-update-action disabled>Apply next beat</button>
    <details data-playback-update-details>
      <summary>Players</summary>
      <div class="ss-playback-update-targets" data-playback-update-targets></div>
    </details>`;

  const stateElement = root.querySelector("[data-playback-update-state]");
  const actionElement = root.querySelector("[data-playback-update-action]");
  const detailsElement = root.querySelector("[data-playback-update-details]");
  const targetsElement = root.querySelector("[data-playback-update-targets]");
  let snapshot;
  let busy = false;
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
      stateElement.textContent = `Playback update failed · ${error.message}`;
      stateElement.className = "ss-playback-update-state bad";
    } finally {
      busy = false;
      await refresh();
    }
  }

  function render() {
    const presentation = playbackUpdatePresentation(snapshot, getBlockId());
    stateElement.textContent = presentation.label;
    stateElement.className = `ss-playback-update-state${presentation.tone ? ` ${presentation.tone}` : ""}`;
    actionElement.textContent = presentation.actionLabel;
    actionElement.disabled = busy || !presentation.actionEnabled;
    actionElement.hidden = !presentation.showAction;
    detailsElement.hidden = presentation.targets.length === 0;
    targetsElement.replaceChildren(...presentation.targets.map((target) => {
      const row = document.createElement("div");
      row.className = `ss-playback-update-target ${target.tone}`;
      row.textContent = `${target.voiceId || target.targetId} · ${target.label}`;
      row.title = target.error || target.targetId;
      return row;
    }));
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
