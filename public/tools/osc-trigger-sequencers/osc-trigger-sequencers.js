const TARGETS_URL = "/osc/targets?capability=trigger-sequencer-edit&status=online";
const lanesEl = document.querySelector("#lanes");
const statusEl = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
let targets = [];
let pollTimer;
let pollGeneration = 0;

refreshButton.addEventListener("click", () => refresh().catch(reportError));
refresh().catch(reportError);

async function refresh() {
  refreshButton.disabled = true;
  setStatus("Discovering trigger-sequencer abstractions...");
  const response = await fetch(TARGETS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Target discovery failed (${response.status})`);
  const body = await response.json();
  targets = (body.targets || []).filter(target => triggerParameter(target)).sort(compareTargets);
  render();
  startStagePolling();
  setStatus(`${targets.length} trigger lane${targets.length === 1 ? "" : "s"}`);
  refreshButton.disabled = false;
}

function triggerParameter(target) {
  return (target.parameters || []).find(parameter => String(parameter?.meta?.editor || "").trim().toLowerCase() === "step16");
}

function lengthParameter(target) {
  return (target.parameters || []).find(parameter => /^(?:maxcnt|maxcount)$/i.test(String(parameter?.name || "")));
}

function render() {
  if (!targets.length) {
    lanesEl.innerHTML = `<div class="empty">No online RNBO parameters advertise <code>meta.editor: "step16"</code>.</div>`;
    return;
  }
  lanesEl.replaceChildren(...targets.map(laneFor));
}

function laneFor(target) {
  const pattern = triggerParameter(target);
  const length = lengthParameter(target);
  const maxCount = lengthValue(length);
  const mask = patternValue(pattern);
  const lane = document.createElement("article");
  lane.className = "lane";
  lane.dataset.targetId = target.id;

  const head = document.createElement("div");
  head.className = "lane-head";
  head.innerHTML = `<div class="lane-title"><strong>${escapeHtml(target.label || target.id)}</strong><span class="detail">${escapeHtml(target.exportName || target.app || "RNBO")} · ${escapeHtml(target.deviceId || target.unitId || "")} · <span data-pattern-value>0x${mask.toString(16).toUpperCase().padStart(4, "0")}</span></span></div>`;
  const meta = document.createElement("div");
  meta.className = "lane-meta";
  if (length) meta.append(lengthControl(target, length));
  head.append(meta);

  const wrap = document.createElement("div");
  wrap.className = "steps-wrap";
  const steps = document.createElement("div");
  steps.className = "steps";
  steps.replaceChildren(...Array.from({ length: 16 }, (_, index) => stepControl(target, pattern, index, mask, maxCount)));
  wrap.append(steps);
  lane.append(head, wrap);
  return lane;
}

function stepControl(target, parameter, index, mask, maxCount) {
  const step = document.createElement("label");
  step.className = `step${index + 1 > maxCount ? " unused" : ""}`;
  step.dataset.stage = String(index + 1);
  step.innerHTML = `<span class="step-number">${String(index + 1).padStart(2, "0")}</span>`;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(mask & (1 << index));
  input.setAttribute("aria-label", `${target.label || target.id} step ${index + 1}`);
  input.addEventListener("change", () => toggleStep(target, parameter, index, input).catch(reportError));
  step.append(input);
  return step;
}

function lengthControl(target, parameter) {
  const label = document.createElement("label");
  label.className = "length-control";
  label.innerHTML = `<span class="detail">Length</span>`;
  const select = document.createElement("select");
  const values = parameter.values?.length ? parameter.values.map(String) : Array.from({ length: 16 }, (_, index) => String(index + 1));
  select.replaceChildren(...values.map(value => optionFor(value)));
  select.value = String(parameter.value ?? values.at(-1));
  select.setAttribute("aria-label", `${target.label || target.id} pattern length`);
  select.addEventListener("change", () => setLength(target, parameter, select).catch(reportError));
  label.append(select);
  return label;
}

async function toggleStep(target, parameter, index, input) {
  const oldMask = patternValue(parameter);
  const newMask = input.checked ? (oldMask | (1 << index)) : (oldMask & ~(1 << index));
  try {
    await sendParameter(target, parameter, newMask >>> 0);
    parameter.value = newMask >>> 0;
    updatePatternReadout(target, newMask >>> 0);
  } catch (error) {
    input.checked = !input.checked;
    throw error;
  }
}

async function setLength(target, parameter, select) {
  const oldValue = parameter.value;
  try {
    await sendParameter(target, parameter, select.value);
    parameter.value = select.value;
    updateUnusedSteps(target);
  } catch (error) {
    select.value = String(oldValue);
    throw error;
  }
}

async function sendParameter(target, parameter, value) {
  const response = await fetch("/osc/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: [target.id], param: parameter.key || parameter.name, args: [wireValue(parameter, value)] })
  });
  const body = await response.json().catch(() => ({}));
  const result = body.results?.[0];
  if (!response.ok || body.ok === false || result?.ok === false) throw new Error(body.error || result?.error || `Send failed (${response.status})`);
  setStatus(`${target.label || target.id} updated`);
}

function wireValue(parameter, value) {
  if (parameter.type === "s") return String(value);
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function updatePatternReadout(target, mask) {
  const lane = laneElement(target);
  const output = lane?.querySelector("[data-pattern-value]");
  if (output) output.textContent = `0x${mask.toString(16).toUpperCase().padStart(4, "0")}`;
}

function updateUnusedSteps(target) {
  const count = lengthValue(lengthParameter(target));
  laneElement(target)?.querySelectorAll("[data-stage]").forEach(step => step.classList.toggle("unused", Number(step.dataset.stage) > count));
}

function startStagePolling() {
  clearTimeout(pollTimer);
  const generation = ++pollGeneration;
  if (targets.length) pollStages(generation);
}

async function pollStages(generation) {
  await Promise.all(targets.map(async target => {
    try {
      const host = isLoopback(target.host) ? location.hostname : target.host;
      const response = await fetch(`${location.protocol}//${host}:5678${target.baseAddress}/messages/out/current_stage`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      setPlayingStage(target, Number(Array.isArray(body.VALUE) ? body.VALUE[0] : body.VALUE));
    } catch {
      setPlayingStage(target);
    }
  }));
  if (generation === pollGeneration) pollTimer = setTimeout(() => pollStages(generation), 150);
}

function setPlayingStage(target, stageNumber) {
  laneElement(target)?.querySelectorAll("[data-stage]").forEach(step => step.classList.toggle("playing", Number(step.dataset.stage) === stageNumber));
}

function laneElement(target) { return Array.from(lanesEl.querySelectorAll("[data-target-id]")).find(lane => lane.dataset.targetId === target.id); }
function patternValue(parameter) { return Math.max(0, Math.min(65535, Math.round(Number(parameter?.value) || 0))); }
function lengthValue(parameter) {
  if (!parameter) return 16;
  const values = (parameter.values || []).map(String);
  const index = values.indexOf(String(parameter.value));
  return Math.max(1, Math.min(16, index >= 0 ? index + 1 : Number(parameter.value) || 16));
}
function optionFor(value) { const option = document.createElement("option"); option.value = value; option.textContent = value; return option; }
function compareTargets(left, right) { return String(left.label || left.id).localeCompare(String(right.label || right.id), undefined, { numeric: true, sensitivity: "base" }); }
function isLoopback(host) { return !host || host === "127.0.0.1" || host === "localhost" || host === "::1"; }
function setStatus(text) { statusEl.textContent = text; }
function reportError(error) { refreshButton.disabled = false; setStatus(error instanceof Error ? error.message : String(error)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
