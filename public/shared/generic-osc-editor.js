export function genericOscEditorGroups(targets = [], specializedApps = []) {
  const covered = new Set([...specializedApps].map(cleanToken).filter(Boolean));
  const groups = new Map();
  for (const target of targets) {
    const app = cleanToken(target?.app);
    if (!app || covered.has(app) || target?.status !== "online" || target?.sendable === false) continue;
    if (!Array.isArray(target.parameters) || target.parameters.length === 0) continue;
    const signature = targetParameterSignature(target);
    const key = `${app}:${signature}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        app,
        signature,
        label: exportLabel(target),
        route: `/editors/generic?app=${encodeURIComponent(app)}&signature=${encodeURIComponent(signature)}`,
        targets: []
      });
    }
    groups.get(key).targets.push(target);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, targets: group.targets.sort(compareTargets) }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.signature.localeCompare(right.signature));
}

export function targetParameterSignature(target = {}) {
  const document = (target.parameters ?? []).map((param) => ({
    key: parameterKey(param),
    path: stringField(param?.path) || parameterKey(param),
    type: stringField(param?.type),
    min: finiteOrNull(param?.min),
    max: finiteOrNull(param?.max),
    values: Array.isArray(param?.values) ? param.values.map(String) : []
  })).sort((left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
  return `v1-${fnv1a(JSON.stringify(document))}`;
}

export function genericControlModel(param = {}) {
  const key = parameterKey(param);
  const values = Array.isArray(param.values) ? param.values : [];
  const min = finiteOrNull(param.min);
  const max = finiteOrNull(param.max);
  const label = humanize(stringField(param?.meta?.label ?? param?.displayName) || param.name || key);
  const unit = stringField(param.unit ?? param?.meta?.unit);
  const model = { key, label, unit, value: param.value, param };
  if (isBooleanParam(param, values, min, max)) {
    const choices = values.length === 2 ? values : [0, 1];
    return { ...model, kind: "boolean", choices, value: booleanChoiceIndex(param.value, choices) };
  }
  if (values.length) return { ...model, kind: "enum", choices: values };
  if (min !== null && max !== null && max > min) {
    return { ...model, kind: "range", min, max, step: parameterStep(param, min, max), precision: parameterPrecision(param) };
  }
  if (isNumericParam(param)) return { ...model, kind: "number", step: positiveNumber(param?.meta?.edit_step) ?? "any", precision: parameterPrecision(param) };
  return { ...model, kind: "text" };
}

export function parameterKey(param = {}) {
  return stringField(param.key ?? param.name);
}

export function parameterGroup(param = {}) {
  const path = stringField(param.path);
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? humanize(parts.slice(0, -1).join(" / ")) : "Parameters";
}

export function exportLabel(target = {}) {
  const explicit = stringField(target.exportName);
  if (explicit) return explicit;
  const label = stringField(target.label).replace(/\s+\d+$/, "").trim();
  return label || humanize(target.app) || "Generic RNBO";
}

function isBooleanParam(param, values, min, max) {
  if (values.length === 2) {
    const normalized = values.map((value) => cleanToken(value));
    const pairs = [["off", "on"], ["false", "true"], ["no", "yes"], ["disabled", "enabled"]];
    if (pairs.some((pair) => pair.every((value, index) => normalized[index] === value))) return true;
  }
  return min === 0 && max === 1 && Number(param.steps) === 2;
}

function booleanChoiceIndex(value, choices) {
  const exact = choices.map(String).indexOf(String(value));
  if (exact >= 0) return exact;
  return Number(value) ? 1 : 0;
}

function isNumericParam(param) {
  return ["f", "i", "d"].includes(stringField(param.type).toLowerCase()) || Number.isFinite(Number(param.value));
}

function parameterStep(param, min, max) {
  const explicit = positiveNumber(param?.meta?.edit_step);
  if (explicit !== null) return explicit;
  const steps = Number(param.steps);
  if (Number.isFinite(steps) && steps > 1) return (max - min) / (steps - 1);
  if (stringField(param?.meta?.edit_as).toLowerCase() === "int" || parameterPrecision(param) === 0) return 1;
  const range = Math.abs(max - min);
  return range > 100 ? 1 : range > 10 ? 0.1 : 0.01;
}

function parameterPrecision(param) {
  const explicit = Number(param?.meta?.display_precision);
  return Number.isInteger(explicit) && explicit >= 0 && explicit <= 12 ? explicit : undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareTargets(left, right) {
  return stringField(left.label).localeCompare(stringField(right.label), undefined, { numeric: true, sensitivity: "base" });
}

function humanize(value) {
  return stringField(value)
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
