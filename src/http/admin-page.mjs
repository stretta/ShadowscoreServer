export function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shadowscore Lab Admin</title>
  <link rel="stylesheet" href="/shared/shadowscore-style.css">
  <style>
    :root {
      background: var(--ss-bg);
      color: var(--ss-text);
    }
    body { margin: 0; }
    header {
      justify-content: space-between;
    }
    main { margin: 0 auto; max-width: 1120px; padding: 24px clamp(16px, 4vw, 40px) 40px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
    .session-tools, .scores, .targets, .oscquery-devices, .hardware {
      margin-bottom: 18px;
      padding: 14px;
    }
    .session-tools h2, .scores h2, .targets h2, .oscquery-devices h2, .hardware h2 { font-size: 16px; margin: 0 0 10px; }
    .session-grid {
      align-items: start;
      display: grid;
      gap: 14px;
      grid-template-columns: minmax(220px, 1fr) auto;
    }
    .share-url {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr auto;
      margin-bottom: 12px;
    }
    .preset-row, .backup-row, .score-save-row, .score-new-row, .voice-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .score-save-row { margin: 0 0 8px; }
    .score-new-row { margin: 0 0 10px; }
    .score-save-row input { max-width: 360px; }
    .voice-tools { margin: 0 0 12px; }
    .voice-tools input { max-width: 240px; }
    .qr {
      background: #fff;
      border: 1px solid var(--ss-border-strong);
      display: block;
      height: 180px;
      width: 180px;
    }
    .hint {
      font-size: 13px;
      margin-top: 6px;
    }
    .target-list, .unit-list, .score-list, .oscquery-device-list { display: grid; gap: 8px; }
    .oscquery-device-form {
      align-items: end;
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(150px, 0.7fr) minmax(240px, 1.5fr) minmax(90px, 0.35fr) auto auto;
      margin-bottom: 10px;
    }
    .oscquery-device-form label { color: var(--ss-muted); display: grid; font-size: 12px; gap: 4px; }
    .oscquery-device-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .rnbo-send-state {
      background: rgba(38, 51, 65, 0.46);
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-control);
      display: grid;
      gap: 4px;
      margin-bottom: 8px;
      padding: 9px;
    }
    .rnbo-send-state strong { font-size: 13px; }
    .send-detail {
      color: var(--ss-muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .target, .unit, .score-item, .oscquery-device {
      align-items: center;
      background: rgba(38, 51, 65, 0.46);
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-control);
      display: flex;
      gap: 10px;
      justify-content: space-between;
      padding: 9px;
    }
    .target, .unit, .oscquery-device { align-items: flex-start; }
    .item-main { display: grid; gap: 4px; min-width: 0; }
    .score-detail { font-size: 12px; margin-top: 3px; }
    .target code, .unit code, .oscquery-device code { color: var(--ss-muted); font-size: 12px; }
    .diagnostic {
      background: rgba(251, 191, 36, 0.1);
      border: 1px solid rgba(251, 191, 36, 0.56);
      color: #f9d77e;
      display: grid;
      font-size: 12px;
      gap: 6px;
      margin-top: 6px;
      padding: 7px;
    }
    .diagnostic button {
      min-height: 30px;
      padding: 5px 8px;
      width: fit-content;
    }
    .badge {
      border: 1px solid var(--ss-border-strong);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 8px;
      text-transform: uppercase;
    }
    .badge.online { background: rgba(143, 236, 121, 0.12); border-color: rgba(143, 236, 121, 0.42); color: var(--ss-accent); }
    .badge.offline { background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.48); color: var(--ss-danger); }
    .badge.unassigned { background: rgba(145, 164, 178, 0.12); border-color: var(--ss-border-strong); color: var(--ss-muted); }
    .badge.ambiguous { background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.5); color: var(--ss-warn); }
    .routing-state { display: grid; gap: 4px; min-width: 120px; }
    .routing-detail { font-size: 12px; line-height: 1.25; }
    button {
      min-height: 38px;
    }
    table {
      background: var(--ss-panel);
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-ui);
      border-collapse: collapse;
      overflow: hidden;
      width: 100%;
    }
    th, td {
      font-size: 14px;
      padding: 10px;
      text-align: left;
      vertical-align: middle;
    }
    th { font-size: 12px; text-transform: uppercase; }
    input {
      min-height: 36px;
      padding: 7px 8px;
      width: 100%;
    }
    input[type="checkbox"] { min-height: 18px; width: 18px; }
    .voice { font-weight: 700; white-space: nowrap; }
    .actions { display: flex; gap: 8px; }
    select {
      min-height: 36px;
      padding: 7px 8px;
      width: 100%;
    }
    @media (max-width: 760px) {
      header { align-items: flex-start; flex-direction: column; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      tr { border-bottom: 1px solid #d5d8dc; padding: 12px; }
      td { border: 0; padding: 6px 0; }
      td::before { color: #66717d; content: attr(data-label); display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px; text-transform: uppercase; }
      .actions { flex-wrap: wrap; }
      .oscquery-device-form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Shadowscore Lab Admin</h1>
    <div class="status" id="status">Loading score...</div>
  </header>
  <nav class="ss-route-tabs" aria-label="ShadowScore routes">
    <a href="/">Dashboard</a>
    <a href="/structure-editor">Structure</a>
    <a href="/matrix-edit">Matrix</a>
    <a href="/piano-roll">Piano Roll</a>
    <a href="/event-list">Event List</a>
    <a href="/editors">OSC Generators</a>
    <a href="/admin" aria-current="page">Admin</a>
    <a href="/transport/status">Transport</a>
  </nav>
  <main>
    <div class="toolbar">
      <button class="primary" id="refresh" type="button">Refresh</button>
      <button id="reconcile-assignments" type="button">Refresh routing</button>
      <button class="danger" id="clear-notes" type="button">Clear all notes</button>
      <button class="danger" id="clear-assignments" type="button">Clear assignments</button>
    </div>
    <section class="session-tools">
      <h2>Session link</h2>
      <div class="session-grid">
        <div>
          <div class="share-url">
            <input id="share-url" readonly aria-label="Matrix Edit URL">
            <button id="copy-url" type="button">Copy</button>
          </div>
          <div class="preset-row">
            <select id="assignment-preset" aria-label="Assignment preset"></select>
            <button id="apply-preset" type="button">Apply preset</button>
          </div>
          <div class="backup-row">
            <button id="download-backup" type="button">Download backup</button>
            <button id="restore-backup" type="button">Restore backup</button>
            <button id="import-legacy-notes" type="button">Import voice notes to clips</button>
            <button id="resend-rnbo" type="button">Resend RNBO score</button>
            <input id="restore-file" type="file" accept="application/json,.json" hidden>
          </div>
          <div class="hint" id="session-hint"></div>
        </div>
        <img class="qr" id="qr-code" alt="Matrix Edit QR code">
      </div>
    </section>
    <section class="scores">
      <h2>Saved scores</h2>
      <div class="score-save-row">
        <input id="saved-score-name" autocomplete="off" aria-label="Saved score name" placeholder="Score name">
        <button class="primary" id="save-score" type="button">Save score</button>
        <button id="refresh-scores" type="button">Refresh</button>
      </div>
      <div class="score-new-row">
        <button class="danger" id="new-score" type="button">New score</button>
      </div>
      <div class="score-list" id="saved-scores"></div>
    </section>
    <section class="targets">
      <h2>Discovered RNBO targets</h2>
      <div class="rnbo-send-state" id="rnbo-send-state"></div>
      <div class="target-list" id="targets"></div>
    </section>
    <section class="oscquery-devices">
      <h2>OSCQuery Devices</h2>
      <form class="oscquery-device-form" id="oscquery-device-form">
        <label>Name
          <input id="oscquery-device-name" autocomplete="off" placeholder="Studio Mac">
        </label>
        <label>Hostname, IP, or OSCQuery URL
          <input id="oscquery-device-url" autocomplete="off" required placeholder="studio-mac.local">
        </label>
        <label>OSC port
          <input id="oscquery-device-port" inputmode="numeric" type="number" min="1" max="65535" value="1234">
        </label>
        <button class="primary" id="save-oscquery-device" type="submit">Add device</button>
        <button id="cancel-oscquery-device" type="button" hidden>Cancel</button>
      </form>
      <div class="hint">Add a device that exposes OSCQuery even when it does not run the Shadowscore registration agent. The server will probe it before saving.</div>
      <div class="oscquery-device-list" id="oscquery-devices"></div>
    </section>
    <section class="hardware">
      <h2>Hardware units</h2>
      <div class="unit-list" id="hardware-units"></div>
    </section>
    <div class="voice-tools">
      <input id="new-voice-id" autocomplete="off" aria-label="New voice ID" placeholder="voice-id">
      <button class="primary" id="add-voice" type="button">Add voice</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Live Client</th>
          <th>Routing</th>
          <th>Assignee</th>
          <th>Device</th>
          <th>Client</th>
          <th>Label</th>
          <th>Color</th>
          <th>Locked</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="voices"></tbody>
    </table>
  </main>
  <script>
    const statusEl = document.querySelector("#status");
    const voicesEl = document.querySelector("#voices");
    const targetsEl = document.querySelector("#targets");
    const rnboSendStateEl = document.querySelector("#rnbo-send-state");
    const oscQueryDevicesEl = document.querySelector("#oscquery-devices");
    const oscQueryDeviceFormEl = document.querySelector("#oscquery-device-form");
    const oscQueryDeviceNameEl = document.querySelector("#oscquery-device-name");
    const oscQueryDeviceUrlEl = document.querySelector("#oscquery-device-url");
    const oscQueryDevicePortEl = document.querySelector("#oscquery-device-port");
    const saveOscQueryDeviceEl = document.querySelector("#save-oscquery-device");
    const cancelOscQueryDeviceEl = document.querySelector("#cancel-oscquery-device");
    const hardwareUnitsEl = document.querySelector("#hardware-units");
    const shareUrlEl = document.querySelector("#share-url");
    const qrCodeEl = document.querySelector("#qr-code");
    const sessionHintEl = document.querySelector("#session-hint");
    const assignmentPresetEl = document.querySelector("#assignment-preset");
    const restoreFileEl = document.querySelector("#restore-file");
    const newVoiceIdEl = document.querySelector("#new-voice-id");
    const savedScoreNameEl = document.querySelector("#saved-score-name");
    const savedScoresEl = document.querySelector("#saved-scores");
    const inputs = new Map();
    let discoveredTargets = [];
    let hardwareUnits = [];
    let oscQueryDevices = [];
    let editingOscQueryDeviceId = "";
    let rnboSendQueue = {
      inProgress: false,
      queued: false,
      active: null,
      queuedRequest: null
    };

    document.querySelector("#refresh").addEventListener("click", loadSession);
    document.querySelector("#reconcile-assignments").addEventListener("click", reconcileAssignments);
    document.querySelector("#clear-notes").addEventListener("click", () => resetScore({ notes: true }, "Clear all notes?"));
    document.querySelector("#clear-assignments").addEventListener("click", () => resetScore({ assignments: true }, "Clear all voice assignments?"));
    document.querySelector("#copy-url").addEventListener("click", copyShareUrl);
    document.querySelector("#apply-preset").addEventListener("click", applyAssignmentPreset);
    document.querySelector("#download-backup").addEventListener("click", () => { window.location.href = "/admin/backup"; });
    document.querySelector("#restore-backup").addEventListener("click", () => restoreFileEl.click());
    document.querySelector("#import-legacy-notes").addEventListener("click", importLegacyVoiceNotes);
    document.querySelector("#resend-rnbo").addEventListener("click", resendRnboScore);
    document.querySelector("#add-voice").addEventListener("click", addVoice);
    document.querySelector("#save-score").addEventListener("click", saveScoreToLibrary);
    document.querySelector("#refresh-scores").addEventListener("click", loadSavedScores);
    document.querySelector("#new-score").addEventListener("click", createNewScore);
    oscQueryDeviceFormEl.addEventListener("submit", saveOscQueryDevice);
    cancelOscQueryDeviceEl.addEventListener("click", resetOscQueryDeviceForm);
    restoreFileEl.addEventListener("change", restoreBackup);

    loadSession();
    const events = new EventSource("/events");
    events.addEventListener("snapshot", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.replaced", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.cleared", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.preset.applied", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.reconciled", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.added", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.removed", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.reset", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.score.created", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.restore", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.legacyVoiceNotes.imported", (event) => render(JSON.parse(event.data).score));
    events.onerror = () => setStatus("Event stream reconnecting...");
    window.setInterval(refreshRnboTargets, 2000);
    window.setInterval(loadOscQueryDevices, 5000);

    async function loadSession() {
      const response = await fetch("/session");
      const session = await response.json();
      discoveredTargets = session.rnbo?.targets ?? [];
      rnboSendQueue = session.rnbo?.sendQueue ?? rnboSendQueue;
      hardwareUnits = session.hardwareUnits ?? [];
      renderSessionTools(session);
      await refreshRnboTargets();
      await loadOscQueryDevices();
      renderHardwareUnits(hardwareUnits);
      await loadSavedScores();
      const scoreResponse = await fetch("/score");
      render(await scoreResponse.json());
    }

    function render(score) {
      inputs.clear();
      voicesEl.textContent = "";
      const assignments = score.assignments ?? {};
      for (const voiceId of Object.keys(score.voices)) {
        const assignment = assignments[voiceId] ?? {};
        const row = document.createElement("tr");
        row.dataset.voice = voiceId;
        row.append(cell("Player", voiceId, "voice"));
        row.append(targetCell("Live Client", voiceId, assignment, assignments));
        row.append(routingCell("Routing", assignment));
        row.append(inputCell("Assignee", voiceId, "assignee", assignment.assignee ?? ""));
        row.append(inputCell("Device", voiceId, "deviceId", assignment.deviceId ?? ""));
        row.append(inputCell("Client", voiceId, "clientId", assignment.clientId ?? ""));
        row.append(inputCell("Label", voiceId, "label", assignment.label ?? ""));
        row.append(inputCell("Color", voiceId, "color", assignment.color ?? ""));
        row.append(checkCell("Locked", voiceId, "locked", Boolean(assignment.locked)));
        row.append(actionsCell(voiceId));
        voicesEl.append(row);
      }
      setStatus(score.ensembleId + " · score v" + score.version);
    }

    function renderTargets(targets) {
      targetsEl.textContent = "";
      if (targets.length === 0) {
        const empty = document.createElement("div");
        empty.className = "target";
        empty.textContent = "No ShadowScoreClient RNBO targets discovered.";
        targetsEl.append(empty);
        return;
      }
      for (const target of targets) {
        const row = document.createElement("div");
        row.className = "target";
        const main = document.createElement("div");
        main.className = "item-main";
        const label = document.createElement("div");
        label.textContent = displayTargetLabel(target);
        const code = document.createElement("code");
        code.textContent = target.host + ":" + target.port + target.address;
        main.append(label, code, targetSendStatus(target));
        appendDiagnostics(main, target);
        row.append(main, statusBadge(target.available === false ? "offline" : "online"));
        targetsEl.append(row);
      }
    }

    function renderOscQueryDevices(devices) {
      oscQueryDevicesEl.textContent = "";
      if (devices.length === 0) {
        const empty = document.createElement("div");
        empty.className = "oscquery-device";
        empty.textContent = "No manually configured OSCQuery devices.";
        oscQueryDevicesEl.append(empty);
        return;
      }
      for (const device of devices) {
        const row = document.createElement("div");
        row.className = "oscquery-device";
        const main = document.createElement("div");
        main.className = "item-main";
        const label = document.createElement("div");
        label.textContent = device.name;
        const endpoint = document.createElement("code");
        endpoint.textContent = device.oscQueryUrl + " · OSC " + device.host + ":" + device.oscPort;
        const detail = document.createElement("div");
        detail.className = "send-detail";
        const instances = (device.instances ?? []).map((instance) => instance.name).join(", ");
        detail.textContent = (device.instances?.length ?? 0) + " instance(s)" + (instances ? " · " + instances : "") + (device.lastSeenAt ? " · seen " + formatTime(device.lastSeenAt) : "");
        main.append(label, endpoint, detail);
        if (device.lastError) {
          const error = document.createElement("div");
          error.className = "diagnostic";
          error.textContent = device.lastError;
          main.append(error);
        }
        const controls = document.createElement("div");
        controls.className = "oscquery-device-actions";
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.textContent = "Refresh";
        refresh.addEventListener("click", () => refreshOscQueryDevice(device.id));
        const configure = document.createElement("button");
        configure.type = "button";
        configure.textContent = "Configure";
        configure.addEventListener("click", () => configureOscQueryDevice(device));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => removeOscQueryDevice(device.id));
        controls.append(statusBadge(device.status ?? "offline"), refresh, configure, remove);
        row.append(main, controls);
        oscQueryDevicesEl.append(row);
      }
    }

    function renderRnboSendState() {
      rnboSendStateEl.textContent = "";
      const title = document.createElement("strong");
      title.textContent = rnboSendQueue.inProgress
        ? "RNBO resend in progress"
        : rnboSendQueue.queued
          ? "RNBO resend queued"
          : "RNBO resend idle";
      const active = document.createElement("div");
      active.className = "send-detail";
      active.textContent = sendQueueDetail(rnboSendQueue.active);
      rnboSendStateEl.append(title, active);
      if (rnboSendQueue.queuedRequest) {
        const queued = document.createElement("div");
        queued.className = "send-detail";
        queued.textContent = "Queued: " + sendQueueDetail(rnboSendQueue.queuedRequest);
        rnboSendStateEl.append(queued);
      }
    }

    function sendQueueDetail(request) {
      if (!request) {
        return "No resend is currently queued or running.";
      }
      const bits = [
        "score v" + request.scoreVersion,
        "score rev " + request.scoreRevision,
        "structure rev " + request.structureRevision,
        request.transactionId ? "txn " + request.transactionId : "",
        request.forceFullClearRows ? "full-clear" : "",
        request.reasons?.length ? request.reasons.join("+") : ""
      ].filter(Boolean);
      return bits.join(" · ");
    }

    function targetSendStatus(target) {
      const detail = document.createElement("div");
      detail.className = "send-detail";
      const status = target.sendStatus;
      if (!status) {
        detail.textContent = "No RNBO score commit recorded yet.";
        return detail;
      }
      const ack = status.ack;
      const ackText = ack
        ? (ack.ok ? "ACK " + ack.status : "ACK " + ack.status)
        : "ACK unavailable";
      detail.textContent = [
        "Last commit " + formatTime(status.at),
        "voice " + (status.voiceId || "unassigned"),
        "notes " + status.noteCount,
        "rows " + status.transmittedRowCount,
        "txn " + (ack?.transactionId ?? ""),
        ackText
      ].filter(Boolean).join(" · ");
      return detail;
    }

    function renderHardwareUnits(units) {
      hardwareUnitsEl.textContent = "";
      if (units.length === 0) {
        const empty = document.createElement("div");
        empty.className = "unit";
        empty.textContent = "No hardware units registered.";
        hardwareUnitsEl.append(empty);
        return;
      }
      for (const unit of units) {
        const row = document.createElement("div");
        row.className = "unit";
        const main = document.createElement("div");
        main.className = "item-main";
        const label = document.createElement("div");
        label.textContent = (unit.advertisedName ?? unit.id) + (unit.local ? " · local host" : "");
        const detail = document.createElement("code");
        const remote = unit.remoteAddress ? " · seen at " + unit.remoteAddress : "";
        detail.textContent = unit.id + " · targets " + (unit.targets?.length ?? 0) + remote;
        main.append(label, detail);
        appendDiagnostics(main, unit);
        row.append(main, statusBadge(unit.status ?? "offline"));
        hardwareUnitsEl.append(row);
      }
    }

    function appendDiagnostics(parent, item) {
      for (const diagnostic of item.diagnostics ?? []) {
        if (diagnostic.type !== "target-host-mismatch") continue;
        const warning = document.createElement("div");
        warning.className = "diagnostic";
        const message = document.createElement("div");
        message.textContent = diagnostic.message;
        warning.append(message);
        if (diagnostic.repairable) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Use observed IP";
          button.addEventListener("click", () => useObservedHost(diagnostic.unitId, diagnostic.targetId));
          warning.append(button);
        }
        parent.append(warning);
      }
    }

    function renderSavedScores(scores) {
      savedScoresEl.textContent = "";
      if (scores.length === 0) {
        const empty = document.createElement("div");
        empty.className = "score-item";
        empty.textContent = "No saved scores on this Pi.";
        savedScoresEl.append(empty);
        return;
      }
      for (const savedScore of scores) {
        const row = document.createElement("div");
        row.className = "score-item";
        const label = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = savedScore.name;
        const detail = document.createElement("div");
        detail.className = "score-detail";
        detail.textContent = savedScore.id + " · v" + savedScore.version + " · " + formatDate(savedScore.savedAt);
        label.append(name, detail);

        const actions = document.createElement("div");
        actions.className = "actions";
        const load = document.createElement("button");
        load.type = "button";
        load.className = "primary";
        load.textContent = "Load";
        load.addEventListener("click", () => loadSavedScore(savedScore.id));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteSavedScore(savedScore.id));
        actions.append(load, remove);
        row.append(label, actions);
        savedScoresEl.append(row);
      }
    }

    function formatDate(value) {
      const date = new Date(value);
      return Number.isFinite(date.valueOf()) ? date.toLocaleString() : value;
    }

    function statusBadge(status) {
      const badge = document.createElement("span");
      badge.className = "badge " + status;
      badge.textContent = status;
      return badge;
    }

    function cell(label, text, className) {
      const td = document.createElement("td");
      td.dataset.label = label;
      td.className = className ?? "";
      td.textContent = text;
      return td;
    }

    function inputCell(label, voiceId, field, value) {
      const input = document.createElement("input");
      input.value = value;
      input.autocomplete = "off";
      input.dataset.voice = voiceId;
      input.dataset.field = field;
      rememberInput(voiceId, field, input);
      const td = document.createElement("td");
      td.dataset.label = label;
      td.append(input);
      return td;
    }

    function targetCell(label, voiceId, assignment, assignments) {
      const select = document.createElement("select");
      select.dataset.voice = voiceId;
      select.dataset.field = "rnboTargetId";
      const current = assignment.rnboTargetId ?? "";
      select.append(new Option("Unassigned", ""));
      for (const [unitName, targets] of groupedTargets(discoveredTargets)) {
        const group = document.createElement("optgroup");
        group.label = unitName;
        for (const target of targets) {
          const assignedVoiceId = assignedVoiceForTarget(target.id, assignments, voiceId);
          const suffix = [
            target.available === false ? "offline" : "",
            assignedVoiceId ? "assigned to " + assignmentLabel(assignedVoiceId, assignments[assignedVoiceId]) : ""
          ].filter(Boolean).join(" · ");
          const option = new Option(displayTargetLabel(target) + (suffix ? " · " + suffix : ""), target.id);
          option.disabled = target.available === false || Boolean(assignedVoiceId);
          option.dataset.target = JSON.stringify(target);
          group.append(option);
        }
        select.append(group);
      }
      if (current && !discoveredTargets.some((target) => target.id === current)) {
        const stale = new Option("Assigned target offline · " + current, current);
        stale.disabled = true;
        stale.dataset.target = JSON.stringify({
          id: current,
          host: assignment.rnboHost ?? "",
          port: assignment.rnboPort ?? null,
          address: assignment.rnboAddress ?? "",
          available: false
        });
        select.append(stale);
      }
      select.value = current;
      rememberInput(voiceId, "rnboTargetId", select);
      const td = document.createElement("td");
      td.dataset.label = label;
      td.append(select);
      return td;
    }

    function routingCell(label, assignment) {
      const state = routingState(assignment);
      const wrapper = document.createElement("div");
      wrapper.className = "routing-state";
      wrapper.append(statusBadge(state.status));
      const detail = document.createElement("div");
      detail.className = "routing-detail";
      detail.textContent = state.detail;
      wrapper.append(detail);
      const td = document.createElement("td");
      td.dataset.label = label;
      td.append(wrapper);
      return td;
    }

    function checkCell(label, voiceId, field, value) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.dataset.voice = voiceId;
      input.dataset.field = field;
      rememberInput(voiceId, field, input);
      const td = document.createElement("td");
      td.dataset.label = label;
      td.append(input);
      return td;
    }

    function actionsCell(voiceId) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary";
      save.textContent = "Save";
      save.dataset.voice = voiceId;
      save.dataset.action = "save-assignment";
      save.addEventListener("click", () => saveAssignment(voiceId));

      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear";
      clear.dataset.voice = voiceId;
      clear.dataset.action = "clear-assignment";
      clear.addEventListener("click", () => clearAssignment(voiceId));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.dataset.voice = voiceId;
      remove.dataset.action = "remove-voice";
      remove.addEventListener("click", () => removeVoice(voiceId));

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(save, clear, remove);

      const td = document.createElement("td");
      td.dataset.label = "Actions";
      td.append(actions);
      return td;
    }

    function rememberInput(voiceId, field, input) {
      if (!inputs.has(voiceId)) inputs.set(voiceId, {});
      inputs.get(voiceId)[field] = input;
    }

    async function saveAssignment(voiceId) {
      const fields = inputs.get(voiceId);
      const body = {
        ...targetFields(fields.rnboTargetId),
        assignee: fields.assignee.value,
        deviceId: fields.deviceId.value,
        clientId: fields.clientId.value,
        label: fields.label.value,
        color: fields.color.value,
        locked: fields.locked.checked
      };
      const response = await fetch("/voices/" + encodeURIComponent(voiceId) + "/assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok || result.ok === false) {
        setStatus(result.error ?? "Assignment save failed.");
        return;
      }
      render(result);
    }

    async function reconcileAssignments() {
      const response = await fetch("/assignments/reconcile", { method: "POST" });
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      await loadSession();
      const count = (body.reconciled?.length ?? 0) + (body.ambiguous?.length ?? 0);
      setStatus(count === 0 ? "Routing already current." : "Refreshed routing for " + count + " assignment(s).");
    }

    function targetFields(select) {
      if (!select?.value) {
        return {
          rnboTargetId: "",
          rnboHost: "",
          rnboPort: null,
          rnboAddress: ""
        };
      }
      const option = select.selectedOptions[0];
      const target = JSON.parse(option.dataset.target);
      return {
        rnboTargetId: target.id,
        rnboHost: target.host,
        rnboPort: target.port,
        rnboAddress: target.address
      };
    }

    function renderSessionTools(session) {
      const appUrl = session.endpoints?.app ?? window.location.origin + "/";
      shareUrlEl.value = appUrl;
      qrCodeEl.src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(appUrl);
      sessionHintEl.textContent = session.server?.role === "host"
        ? "Students can open this URL on the classroom network."
        : "This device is not configured as the session host.";
      assignmentPresetEl.textContent = "";
      const presets = session.assignmentPresets ?? [];
      if (presets.length === 0) {
        assignmentPresetEl.append(new Option("No presets configured", ""));
        assignmentPresetEl.disabled = true;
      } else {
        assignmentPresetEl.disabled = false;
        for (const preset of presets) {
          assignmentPresetEl.append(new Option(preset.label, preset.id));
        }
      }
    }

    async function copyShareUrl() {
      shareUrlEl.select();
      try {
        await navigator.clipboard.writeText(shareUrlEl.value);
      } catch {
        document.execCommand("copy");
      }
      setStatus("Copied Matrix Edit URL.");
    }

    async function addVoice() {
      const voiceId = newVoiceIdEl.value.trim();
      if (!voiceId) return;
      const response = await fetch("/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId, assignment: { label: voiceId } })
      });
      const score = await response.json();
      if (score.ok === false) {
        setStatus(score.error);
        return;
      }
      newVoiceIdEl.value = "";
      render(score);
    }

    async function loadSavedScores() {
      const response = await fetch("/admin/scores");
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      renderSavedScores(body.scores ?? []);
    }

    async function refreshRnboTargets() {
      const response = await fetch("/rnbo/targets");
      const body = await response.json();
      discoveredTargets = body.targets ?? [];
      rnboSendQueue = body.sendQueue ?? rnboSendQueue;
      renderRnboSendState();
      renderTargets(discoveredTargets);
    }

    async function loadOscQueryDevices(force = false) {
      const response = await fetch("/oscquery/devices" + (force ? "?refresh=true" : ""));
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      oscQueryDevices = body.devices ?? [];
      renderOscQueryDevices(oscQueryDevices);
    }

    async function saveOscQueryDevice(event) {
      event.preventDefault();
      const document = {
        name: oscQueryDeviceNameEl.value.trim(),
        oscQueryUrl: oscQueryDeviceUrlEl.value.trim(),
        oscPort: Number(oscQueryDevicePortEl.value || 1234)
      };
      setStatus((editingOscQueryDeviceId ? "Updating" : "Probing") + " OSCQuery device...");
      const response = await fetch(
        editingOscQueryDeviceId ? "/oscquery/devices/" + encodeURIComponent(editingOscQueryDeviceId) : "/oscquery/devices",
        {
          method: editingOscQueryDeviceId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(document)
        }
      );
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      resetOscQueryDeviceForm();
      setStatus("Saved OSCQuery device " + body.device.name + ".");
      await loadOscQueryDevices();
      await refreshRnboTargets();
    }

    function configureOscQueryDevice(device) {
      editingOscQueryDeviceId = device.id;
      oscQueryDeviceNameEl.value = device.name ?? "";
      oscQueryDeviceUrlEl.value = device.oscQueryUrl ?? "";
      oscQueryDevicePortEl.value = device.oscPort ?? 1234;
      saveOscQueryDeviceEl.textContent = "Update device";
      cancelOscQueryDeviceEl.hidden = false;
      oscQueryDeviceUrlEl.focus();
    }

    function resetOscQueryDeviceForm() {
      editingOscQueryDeviceId = "";
      oscQueryDeviceFormEl.reset();
      oscQueryDevicePortEl.value = 1234;
      saveOscQueryDeviceEl.textContent = "Add device";
      cancelOscQueryDeviceEl.hidden = true;
    }

    async function refreshOscQueryDevice(deviceId) {
      setStatus("Refreshing OSCQuery device...");
      const response = await fetch("/oscquery/devices/" + encodeURIComponent(deviceId) + "/refresh", { method: "POST" });
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      setStatus("Refreshed OSCQuery device " + body.device.name + ".");
      await loadOscQueryDevices();
      await refreshRnboTargets();
    }

    async function removeOscQueryDevice(deviceId) {
      const device = oscQueryDevices.find((entry) => entry.id === deviceId);
      if (!confirm("Remove OSCQuery device " + (device?.name ?? deviceId) + "?")) return;
      const response = await fetch("/oscquery/devices/" + encodeURIComponent(deviceId), { method: "DELETE" });
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      if (editingOscQueryDeviceId === deviceId) resetOscQueryDeviceForm();
      setStatus("Removed OSCQuery device " + body.device.name + ".");
      await loadOscQueryDevices();
      await refreshRnboTargets();
    }

    async function saveScoreToLibrary() {
      const name = savedScoreNameEl.value.trim();
      const response = await fetch("/admin/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      savedScoreNameEl.value = "";
      setStatus("Saved score " + body.score.name + ".");
      await loadSavedScores();
    }

    async function createNewScore() {
      if (!confirm("Create a new score from defaults? Current score state will be replaced.")) return;
      const response = await fetch("/admin/scores/new", { method: "POST" });
      const score = await response.json();
      if (score.ok === false) {
        setStatus(score.error);
        return;
      }
      render(score);
      setStatus("Created new score from defaults.");
      await loadSavedScores();
    }

    async function loadSavedScore(id) {
      if (!confirm("Load this saved score? Current score state will be replaced.")) return;
      const response = await fetch("/admin/scores/" + encodeURIComponent(id) + "/load", { method: "POST" });
      const score = await response.json();
      if (score.ok === false) {
        setStatus(score.error);
        return;
      }
      render(score);
      await loadSavedScores();
    }

    async function deleteSavedScore(id) {
      if (!confirm("Delete this saved score from the Pi?")) return;
      const response = await fetch("/admin/scores/" + encodeURIComponent(id), { method: "DELETE" });
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      renderSavedScores(body.scores ?? []);
      setStatus("Deleted saved score.");
    }

    async function applyAssignmentPreset() {
      if (!assignmentPresetEl.value) return;
      if (!confirm("Apply this assignment preset?")) return;
      const response = await fetch("/admin/assignment-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: assignmentPresetEl.value })
      });
      render(await response.json());
    }

    async function restoreBackup() {
      const file = restoreFileEl.files?.[0];
      restoreFileEl.value = "";
      if (!file) return;
      if (!confirm("Restore this score backup? Current score state will be replaced.")) return;
      const response = await fetch("/admin/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text()
      });
      render(await response.json());
    }

    async function importLegacyVoiceNotes() {
      if (!confirm("Import non-empty legacy voice notes into looped clips assigned to block A? Existing clips will not be overwritten.")) return;
      const response = await fetch("/admin/import-legacy-voice-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId: "A" })
      });
      const score = await response.json();
      if (score.ok === false) {
        setStatus(score.error);
        return;
      }
      render(score);
    }

    async function resendRnboScore() {
      setStatus("RNBO resend requested.");
      const response = await fetch("/admin/rnbo/resend", { method: "POST" });
      await refreshRnboTargets();
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      rnboSendQueue = body.sendQueue ?? rnboSendQueue;
      renderRnboSendState();
      setStatus("RNBO resend queued.");
      await refreshRnboTargets();
    }

    async function useObservedHost(unitId, targetId) {
      const response = await fetch(
        "/hardware/units/" + encodeURIComponent(unitId) + "/targets/" + encodeURIComponent(targetId) + "/use-observed-host",
        { method: "POST" }
      );
      const body = await response.json();
      if (body.ok === false) {
        setStatus(body.error);
        return;
      }
      setStatus("Using observed IP for " + unitId + " until the peer registers a new target.");
      await loadSession();
    }

    function displayTargetLabel(target) {
      const unit = target.hardwareUnitName || target.hardwareUnitId || "";
      const name = friendlyTargetName(target);
      return unit ? unit + " / " + name : name;
    }

    function friendlyTargetName(target) {
      const name = target.name ?? target.id ?? target.address ?? "RNBO target";
      if (/ShadowScoreClient/i.test(name) && /shadowscore/i.test(target.address ?? name)) {
        return "Source";
      }
      return name;
    }

    function groupedTargets(targets) {
      const groups = new Map();
      for (const target of targets) {
        const unit = target.hardwareUnitName || target.hardwareUnitId || "Local targets";
        if (!groups.has(unit)) groups.set(unit, []);
        groups.get(unit).push(target);
      }
      return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
    }

    function routingState(assignment) {
      if (assignment.routingStatus === "ambiguous") {
        return { status: "ambiguous", detail: assignment.routingMessage || "Choose a live target manually." };
      }
      if (!assignment.rnboTargetId) {
        return assignment.deviceId
          ? { status: "unassigned", detail: "Waiting for " + assignment.deviceId + " target." }
          : { status: "unassigned", detail: "No client identity set." };
      }
      const target = discoveredTargets.find((entry) => entry.id === assignment.rnboTargetId);
      if (!target || target.available === false) {
        return { status: "offline", detail: assignment.deviceId ? assignment.deviceId + " target unavailable." : "Target unavailable." };
      }
      return { status: "online", detail: displayTargetLabel(target) };
    }

    function assignedVoiceForTarget(targetId, assignments, currentVoiceId) {
      if (!targetId) return "";
      for (const [voiceId, assignment] of Object.entries(assignments ?? {})) {
        if (voiceId !== currentVoiceId && assignment?.rnboTargetId === targetId) {
          return voiceId;
        }
      }
      return "";
    }

    function assignmentLabel(voiceId, assignment) {
      return assignment?.label || assignment?.assignee || assignment?.deviceId || voiceId;
    }

    function formatTime(value) {
      const date = new Date(value);
      return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString() : "unknown time";
    }

    async function clearAssignment(voiceId) {
      const response = await fetch("/voices/" + encodeURIComponent(voiceId) + "/assignment", { method: "DELETE" });
      render(await response.json());
    }

    async function removeVoice(voiceId) {
      if (!confirm("Remove " + voiceId + " and its notes?")) return;
      const response = await fetch("/voices/" + encodeURIComponent(voiceId), { method: "DELETE" });
      render(await response.json());
    }

    async function resetScore(options, message) {
      if (!confirm(message)) return;
      const response = await fetch("/admin/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      render(await response.json());
    }

    function setStatus(message) {
      statusEl.textContent = message;
    }
  </script>
</body>
</html>`;
}
