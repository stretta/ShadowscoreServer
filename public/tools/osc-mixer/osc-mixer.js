const STANDARD_CONTROLS = Object.freeze([
  Object.freeze({ name: "OutputVolume", label: "Output", fallbackStep: 1 }),
  Object.freeze({ name: "HPFFreq", label: "High Pass", fallbackStep: 1 })
]);

const mixerEl = document.querySelector("#mixer");
const statusEl = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
const pendingSends = new Map();
let targets = [];

refreshButton.addEventListener("click", () => refresh().catch(reportError));
refresh().catch(reportError);

async function refresh() {
  refreshButton.disabled = true;
  setStatus("Discovering mixer channels...");
  const response = await fetch("/osc/targets?status=online", { cache: "no-store" });
  if (!response.ok) throw new Error(`Target discovery failed (${response.status})`);
  const body = await response.json();
  targets = (body.targets || [])
    .map(target => ({ ...target, mixerControls: controlsFor(target) }))
    .filter(target => target.mixerControls.length)
    .sort(compareTargets);
  render();
  setStatus(`${targets.length} mixer channel${targets.length === 1 ? "" : "s"}`);
  refreshButton.disabled = false;
}

function controlsFor(target) {
  return STANDARD_CONTROLS.flatMap(control => {
    const parameter = (target.parameters || []).find(candidate => parameterName(candidate) === control.name);
    return parameter ? [{ ...control, parameter }] : [];
  });
}

function render() {
  if (!targets.length) {
    mixerEl.innerHTML = `<div class="empty">No online RNBO exports expose <code>OutputVolume</code> or <code>HPFFreq</code>.</div>`;
    return;
  }
  mixerEl.replaceChildren(...targets.map(channelFor));
}

function channelFor(target) {
  const channel = document.createElement("article");
  channel.className = "channel";
  const heading = document.createElement("div");
  heading.className = "channel-head";
  heading.innerHTML = `<strong>${escapeHtml(target.label || target.id)}</strong><span class="detail">${escapeHtml(target.exportName || target.app || "RNBO")} · ${escapeHtml(target.deviceId || target.unitId || "")}</span>`;
  channel.append(heading, ...target.mixerControls.map(control => controlFor(target, control)));
  return channel;
}

function controlFor(target, control) {
  const parameter = control.parameter;
  const min = finite(parameter.min, 0);
  const max = finite(parameter.max, 1);
  const step = parameterStep(parameter, control.fallbackStep);
  const value = clamp(finite(parameter.value, min), min, max);
  const root = document.createElement("label");
  root.className = "control";
  root.innerHTML = `<span class="control-head"><span class="control-name">${escapeHtml(control.label)}</span><output>${escapeHtml(formatValue(value, parameter))}</output></span>`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", `${target.label || target.id} ${control.label}`);
  const output = root.querySelector("output");
  input.addEventListener("input", () => {
    output.textContent = formatValue(Number(input.value), parameter);
    scheduleSend(target, parameter, Number(input.value));
  });
  input.addEventListener("change", () => sendNow(target, parameter, Number(input.value), input).catch(reportError));
  root.append(input);
  return root;
}

function scheduleSend(target, parameter, value) {
  const key = `${target.id}:${parameterName(parameter)}`;
  clearTimeout(pendingSends.get(key));
  pendingSends.set(key, setTimeout(() => {
    pendingSends.delete(key);
    sendNow(target, parameter, value).catch(reportError);
  }, 45));
}

async function sendNow(target, parameter, value, input) {
  const response = await fetch("/osc/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: [target.id], param: parameterName(parameter), args: [value] })
  });
  const body = await response.json().catch(() => ({}));
  const result = body.results?.[0];
  if (!response.ok || body.ok === false || result?.ok === false) {
    input?.setAttribute("aria-invalid", "true");
    throw new Error(body.error || result?.error || `Send failed (${response.status})`);
  }
  input?.removeAttribute("aria-invalid");
  parameter.value = value;
  setStatus(`${target.label || target.id} · ${parameterName(parameter)} ${formatValue(value, parameter)}`);
}

function parameterName(parameter) { return String(parameter?.key || parameter?.name || "").split("/").at(-1); }
function parameterStep(parameter, fallback) {
  const configured = Number(parameter?.meta?.edit_step);
  if (configured > 0) return configured;
  const steps = Number(parameter?.steps);
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  if (steps > 1 && Number.isFinite(min) && Number.isFinite(max)) return (max - min) / (steps - 1);
  return fallback;
}
function formatValue(value, parameter) {
  const step = parameterStep(parameter, 1);
  const precision = step < 0.01 ? 2 : step < 1 ? 1 : 0;
  return `${Number(value).toFixed(precision)}${parameter.unit ? ` ${parameter.unit}` : ""}`;
}
function compareTargets(left, right) { return String(left.label || left.id).localeCompare(String(right.label || right.id), undefined, { numeric: true, sensitivity: "base" }); }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function setStatus(text) { statusEl.textContent = text; }
function reportError(error) { refreshButton.disabled = false; setStatus(error instanceof Error ? error.message : String(error)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
