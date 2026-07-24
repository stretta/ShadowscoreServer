import { activeWrittenTempo, writtenTempoForBlock } from "./tempo.mjs";

export function createTempoPolicy(store, config = {}, options = {}) {
  const fallbackTempo = positiveTempo(config.rnbo?.transport?.Tempo, 120);
  const initialScore = store.getScore();
  let activeBlockId = activeBlockIdFor(initialScore);
  let entryKey = entryKeyFor(initialScore);
  let liveTempo = activeWrittenTempo(initialScore, fallbackTempo);
  let followBlockTempo = options.followBlockTempo !== false;
  let source = "block";
  let pendingApply = Promise.resolve(null);
  let lastApply = null;

  const onChange = (event) => {
    const score = event.score ?? store.getScore();
    const nextEntryKey = entryKeyFor(score);
    activeBlockId = activeBlockIdFor(score);
    if (nextEntryKey === entryKey) return;
    entryKey = nextEntryKey;
    if (!followBlockTempo) return;
    adoptTempo(writtenTempoForBlock(score, activeBlockId, fallbackTempo), "block", {
      apply: true,
      reason: "block-entry"
    });
  };
  store.events.on("change", onChange);

  return {
    snapshot() {
      const score = store.getScore();
      activeBlockId = activeBlockIdFor(score);
      return {
        live: liveTempo,
        written: writtenTempoForBlock(score, activeBlockId, fallbackTempo),
        followBlockTempo,
        source,
        activeBlockId
      };
    },
    setLiveTempo(value) {
      return adoptTempo(value, "manual", { apply: true, reason: "manual" });
    },
    observeExternalTempo(value) {
      return adoptTempo(value, "external", { apply: false, reason: "external" });
    },
    setFollowBlockTempo(value) {
      followBlockTempo = Boolean(value);
      if (!followBlockTempo && source === "block") source = "manual";
      return this.snapshot();
    },
    useBlockTempo() {
      const score = store.getScore();
      activeBlockId = activeBlockIdFor(score);
      return adoptTempo(
        writtenTempoForBlock(score, activeBlockId, fallbackTempo),
        "block",
        { apply: true, reason: "use-block-now", force: true }
      );
    },
    async flush() {
      await pendingApply;
      if (lastApply?.ok === false) throw new Error(lastApply.error);
      return this.snapshot();
    },
    lastApply() {
      return lastApply ? structuredClone(lastApply) : null;
    },
    close() {
      store.events.off("change", onChange);
    }
  };

  function adoptTempo(value, nextSource, { apply, reason, force = false }) {
    const tempo = requiredTempo(value);
    const changed = Math.abs(tempo - liveTempo) > 0.000001;
    liveTempo = tempo;
    source = nextSource;
    if (changed || force) options.onTempoChanged?.(tempo, { source, reason });
    if (apply && (changed || force) && typeof options.applyTempo === "function") {
      const startedAt = new Date().toISOString();
      pendingApply = Promise.resolve(options.applyTempo(tempo, { source, reason }))
        .then((result) => {
          lastApply = { ok: true, tempo, source, reason, startedAt, result: result ?? null };
          return result;
        })
        .catch((error) => {
          lastApply = { ok: false, tempo, source, reason, startedAt, error: messageForError(error) };
          return null;
        });
    }
    return {
      live: liveTempo,
      written: writtenTempoForBlock(store.getScore(), activeBlockId, fallbackTempo),
      followBlockTempo,
      source,
      activeBlockId
    };
  }
}

function activeBlockIdFor(score) {
  const blocks = score?.macrostructure?.blocks ?? [];
  const macroIndex = Number(score?.structureState?.macroIndex);
  return String(
    score?.structureState?.activeBlockId
    || (Number.isInteger(macroIndex) ? blocks[macroIndex] : "")
    || blocks[0]
    || ""
  );
}

function entryKeyFor(score) {
  return `${Number(score?.structureState?.macroIndex) || 0}:${activeBlockIdFor(score)}`;
}

function requiredTempo(value) {
  const tempo = Number(value);
  if (!Number.isFinite(tempo) || tempo <= 0) {
    throw new Error("live tempo must be a positive number");
  }
  return tempo;
}

function positiveTempo(value, fallback) {
  const tempo = Number(value);
  return Number.isFinite(tempo) && tempo > 0 ? tempo : fallback;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
