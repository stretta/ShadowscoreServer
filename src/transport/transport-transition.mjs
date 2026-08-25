const PHASES = Object.freeze({
  received: { state: "starting", label: "Play received" },
  discovering: { state: "starting", label: "Finding players" },
  preparing: { state: "starting", label: "Preparing players" },
  configuring: { state: "starting", label: "Setting playback" },
  synchronizing: { state: "synchronizing", label: "Synchronizing players" },
  verifying: { state: "verifying", label: "Checking sync" }
});

export function beginTransportTransition(runtime, options = {}) {
  const store = transitionStore(runtime);
  const now = transitionNow(runtime);
  const id = store.sequence + 1;
  store.sequence = id;
  store.active = {
    id,
    kind: options.kind === "resync" ? "resync" : "play",
    phase: "received",
    state: PHASES.received.state,
    label: options.kind === "resync" ? "Re-sync received" : PHASES.received.label,
    startedAtMs: now,
    phaseStartedAtMs: now,
    phases: []
  };
  return id;
}

export function updateTransportTransition(runtime, id, phase) {
  const store = transitionStore(runtime);
  const active = store.active;
  const description = PHASES[phase];
  if (!active || active.id !== id || !description || active.phase === phase) return false;
  const now = transitionNow(runtime);
  active.phases.push(completedPhase(active, now));
  active.phase = phase;
  active.state = description.state;
  active.label = description.label;
  active.phaseStartedAtMs = now;
  return true;
}

export function completeTransportTransition(runtime, id, options = {}) {
  const store = transitionStore(runtime);
  const active = store.active;
  if (!active || active.id !== id) return null;
  const now = transitionNow(runtime);
  const phases = [...active.phases, completedPhase(active, now)];
  store.last = {
    id: active.id,
    kind: active.kind,
    outcome: options.ok === false ? "failed" : "playing",
    started_at: new Date(active.startedAtMs).toISOString(),
    completed_at: new Date(now).toISOString(),
    elapsed_ms: Math.max(0, now - active.startedAtMs),
    phases,
    error: String(options.error ?? "")
  };
  store.active = null;
  return structuredClone(store.last);
}

export function transportTransitionSnapshot(runtime) {
  const store = transitionStore(runtime);
  const now = transitionNow(runtime);
  return {
    active: store.active ? activeSnapshot(store.active, now) : null,
    last: store.last ? structuredClone(store.last) : null
  };
}

function activeSnapshot(active, now) {
  return {
    id: active.id,
    kind: active.kind,
    state: active.state,
    phase: active.phase,
    label: active.label,
    started_at: new Date(active.startedAtMs).toISOString(),
    elapsed_ms: Math.max(0, now - active.startedAtMs),
    phases: structuredClone(active.phases)
  };
}

function completedPhase(active, now) {
  return {
    phase: active.phase,
    state: active.state,
    label: active.label,
    started_at: new Date(active.phaseStartedAtMs).toISOString(),
    elapsed_ms: Math.max(0, now - active.phaseStartedAtMs)
  };
}

function transitionStore(runtime) {
  if (!runtime.transportTransition) {
    runtime.transportTransition = { sequence: 0, active: null, last: null };
  }
  return runtime.transportTransition;
}

function transitionNow(runtime) {
  const value = Number(typeof runtime.now === "function" ? runtime.now() : NaN);
  return Number.isFinite(value) ? value : Date.now();
}
