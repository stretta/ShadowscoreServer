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
    .targets {
      background: #fff;
      border: 1px solid #d5d8dc;
      margin-bottom: 18px;
      padding: 14px;
    }
    .targets h2 { font-size: 16px; margin: 0 0 10px; }
    .target-list { display: grid; gap: 8px; }
    .target {
      align-items: center;
      border: 1px solid #e1e4e8;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      padding: 9px;
    }
    .target code { color: #38414a; font-size: 12px; }
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
    <section class="targets">
      <h2>Discovered RNBO targets</h2>
      <div class="target-list" id="targets"></div>
    </section>
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
    const inputs = new Map();
    let discoveredTargets = [];

    document.querySelector("#refresh").addEventListener("click", loadSession);
    document.querySelector("#clear-notes").addEventListener("click", () => resetScore({ voices: true }, "Clear all notes?"));
    document.querySelector("#clear-assignments").addEventListener("click", () => resetScore({ assignments: true }, "Clear all voice assignments?"));

    loadSession();
    const events = new EventSource("/events");
    events.addEventListener("snapshot", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.replaced", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("voice.assignment.cleared", (event) => render(JSON.parse(event.data).score));
    events.addEventListener("admin.reset", (event) => render(JSON.parse(event.data).score));
    events.onerror = () => setStatus("Event stream reconnecting...");

    async function loadSession() {
      const response = await fetch("/session");
      const session = await response.json();
      discoveredTargets = session.rnbo?.targets ?? [];
      renderTargets(discoveredTargets);
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
        label.textContent = target.name ?? target.id ?? target.address;
        const code = document.createElement("code");
        code.textContent = target.host + ":" + target.port + target.address;
        row.append(label, code);
        targetsEl.append(row);
      }
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
        const option = new Option(target.name + " · " + target.address, target.id);
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

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(save, clear);

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

    async function clearAssignment(voiceId) {
      const response = await fetch("/voices/" + encodeURIComponent(voiceId) + "/assignment", { method: "DELETE" });
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
