export function transportPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shadowscore Transport</title>
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
    main { margin: 0 auto; max-width: 1120px; padding: 22px clamp(16px, 4vw, 40px) 40px; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
      max-width: 100%;
      min-width: 0;
    }
    details.toolbar-details { margin-bottom: 18px; }
    details.toolbar-details summary {
      color: var(--ss-muted);
      cursor: pointer;
      font-weight: 700;
      margin-bottom: 10px;
    }
    button {
      max-width: 100%;
      min-height: 38px;
      white-space: normal;
    }
    section {
      margin-bottom: 16px;
      padding: 14px;
    }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    }
    .metric {
      background: rgba(38, 51, 65, 0.54);
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-control);
      min-height: 72px;
      padding: 10px;
    }
    .label {
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .value {
      font-size: 20px;
      font-weight: 750;
      overflow-wrap: anywhere;
    }
    .value.small { font-size: 15px; font-weight: 650; }
    .detail {
      font-size: 13px;
      margin-top: 6px;
    }
    .log {
      background: #0c1218;
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-control);
      color: #d8e8ef;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      min-height: 72px;
      overflow-wrap: anywhere;
      padding: 10px;
      white-space: pre-wrap;
    }
    .contract-list {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
    .contract-card {
      background: rgba(38, 51, 65, 0.54);
      border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-control);
      padding: 10px;
    }
    .contract-card.warn {
      border-color: #d79c36;
      box-shadow: inset 0 0 0 1px rgba(215, 156, 54, 0.35);
    }
    .contract-title {
      font-size: 15px;
      font-weight: 750;
      margin-bottom: 8px;
      overflow-wrap: anywhere;
    }
    .contract-facts {
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .contract-fact {
      min-width: 0;
    }
    .contract-fact .label {
      margin-bottom: 2px;
    }
    .contract-fact .value {
      font-size: 15px;
      font-weight: 650;
    }
    @media (max-width: 900px) {
      .toolbar button { flex: 1 1 150px; }
    }
    @media (max-width: 700px) {
      header { align-items: flex-start; flex-direction: column; }
      .toolbar button { flex: 1 1 160px; justify-content: center; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Shadowscore Transport</h1>
    <div class="status" id="status">Loading...</div>
  </header>
  <nav class="ss-route-tabs" aria-label="ShadowScore routes">
    <a href="/">Dashboard</a>
    <a href="/structure-editor">Structure</a>
    <a href="/matrix-edit">Matrix</a>
    <a href="/piano-roll">Piano Roll</a>
    <a href="/event-list">Event List</a>
    <a href="/admin">Admin</a>
    <a href="/transport/status" aria-current="page">Transport</a>
  </nav>
  <main>
    <div class="toolbar">
      <button class="primary" id="play" type="button">Play</button>
      <button class="danger" id="stop" type="button">Stop</button>
      <button id="reset" type="button">Return to A</button>
      <button id="advance" type="button">Next Section</button>
      <button id="reanchor" type="button">Re-sync</button>
    </div>
    <details class="toolbar-details">
      <summary>Diagnostics controls</summary>
      <div class="toolbar">
        <button id="start-jack" type="button">Start Beat-Derived Playback</button>
        <button id="start-timer" type="button">Start Internal Clock</button>
        <button id="jack-start" type="button">Start JACK Transport</button>
        <button id="jack-stop" type="button">Stop JACK Transport</button>
        <button id="jack-locate" type="button">Locate JACK 0</button>
      </div>
    </details>
    <section>
      <h2>Transport</h2>
      <div class="grid">
        <div class="metric"><div class="label">State</div><div class="value" id="macro-mode">-</div></div>
        <div class="metric"><div class="label">Section</div><div class="value" id="active-block">-</div></div>
        <div class="metric"><div class="label">Next Section In</div><div class="value" id="beats-remaining">-</div></div>
        <div class="metric"><div class="label">Bridge</div><div class="value" id="bridge-status">-</div><div class="detail" id="bridge-detail"></div></div>
        <div class="metric"><div class="label">Sync Source</div><div class="value small" id="beat-witness">-</div><div class="detail" id="beat-witness-detail"></div></div>
        <div class="metric"><div class="label">BPM</div><div class="value" id="bpm">-</div></div>
      </div>
    </section>
    <details class="toolbar-details">
      <summary>Transport diagnostics</summary>
      <section>
      <h2>JACK</h2>
      <div class="grid">
        <div class="metric"><div class="label">JACK State</div><div class="value" id="jack-state">-</div></div>
        <div class="metric"><div class="label">Absolute Beat</div><div class="value" id="absolute-beat">-</div></div>
        <div class="metric"><div class="label">BBT</div><div class="value small" id="bbt">-</div></div>
        <div class="metric"><div class="label">Tempo Authority</div><div class="value" id="tempo-authority">-</div></div>
      </div>
      </section>
      <section>
      <h2>Song Form</h2>
      <div class="grid">
        <div class="metric"><div class="label">Macro Index</div><div class="value" id="macro-index">-</div></div>
        <div class="metric"><div class="label">Composition Beat</div><div class="value" id="composition-beat">-</div></div>
        <div class="metric"><div class="label">Beat In Block</div><div class="value" id="beat-into-block">-</div></div>
        <div class="metric"><div class="label">Block Start Beat</div><div class="value" id="block-start">-</div></div>
        <div class="metric"><div class="label">Next Block Beat</div><div class="value" id="block-end">-</div></div>
        <div class="metric"><div class="label">Macro Anchor</div><div class="value small" id="macro-anchor">-</div></div>
        <div class="metric"><div class="label">Phase Reset</div><div class="value small" id="phase-reset">-</div></div>
      </div>
      </section>
      <section>
      <h2>Timing Contract</h2>
      <div class="contract-list" id="timing-contracts"></div>
      </section>
    </details>
    <section>
      <h2>Events</h2>
      <div class="log" id="log"></div>
    </section>
  </main>
  <script>
    const fields = Object.fromEntries(Array.from(document.querySelectorAll("[id]")).map((el) => [el.id, el]));
    let lastTransport = null;

    fields.play.addEventListener("click", () => startPlayback("auto"));
    fields["start-jack"].addEventListener("click", () => startPlayback("jack"));
    fields["start-timer"].addEventListener("click", () => startPlayback("timer"));
    fields.reanchor.addEventListener("click", () => startPlayback("jack", { phaseReset: true }));
    fields.stop.addEventListener("click", stopPlayback);
    fields.advance.addEventListener("click", () => postJson("/macrostructure/advance", {}));
    fields.reset.addEventListener("click", resetToA);
    fields["jack-start"].addEventListener("click", () => postJson("/transport/jack/start", {}));
    fields["jack-stop"].addEventListener("click", () => postJson("/transport/jack/stop", {}));
    fields["jack-locate"].addEventListener("click", () => postJson("/transport/jack/locate", { frame: 0 }));

    refreshAll();
    setInterval(refreshAll, 1000);

    const transportEvents = new EventSource("/transport/events");
    transportEvents.addEventListener("snapshot", (event) => {
      const payload = JSON.parse(event.data);
      lastTransport = payload.transport;
      renderTransport(lastTransport);
      log("transport " + lastTransport.status + " " + formatNumber(lastTransport.latest?.absoluteBeat, 3));
    });
    transportEvents.onerror = () => log("transport events disconnected");

    async function refreshAll() {
      try {
        const [transport, playback, contracts] = await Promise.all([
          fetchJson("/transport"),
          fetchJson("/macrostructure/playback"),
          fetchJson("/playback/timing-contracts")
        ]);
        lastTransport = transport;
        renderTransport(transport);
        renderPlayback(playback);
        renderContracts(contracts.contracts || []);
        fields.status.textContent = new Date().toLocaleTimeString();
      } catch (error) {
        fields.status.textContent = String(error.message || error);
      }
    }

    async function startPlayback(mode, options = {}) {
      await postJson("/transport/play", { mode, ...options });
      await refreshAll();
    }

    async function stopPlayback() {
      await postJson("/transport/stop", {});
      await refreshAll();
    }

    async function resetToA() {
      await postJson("/macrostructure/reset", {});
      await postJson("/macrostructure/phase-reset", {});
      await refreshAll();
    }

    async function fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      log(url + " ok");
      return payload;
    }

    function renderTransport(transport) {
      const latest = transport.latest || {};
      fields["bridge-status"].textContent = transport.status || "unusable";
      fields["bridge-status"].className = "value " + (transport.fresh ? "ok" : transport.status === "stale" ? "warn" : "bad");
      fields["bridge-detail"].textContent = transport.reason || (Number.isFinite(transport.ageMs) ? transport.ageMs + " ms old" : "");
      fields["jack-state"].textContent = latest.state || "-";
      fields.bpm.textContent = formatNumber(latest.beatsPerMinute, 2);
      fields["absolute-beat"].textContent = formatNumber(latest.absoluteBeat, 3);
      fields.bbt.textContent = latest.bbtValid ? [latest.bar, latest.beat, formatNumber(latest.tick, 0)].join(":") : "-";
      fields["tempo-authority"].textContent = transport.tempoAuthority || "-";
    }

    function renderPlayback(playback) {
      fields["macro-mode"].textContent = playback.running ? "playing" : "stopped";
      fields["beat-witness"].textContent = witnessLabel(playback.witness);
      fields["beat-witness"].className = "value small " + (playback.witness?.usable ? "ok" : playback.witness?.degraded ? "warn" : "bad");
      fields["beat-witness-detail"].textContent = witnessDetail(playback.witness);
      fields["active-block"].textContent = playback.activeBlockId || "-";
      fields["macro-index"].textContent = String(playback.macroIndex ?? "-");
      fields["composition-beat"].textContent = formatNumber(playback.compositionBeat, 3);
      fields["beat-into-block"].textContent = formatNumber(playback.beatIntoBlock, 3);
      fields["block-start"].textContent = formatNumber(playback.activeBlockStartBeat, 3);
      fields["block-end"].textContent = formatNumber(playback.activeBlockEndBeat, 3);
      fields["macro-anchor"].textContent = macroAnchorLabel(playback);
      fields["beats-remaining"].textContent = playback.running && Number.isFinite(playback.beatsRemaining)
        ? formatNumber(playback.beatsRemaining, 2) + " beats"
        : "-";
      fields["phase-reset"].textContent = playback.phaseAlignment?.pending ? "pending" : phaseAlignmentLabel(playback.phaseAlignment?.last);
    }

    function renderContracts(contracts) {
      if (!contracts.length) {
        const empty = document.createElement("div");
        empty.className = "metric";
        empty.textContent = "No playback clients.";
        fields["timing-contracts"].replaceChildren(empty);
        return;
      }
      const disagreements = timingDisagreements(contracts);
      fields["timing-contracts"].replaceChildren(...contracts.map((contract) => contractCard(contract, disagreements)));
    }

    function contractCard(contract, disagreements) {
      const timing = contract.timing || {};
      const card = document.createElement("article");
      card.className = "contract-card" + (contractHasDisagreement(contract, disagreements) ? " warn" : "");
      const title = document.createElement("div");
      title.className = "contract-title";
      title.textContent = contract.targetId || "-";
      const facts = document.createElement("div");
      facts.className = "contract-facts";
      facts.append(
        contractFact("Voice", contract.assignedVoiceId || "-"),
        contractFact("Block", timing.blockId || "-"),
        contractFact("Stages / Beat", timing.stagesPerBeat ?? "-"),
        contractFact("Ticks / Stage", timing.ticksPerStage ?? "-"),
        contractFact("Pattern", timing.patternLength ?? "-"),
        contractFact("Notes", contract.noteCount ?? "-"),
        contractFact("Available", contract.available === false ? "no" : "yes"),
        contractFact("Rows", contract.transmittedRowCount ?? "-")
      );
      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = disagreementLabel(contract, disagreements);
      card.append(title, facts, detail);
      return card;
    }

    function contractFact(label, value) {
      const item = document.createElement("div");
      item.className = "contract-fact";
      const labelEl = document.createElement("div");
      labelEl.className = "label";
      labelEl.textContent = label;
      const valueEl = document.createElement("div");
      valueEl.className = "value";
      valueEl.textContent = String(value);
      item.append(labelEl, valueEl);
      return item;
    }

    function timingDisagreements(contracts) {
      const assigned = contracts.filter((contract) => contract.assignedVoiceId && contract.available !== false);
      const comparable = assigned.length > 1 ? assigned : contracts.filter((contract) => contract.available !== false);
      const fields = ["blockId", "stagesPerBeat", "ticksPerStage", "patternLength"];
      return Object.fromEntries(fields.map((field) => {
        const values = new Set(comparable.map((contract) => String(contract.timing?.[field] ?? "")));
        return [field, comparable.length > 1 && values.size > 1];
      }));
    }

    function contractHasDisagreement(contract, disagreements) {
      return Object.keys(disagreements).some((field) => disagreements[field] && contract.timing?.[field] !== undefined);
    }

    function disagreementLabel(contract, disagreements) {
      const fields = Object.keys(disagreements).filter((field) => disagreements[field] && contract.timing?.[field] !== undefined);
      return fields.length ? "Disagrees on " + fields.join(", ") : "";
    }

    function formatNumber(value, digits) {
      return Number.isFinite(value) ? Number(value).toFixed(digits) : "-";
    }

    function phaseAlignmentLabel(last) {
      if (!last) return "-";
      return last.ok ? "SetStage " + last.value + " / " + last.writeCount + " writes" : "failed";
    }

    function witnessLabel(witness) {
      if (!witness) return "-";
      return witness.usable ? witness.source : witness.source + " unavailable";
    }

    function witnessDetail(witness) {
      if (!witness) return "";
      const parts = [];
      if (Number.isFinite(witness.absoluteBeat)) parts.push("beat " + formatNumber(witness.absoluteBeat, 3));
      if (witness.targetId) parts.push(witness.targetId);
      if (Number.isFinite(witness.skewBeats)) parts.push("skew " + formatNumber(witness.skewBeats, 3));
      if (witness.reason) parts.push(witness.reason);
      return parts.join(" / ");
    }

    function macroAnchorLabel(playback) {
      if (!Number.isFinite(playback.macroStartBeat)) return "-";
      return "beat " + formatNumber(playback.macroStartBeat, 3) + " / index " + String(playback.macroStartIndex ?? 0);
    }

    function log(message) {
      const line = new Date().toLocaleTimeString() + " " + message;
      fields.log.textContent = [line, ...fields.log.textContent.split("\\n").filter(Boolean)].slice(0, 8).join("\\n");
    }
  </script>
</body>
</html>`;
}
