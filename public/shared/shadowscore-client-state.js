export function createShadowScoreClientState({ serverUrl = "" } = {}) {
  const listeners = new Set();
  const drafts = new Map();
  let normalizedServerUrl = normalizeServerUrl(serverUrl);
  let eventSource;
  let session;
  let score;
  let structure;
  let lastEvent;

  function notify(reason = "changed") {
    const snapshotValue = snapshot();
    for (const listener of listeners) {
      listener(snapshotValue, reason);
    }
  }

  function adoptServerScore(nextScore, event = {}) {
    if (!nextScore) {
      return snapshot();
    }
    const previous = score;
    score = clone(nextScore);
    structure = score?.mesostructure ?? structure;
    lastEvent = event;
    markDraftConflicts(previous, score, event);
    notify("score");
    return snapshot();
  }

  function draftBase() {
    return {
      baseScoreRevision: revision(score, "scoreRevision"),
      baseStructureRevision: revision(score, "structureRevision")
    };
  }

  function markDraftConflicts(previousScore, nextScore, event = {}) {
    if (!nextScore) {
      return;
    }
    const scoreRevision = revision(nextScore, "scoreRevision");
    const structureRevision = revision(nextScore, "structureRevision");
    for (const [key, draft] of drafts) {
      const resourceChanged = eventTouchesResource(event, key, previousScore, nextScore);
      const dependencyChanged = eventTouchesDependency(event, key);
      if (resourceChanged && scoreRevision > draft.baseScoreRevision) {
        draft.conflict = true;
      }
      if (dependencyChanged && structureRevision > draft.baseStructureRevision) {
        draft.staleDependencies = [...new Set([...(draft.staleDependencies ?? []), event.type])];
      }
    }
  }

  const api = {
    setServerUrl(nextServerUrl) {
      normalizedServerUrl = normalizeServerUrl(nextServerUrl);
    },
    serverUrl() {
      return normalizedServerUrl;
    },
    async load(nextServerUrl = normalizedServerUrl) {
      normalizedServerUrl = normalizeServerUrl(nextServerUrl);
      if (!normalizedServerUrl) {
        throw new Error("serverUrl is required");
      }
      const [nextSession, nextScore] = await Promise.all([
        fetchJson(`${normalizedServerUrl}/session`),
        fetchJson(`${normalizedServerUrl}/score`)
      ]);
      session = nextSession;
      score = nextScore;
      structure = score?.mesostructure ?? {};
      markDraftConflicts(undefined, score, { type: "load" });
      notify("load");
      return snapshot();
    },
    connectEvents() {
      if (!normalizedServerUrl) {
        throw new Error("serverUrl is required");
      }
      api.close();
      eventSource = new EventSource(`${normalizedServerUrl}/events`);
      const handleEvent = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.score) {
          adoptServerScore(payload.score, { type: event.type, detail: payload.detail ?? {} });
        }
      };
      [
        "snapshot",
        "context.updated",
        "voice.notes.replaced",
        "voice.assignment.replaced",
        "voice.assignment.cleared",
        "voice.assignment.preset.applied",
        "clip.added",
        "clip.replaced",
        "clip.renamed",
        "clip.removed",
        "mesostructure.block.replaced",
        "mesostructure.block.removed",
        "macrostructure.updated",
        "structure.playhead.updated",
        "admin.reset",
        "admin.restore",
        "admin.score.created"
      ].forEach((type) => eventSource.addEventListener(type, handleEvent));
      return eventSource;
    },
    close() {
      eventSource?.close();
      eventSource = undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    effectiveScore,
    beginDraft(key, value) {
      const base = draftBase();
      drafts.set(key, {
        key,
        value: clone(value),
        ...base,
        dirty: true,
        conflict: false,
        staleDependencies: []
      });
      notify("draft");
      return api.draft(key);
    },
    updateDraft(key, value) {
      const existing = drafts.get(key);
      if (!existing) {
        return api.beginDraft(key, value);
      }
      drafts.set(key, {
        ...existing,
        value: clone(value),
        dirty: true
      });
      notify("draft");
      return api.draft(key);
    },
    revertDraft(key) {
      drafts.delete(key);
      notify("draft");
    },
    draft(key) {
      const draft = drafts.get(key);
      return draft ? clone(draft) : undefined;
    },
    drafts() {
      return [...drafts.values()].map(clone);
    },
    adoptServerScore,
    async saveDraft(key, { path, method = "POST", body, includeRevision = true } = {}) {
      const draft = drafts.get(key);
      if (!draft) {
        throw new Error(`no draft for ${key}`);
      }
      if (!path) {
        throw new Error("saveDraft path is required");
      }
      const payload = includeRevision
        ? {
            ...(body ?? draft.value),
            expectedVersion: draft.baseScoreRevision,
            expectedScoreRevision: draft.baseScoreRevision,
            expectedStructureRevision: draft.baseStructureRevision
          }
        : (body ?? draft.value);
      try {
        const nextScore = await fetchJson(`${normalizedServerUrl}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        drafts.delete(key);
        adoptServerScore(nextScore, { type: "save", detail: { key } });
        return nextScore;
      } catch (error) {
        if (isStaleError(error)) {
          const current = await fetchJson(`${normalizedServerUrl}/score`);
          const preserved = drafts.get(key);
          adoptServerScore(current, { type: "stale-save", detail: { key } });
          if (preserved) {
            drafts.set(key, { ...preserved, conflict: true });
          }
          notify("conflict");
        }
        throw error;
      }
    }
  };

  function snapshot() {
    return {
      serverUrl: normalizedServerUrl,
      session: clone(session),
      score: clone(score),
      structure: clone(structure),
      scoreRevision: revision(score, "scoreRevision"),
      structureRevision: revision(score, "structureRevision"),
      drafts: api.drafts(),
      lastEvent: clone(lastEvent)
    };
  }

  function effectiveScore() {
    const next = clone(score);
    if (!next) {
      return next;
    }
    for (const draft of drafts.values()) {
      applyDraft(next, draft);
    }
    return next;
  }

  return api;
}

function applyDraft(score, draft) {
  const [kind, id, facet] = draft.key.split(":");
  if (kind === "mesostructure" && id) {
    score.mesostructure = { ...(score.mesostructure ?? {}), [id]: clone(draft.value) };
    return;
  }
  if (kind === "macrostructure") {
    score.macrostructure = clone(draft.value);
    return;
  }
  if (kind === "context") {
    score.context = clone(draft.value);
    return;
  }
  if (kind === "structureState") {
    score.structureState = clone(draft.value);
    return;
  }
  if (kind === "clip" && id) {
    const current = score.clips?.[id] ?? {};
    const value = facet === "notes" ? { ...current, notes: clone(draft.value) } : clone(draft.value);
    score.clips = { ...(score.clips ?? {}), [id]: value };
  }
}

function eventTouchesResource(event, key, previousScore, nextScore) {
  if (event.type === "admin.reset" || event.type === "admin.restore" || event.type === "admin.score.created") {
    return true;
  }
  const [kind, id] = key.split(":");
  if (kind === "mesostructure") {
    return event.type?.startsWith("mesostructure.") && (!event.detail?.blockId || event.detail.blockId === id);
  }
  if (kind === "macrostructure") {
    return event.type === "macrostructure.updated";
  }
  if (kind === "clip") {
    return event.type?.startsWith("clip.") && (!event.detail?.clipId || event.detail.clipId === id || event.detail.oldClipId === id || event.detail.newClipId === id);
  }
  return JSON.stringify(previousScore?.[kind]) !== JSON.stringify(nextScore?.[kind]);
}

function eventTouchesDependency(event, key) {
  const [kind] = key.split(":");
  if (kind === "clip") {
    return event.type?.startsWith("mesostructure.") || event.type === "macrostructure.updated";
  }
  if (kind === "mesostructure") {
    return event.type === "clip.renamed" || event.type === "clip.removed";
  }
  return false;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}

async function responseError(response) {
  try {
    const payload = await response.clone().json();
    const error = new Error(payload?.error || `${response.status} ${response.statusText}`);
    error.payload = payload;
    return error;
  } catch {
    return new Error(`${response.status} ${response.statusText}`);
  }
}

function isStaleError(error) {
  return /stale .*revision|stale score version/.test(error?.message ?? "");
}

function normalizeServerUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function revision(score, field) {
  return Number.isFinite(score?.[field]) ? score[field] : Number.isFinite(score?.version) ? score.version : 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
