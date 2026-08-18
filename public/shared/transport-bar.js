const OBJECT_URL = "/api/v1/objects/transport";
const EVENTS_URL = `${OBJECT_URL}/events`;

export function createShadowScoreTransportBar(options = {}) {
  const root = document.createElement("section");
  root.className = "ss-transport-bar";
  root.setAttribute("aria-label", "ShadowScore transport");
  root.innerHTML = `
    <div class="ss-transport-actions" role="group" aria-label="Playback">
      <button type="button" class="ss-transport-icon" data-command="play" aria-label="Play" title="Play">▶</button>
      <button type="button" class="ss-transport-icon" data-command="stop" aria-label="Stop" title="Stop">■</button>
      <button type="button" class="ss-transport-icon" data-command="return_to_start" aria-label="Return to start" title="Return to start">↤</button>
    </div>
    <div class="ss-transport-section" role="group" aria-label="Section">
      <button type="button" class="ss-transport-icon" data-command="previous_section" aria-label="Previous section" title="Previous section">‹</button>
      <output data-field="section" aria-label="Current section">—</output>
      <button type="button" class="ss-transport-icon" data-command="next_section" aria-label="Next section" title="Next section">›</button>
    </div>
    <input data-field="position" class="ss-transport-position" type="range" min="0" max="1" step="0.0001" value="0" disabled aria-label="Arrangement position" title="Continuous locate will be enabled after coordinated player seek is implemented">
    <output data-field="clock" class="ss-transport-clock" aria-label="Elapsed time">00:00 / 00:00</output>
    <output data-field="bbt" class="ss-transport-bbt" aria-label="Bars beats ticks">1.1.000</output>
    <label class="ss-transport-tempo"><input data-field="tempo" type="number" min="20" max="400" step="0.01" inputmode="decimal" aria-label="Tempo"><span>BPM</span></label>
    <button type="button" class="ss-transport-sync" data-command="re_sync" data-tone="uncertain" title="Re-sync all players"><span aria-hidden="true"></span><output data-field="sync">SYNC</output></button>
    <output data-field="error" class="ss-transport-error" role="status" aria-live="polite"></output>
  `;

  const fields = Object.fromEntries([...root.querySelectorAll("[data-field]")].map((element) => [element.dataset.field, element]));
  let snapshot = null;
  let snapshotReceivedAt = 0;
  let commandPending = false;
  let animationFrame = 0;
  let tempoCommitTimer = 0;
  let pendingTempo = null;
  let tempoCommitInProgress = false;
  let tempoDrag = null;
  let suppressTempoClick = false;

  root.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => void command(button.dataset.command));
  });
  fields.tempo.addEventListener("input", () => queueTempoCommit(false));
  fields.tempo.addEventListener("change", () => queueTempoCommit(true));
  fields.tempo.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      queueTempoCommit(true);
      fields.tempo.blur();
    }
  });
  fields.tempo.addEventListener("pointerdown", beginTempoDrag);
  fields.tempo.addEventListener("click", (event) => {
    if (!suppressTempoClick) return;
    event.preventDefault();
    suppressTempoClick = false;
  });

  function connect() {
    if (typeof EventSource !== "function") {
      void fetchSnapshot();
      return;
    }
    const events = new EventSource(EVENTS_URL);
    events.addEventListener("snapshot", (event) => receive(JSON.parse(event.data)));
    events.addEventListener("error", () => {
      fields.error.textContent = "Transport reconnecting…";
      root.dataset.connected = "false";
    });
  }

  async function fetchSnapshot() {
    try {
      const response = await fetch(OBJECT_URL);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      receive(body.object);
    } catch (error) {
      fields.error.textContent = error.message;
    }
  }

  async function command(operation, args = {}) {
    if (commandPending) return;
    commandPending = true;
    root.dataset.pending = "true";
    fields.error.textContent = "";
    try {
      const response = await fetch(OBJECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation,
          args,
          client_id: options.clientId ?? "browser-transport",
          request_id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${operation}`
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      receive(body.object);
    } catch (error) {
      fields.error.textContent = error.message;
    } finally {
      commandPending = false;
      root.dataset.pending = "false";
    }
  }

  function queueTempoCommit(immediate) {
    const bpm = Number(fields.tempo.value);
    if (!Number.isFinite(bpm) || bpm <= 0 || !fields.tempo.checkValidity()) return;
    pendingTempo = bpm;
    clearTimeout(tempoCommitTimer);
    if (immediate) {
      void flushTempoCommit();
    } else {
      tempoCommitTimer = setTimeout(() => void flushTempoCommit(), 300);
    }
  }

  async function flushTempoCommit() {
    clearTimeout(tempoCommitTimer);
    if (tempoCommitInProgress) return;
    if (commandPending) {
      tempoCommitTimer = setTimeout(() => void flushTempoCommit(), 50);
      return;
    }
    tempoCommitInProgress = true;
    try {
      while (pendingTempo !== null) {
        const bpm = pendingTempo;
        pendingTempo = null;
        await command("set_tempo", { bpm });
      }
    } finally {
      tempoCommitInProgress = false;
    }
  }

  function beginTempoDrag(event) {
    if (event.button !== 0) return;
    tempoDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTempo: Number(fields.tempo.value) || Number(snapshot?.tempo) || 120,
      active: false
    };
    window.addEventListener("pointermove", moveTempoDrag);
    window.addEventListener("pointerup", endTempoDrag);
    window.addEventListener("pointercancel", endTempoDrag);
  }

  function moveTempoDrag(event) {
    if (!tempoDrag || event.pointerId !== tempoDrag.pointerId) return;
    const deltaY = event.clientY - tempoDrag.startY;
    if (!tempoDrag.active && Math.abs(deltaY) < 3) return;
    tempoDrag.active = true;
    event.preventDefault();
    root.dataset.tempoDragging = "true";
    fields.tempo.value = String(dragTempoValue(tempoDrag.startTempo, deltaY, {
      fine: event.shiftKey
    }));
    queueTempoCommit(false);
  }

  function endTempoDrag(event) {
    if (!tempoDrag || event.pointerId !== tempoDrag.pointerId) return;
    const wasActive = tempoDrag.active;
    tempoDrag = null;
    window.removeEventListener("pointermove", moveTempoDrag);
    window.removeEventListener("pointerup", endTempoDrag);
    window.removeEventListener("pointercancel", endTempoDrag);
    delete root.dataset.tempoDragging;
    if (wasActive) {
      event.preventDefault();
      suppressTempoClick = true;
      queueTempoCommit(true);
      fields.tempo.select();
    }
  }

  function receive(next) {
    if (!next || (snapshot && Number(next.revision) < Number(snapshot.revision))) return;
    snapshot = next;
    snapshotReceivedAt = performance.now();
    root.dataset.connected = "true";
    root.dataset.playing = String(Boolean(next.is_playing));
    fields.section.textContent = next.active_section || "—";
    if (document.activeElement !== fields.tempo) fields.tempo.value = formatTempo(next.tempo);
    fields.sync.textContent = syncLabel(next.sync);
    fields.sync.parentElement.dataset.tone = next.sync?.state ?? "uncertain";
    fields.sync.parentElement.title = next.sync?.reason || "Transport sync status";
    fields.position.disabled = next.capabilities?.can_locate !== true;
    fields.error.textContent = "";
    renderPosition(performance.now());
    if (!animationFrame) animationFrame = requestAnimationFrame(animate);
  }

  function animate(now) {
    animationFrame = 0;
    if (!snapshot) return;
    renderPosition(now);
    if (snapshot.is_playing) animationFrame = requestAnimationFrame(animate);
  }

  function renderPosition(now) {
    const elapsedSeconds = snapshot.is_playing ? Math.max(0, now - snapshotReceivedAt) / 1000 : 0;
    const durationSeconds = Math.max(0, Number(snapshot.duration_seconds) || 0);
    const positionSeconds = durationSeconds > 0
      ? (Math.max(0, Number(snapshot.position_seconds) || 0) + elapsedSeconds) % durationSeconds
      : 0;
    const durationBeats = Math.max(0, Number(snapshot.duration_beats) || 0);
    const positionBeats = durationBeats > 0
      ? (Math.max(0, Number(snapshot.position_beats) || 0) + elapsedSeconds * Math.max(0, Number(snapshot.tempo) || 0) / 60) % durationBeats
      : 0;
    fields.position.value = durationSeconds > 0 ? String(positionSeconds / durationSeconds) : "0";
    fields.clock.textContent = `${formatClock(positionSeconds)} / ${formatClock(durationSeconds)}`;
    fields.bbt.textContent = formatBbt(positionBeats, snapshot.time_signature_numerator);
  }

  return { root, connect, receive, command };
}

export function mountShadowScoreTransportBar(navigationRoot, options = {}) {
  const existing = document.querySelector(".ss-transport-bar");
  if (existing) return existing;
  const transport = createShadowScoreTransportBar(options);
  navigationRoot.insertAdjacentElement("afterend", transport.root);
  transport.connect();
  return transport.root;
}

export function formatClock(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatBbt(positionBeats, beatsPerBar = 4, ticksPerBeat = 960) {
  const beat = Math.max(0, Number(positionBeats) || 0);
  const meter = Math.max(1, Number(beatsPerBar) || 4);
  const bar = Math.floor(beat / meter) + 1;
  const within = beat - ((bar - 1) * meter);
  const beatNumber = Math.floor(within) + 1;
  const tick = Math.floor((within - Math.floor(within)) * ticksPerBeat);
  return `${bar}.${beatNumber}.${String(tick).padStart(3, "0")}`;
}

export function dragTempoValue(startTempo, deltaY, options = {}) {
  const minimum = Number(options.minimum) || 20;
  const maximum = Number(options.maximum) || 400;
  const sensitivity = options.fine ? 0.02 : 0.2;
  const value = Math.min(maximum, Math.max(minimum,
    (Number(startTempo) || 120) - ((Number(deltaY) || 0) * sensitivity)));
  return Number(value.toFixed(2));
}

function formatTempo(value) {
  const tempo = Number(value);
  return Number.isFinite(tempo) ? tempo.toFixed(tempo % 1 ? 2 : 0) : "120";
}

function syncLabel(sync = {}) {
  if (sync.state === "aligned") return "SYNC";
  if (sync.state === "slipped") return "RE-SYNC";
  if (sync.state === "offset") return "OFFSET";
  if (sync.state === "preparing") return "PREP";
  if (sync.state === "stale") return "STALE";
  if (sync.state === "degraded") return "DEGRADED";
  return "SYNC ?";
}
