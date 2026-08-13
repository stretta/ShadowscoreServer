import fs from "node:fs";

const catalogDocument = JSON.parse(fs.readFileSync(new URL("./scales.json", import.meta.url), "utf8"));

export const TTID_MIN = 0;
export const TTID_MAX = 0xFFF;
export const DEFAULT_SCALE = Object.freeze({
  root_note: 0,
  scale_intervals: Object.freeze([...catalogDocument.ionian]),
  scale_name: "Ionian"
});
export const DEFAULT_TTID = 2741;

export function scaleCatalog() {
  return structuredClone(catalogDocument);
}

export function normalizeTtid(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < TTID_MIN || number > TTID_MAX) {
    throw new Error(`TTID must be an integer from ${TTID_MIN} through ${TTID_MAX}`);
  }
  return number;
}

export function normalizeScale(document, options = {}) {
  if (!isPlainObject(document)) throw new Error("scale must be an object");
  const root = Number(document.root_note);
  if (!Number.isInteger(root) || root < 0 || root > 11) {
    throw new Error("scale root_note must be an integer from 0 through 11");
  }
  const catalogName = resolveCatalogName(document.scale_name);
  const supplied = document.scale_intervals;
  const intervals = supplied === undefined
    ? catalogDocument[catalogName]
    : normalizeIntervals(supplied);
  if (!intervals) throw new Error(`unknown canonical scale '${document.scale_name}'`);
  if (catalogName && !sameArray(intervals, catalogDocument[catalogName])) {
    throw new Error(`scale_intervals do not match canonical scale '${document.scale_name}'`);
  }
  const name = cleanString(document.scale_name) || options.defaultName || "Custom";
  return { root_note: root, scale_intervals: [...intervals], scale_name: displayName(name) };
}

export function scaleToPitchClasses(scale) {
  const normalized = normalizeScale(scale);
  return Array.from(new Set(normalized.scale_intervals.map((interval) => (normalized.root_note + interval) % 12))).sort((a, b) => a - b);
}

export function pitchClassesToTtid(pitchClasses) {
  return normalizeIntervals(pitchClasses).reduce((mask, pitchClass) => mask | (1 << pitchClass), 0);
}

export function ttidToPitchClasses(value) {
  const ttid = normalizeTtid(value);
  return Array.from({ length: 12 }, (_, pitchClass) => pitchClass)
    .filter((pitchClass) => (ttid & (1 << pitchClass)) !== 0);
}

export function quantizePitchToTtid(pitch, value) {
  const pitchClasses = ttidToPitchClasses(value);
  const original = Math.max(0, Math.min(127, Math.round(Number(pitch) || 0)));
  if (!pitchClasses.length) return original;
  for (let distance = 0; distance <= 127; distance += 1) {
    const lower = original - distance;
    if (lower >= 0 && pitchClasses.includes(lower % 12)) return lower;
    const upper = original + distance;
    if (distance > 0 && upper <= 127 && pitchClasses.includes(upper % 12)) return upper;
  }
  return original;
}

export function scaleToTtid(scale) {
  return pitchClassesToTtid(scaleToPitchClasses(scale));
}

export function reinterpretPitch(pitch, sourceScale, targetScale, centerPitch = 60) {
  const sourceMap = buildPitchMap(sourceScale);
  const targetMap = buildPitchMap(targetScale);
  const fromIndex = nearestPitchIndex(sourceMap, Number(pitch));
  const scalarOffset = fromIndex - nearestPitchIndex(sourceMap, centerPitch);
  const targetIndex = nearestPitchIndex(targetMap, centerPitch) + scalarOffset;
  return targetMap[Math.max(0, Math.min(targetMap.length - 1, targetIndex))] ?? Number(pitch);
}

export function buildPitchMap(scale) {
  const pitchClasses = new Set(scaleToPitchClasses(scale));
  const pitches = [];
  for (let pitch = 0; pitch <= 127; pitch += 1) {
    if (pitchClasses.has(pitch % 12)) pitches.push(pitch);
  }
  return pitches.length ? pitches : [normalizeScale(scale).root_note];
}

function nearestPitchIndex(pitchMap, pitch) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  pitchMap.forEach((candidate, index) => {
    const distance = Math.abs(candidate - pitch);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}

function normalizeIntervals(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("scale_intervals must be a non-empty array");
  const intervals = value.map(Number);
  if (intervals.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 11)) {
    throw new Error("scale_intervals must contain pitch classes from 0 through 11");
  }
  return Array.from(new Set(intervals)).sort((a, b) => a - b);
}

function resolveCatalogName(value) {
  const token = cleanString(value).toLowerCase().replace(/\s+/g, "-");
  return Object.hasOwn(catalogDocument, token) ? token : "";
}

function displayName(value) {
  return cleanString(value).split(/[-\s]+/).map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : "").join(" ");
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cleanString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
