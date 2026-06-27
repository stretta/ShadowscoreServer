import { EventEmitter } from "node:events";

const DEFAULT_FRESHNESS_MS = 500;
const JACK_STATES = new Set(["stopped", "rolling", "starting", "net-starting"]);

export function createJackTransportState(config = {}, options = {}) {
  const events = new EventEmitter();
  const now = options.now ?? Date.now;
  let latest = null;

  return {
    events,
    update(snapshot) {
      latest = normalizeJackSnapshot(snapshot, now());
      const transport = this.snapshot();
      events.emit("snapshot", {
        type: "snapshot",
        transport
      });
      return transport;
    },
    snapshot() {
      return transportSnapshot(latest, freshnessMs(config), now());
    }
  };
}

export function transportSnapshot(latest, thresholdMs, nowMs = Date.now()) {
  if (!latest) {
    return {
      source: "jack",
      latest: null,
      ageMs: null,
      freshnessThresholdMs: thresholdMs,
      fresh: false,
      stale: false,
      unusable: true,
      status: "unusable",
      reason: "no snapshot"
    };
  }

  const ageMs = Math.max(0, nowMs - latest.receivedAt);
  const stale = ageMs > thresholdMs;
  const bbtInvalid = latest.bbtValid !== true;
  const unusable = bbtInvalid;
  return {
    source: "jack",
    latest,
    ageMs,
    freshnessThresholdMs: thresholdMs,
    fresh: !stale && !bbtInvalid,
    stale,
    unusable,
    status: bbtInvalid ? "unusable" : stale ? "stale" : "fresh",
    reason: bbtInvalid ? "bbt invalid" : stale ? "snapshot stale" : ""
  };
}

export function normalizeJackSnapshot(snapshot, receivedAt) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("JACK snapshot must be an object");
  }

  const normalized = {
    source: stringField(snapshot.source, "source") || "jack",
    host: stringField(snapshot.host, "host"),
    state: stringField(snapshot.state, "state"),
    frame: finiteNumber(snapshot.frame, "frame"),
    frameRate: finiteNumber(snapshot.frameRate, "frameRate"),
    bbtValid: booleanField(snapshot.bbtValid, "bbtValid"),
    observedAt: optionalFiniteNumber(snapshot.observedAt, "observedAt"),
    receivedAt
  };

  if (normalized.source !== "jack") {
    throw new Error("JACK snapshot source must be 'jack'");
  }
  if (!JACK_STATES.has(normalized.state) && !normalized.state.startsWith("unknown-")) {
    throw new Error(`unsupported JACK transport state '${normalized.state}'`);
  }

  if (normalized.bbtValid) {
    normalized.bar = finiteNumber(snapshot.bar, "bar");
    normalized.beat = finiteNumber(snapshot.beat, "beat");
    normalized.tick = finiteNumber(snapshot.tick, "tick");
    normalized.ticksPerBeat = finiteNumber(snapshot.ticksPerBeat, "ticksPerBeat");
    normalized.beatsPerMinute = finiteNumber(snapshot.beatsPerMinute, "beatsPerMinute");
    normalized.absoluteBeat = finiteNumber(snapshot.absoluteBeat, "absoluteBeat");
    normalized.beatsPerBar = optionalFiniteNumber(snapshot.beatsPerBar, "beatsPerBar");
    normalized.beatType = optionalFiniteNumber(snapshot.beatType, "beatType");
  }

  return withoutUndefined(normalized);
}

function freshnessMs(config) {
  const configured = Number(config.transport?.jack?.freshnessMs);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_FRESHNESS_MS;
}

function stringField(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function booleanField(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a finite number`);
  }
  return number;
}

function optionalFiniteNumber(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return finiteNumber(value, field);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
