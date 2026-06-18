export function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shadowscore Lab Admin</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f2;
      color: #202124;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header {
      align-items: center;
      background: #1f2933;
      color: #fff;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      padding: 18px clamp(16px, 4vw, 40px);
    }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: 0; margin: 0; }
    main { margin: 0 auto; max-width: 1120px; padding: 24px clamp(16px, 4vw, 40px) 40px; }
    .status { color: #c8d1da; font-size: 14px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
    .session-tools, .targets, .hardware {
      background: #fff;
      border: 1px solid #d5d8dc;
      margin-bottom: 18px;
      padding: 14px;
    }
    .session-tools h2, .targets h2, .hardware h2 { font-size: 16px; margin: 0 0 10px; }
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
    .preset-row, .backup-row, .voice-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .voice-tools { margin: 0 0 12px; }
    .voice-tools input { max-width: 240px; }
    .qr {
      border: 1px solid #d5d8dc;
      display: block;
      height: 180px;
      width: 180px;
    }
    .hint {
      color: #66717d;
      font-size: 13px;
      margin-top: 6px;
    }
    .target-list, .unit-list { display: grid; gap: 8px; }
    .target, .unit {
      align-items: center;
      border: 1px solid #e1e4e8;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      padding: 9px;
    }
    .target code { color: #38414a; font-size: 12px; }
    .badge {
      border: 1px solid #bac2ca;
      border-radius: 999px;
      color: #38414a;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 8px;
      text-transform: uppercase;
    }
    .badge.online { background: #e4f4ea; border-color: #9ad2ad; color: #22653b; }
    .badge.offline { background: #f7e6e4; border-color: #d9a29a; color: #96382e; }
    button {
      align-items: center;
      background: #ffffff;
      border: 1px solid #b7bec7;
      border-radius: 6px;
      color: #202124;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-weight: 650;
      min-height: 38px;
      padding: 8px 12px;
    }
    button.primary { background: #256f86; border-color: #256f86; color: #fff; }
    button.danger { border-color: #b64c40; color: #9b2f24; }
    table {
      background: #fff;
      border: 1px solid #d5d8dc;
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border-bottom: 1px solid #e1e4e8;
      font-size: 14px;
      padding: 10px;
      text-align: left;
      vertical-align: middle;
    }
    th { background: #eef0f1; color: #38414a; font-size: 12px; text-transform: uppercase; }
    input {
      border: 1px solid #bac2ca;
      border-radius: 4px;
      font: inherit;
      min-height: 36px;
      padding: 7px 8px;
      width: 100%;
    }
    input[type="checkbox"] { min-height: 18px; width: 18px; }
    .voice { font-weight: 700; white-space: nowrap; }
    .actions { display: flex; gap: 8px; }
    select {
      border: 1px solid #bac2ca;
      border-radius: 4px;
      font: inherit;
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
    }
  </style>
</head>
<body>
  <header>
    <h1>Shadowscore Lab Admin</h1>
    <div class="status" id="status">Loading score...</div>
  </header>
  <main>
    <div class="toolbar">
      <button class="primary" id="refresh" type="button">Refresh</button>
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
            <input id="restore-file" type="file" accept="application/json,.json" hidden>
          </div>
          <div class="hint" id="session-hint"></div>
        </div>
        <img class="qr" id="qr-code" alt="Matrix Edit QR code">
      </div>
    </section>
    <section class="targets">
      <h2>Discovered RNBO targets</h2>
      <div class="target-list" id="targets"></div>
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
          <th>Voice</th>
          <th>RNBO Target</th>
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
    const hardwareUnitsEl = document.querySelector("#hardware-units");
    const shareUrlEl = document.querySelector("#share-url");
    const qrCodeEl = document.querySelector("#qr-code");
    const sessionHintEl = document.querySelector("#session-hint");
    const assignmentPresetEl = document.querySelector("#assignment-preset");
    const restoreFileEl = document.querySelector("#restore-file");
    const newVoiceIdEl = document.querySelector("#new-voice-id");
    const inputs = new Map();
    let discoveredTargets = [];
    let hardwareUnits = [];

    document.querySelector("#refresh").addEventListener("click", loadSession);
    document.querySelector("#clear-notes").addEventListener("click", () => resetScore({ voices: true }, "Clear all notes?"));
    document.querySelector("#clear-assignments").addEventListener("click", () => resetScore({ assignments: true }, "Clear all voice assignments?"));
    document.querySelector("#copy-url").addEventListener("click", copyShareUrl);
    document.querySelector("#apply-preset").addEventListener("click", applyAssignmentPreset);
    document.querySelector("#download-backup").addEventListener("click", () => { window.location.href = "/admin/backup"; });
    document.querySelector("#restore-backup").addEventListener("click", () => restoreFileEl.click());
    document.querySelector("#add-voice").addEventListener("click", addVoice);
    restoreFileEl.addEventListener("change", restoreBackup);

    loadSession();
    const events = new EventSource("/events");
    events.addEventListener("snapshot", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.replaced", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.cleared", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.preset.applied", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.added", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.removed", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.reset", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.restore", (event) => render(JSON.parse(event.data).score));
    events.onerror = () => setStatus("Event stream reconnecting...");

    async function loadSession() {
      const response = await fetch("/session");
      const session = await response.json();
      discoveredTargets = session.rnbo?.targets ?? [];
      hardwareUnits = session.hardwareUnits ?? [];
      renderSessionTools(session);
      renderTargets(discoveredTargets);
      renderHardwareUnits(hardwareUnits);
      const scoreResponse = await fetch("/score");
      render(await scoreResponse.json());
    }

    function render(score) {
      inputs.clear();
      voicesEl.textContent = "";
      for (const voiceId of Object.keys(score.voices)) {
        const assignment = score.assignments?.[voiceId] ?? {};
        const row = document.createElement("tr");
        row.dataset.voice = voiceId;
        row.append(cell("Voice", voiceId, "voice"));
        row.append(targetCell("RNBO Target", voiceId, assignment));
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
        const label = document.createElement("div");
        label.textContent = displayTargetLabel(target);
        const code = document.createElement("code");
        code.textContent = target.host + ":" + target.port + target.address;
        row.append(label, code, statusBadge(target.available === false ? "offline" : "online"));
        targetsEl.append(row);
      }
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
        const label = document.createElement("div");
        label.textContent = (unit.advertisedName ?? unit.id) + (unit.local ? " · local host" : "");
        const detail = document.createElement("code");
        detail.textContent = unit.id + " · targets " + (unit.targets?.length ?? 0);
        row.append(label, detail, statusBadge(unit.status ?? "offline"));
        hardwareUnitsEl.append(row);
      }
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

    function targetCell(label, voiceId, assignment) {
      const select = document.createElement("select");
      select.dataset.voice = voiceId;
      select.dataset.field = "rnboTargetId";
      const current = assignment.rnboTargetId ?? "";
      select.append(new Option("Unassigned", ""));
      for (const target of discoveredTargets) {
        const prefix = target.hardwareUnitName ? target.hardwareUnitName + " / " : "";
        const suffix = target.available === false ? " · offline" : "";
        const option = new Option(prefix + friendlyTargetName(target) + suffix, target.id);
        option.disabled = target.available === false;
        option.dataset.target = JSON.stringify(target);
        select.append(option);
      }
      select.value = current;
      rememberInput(voiceId, "rnboTargetId", select);
      const td = document.createElement("td");
      td.dataset.label = label;
      td.append(select);
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
      render(await response.json());
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
