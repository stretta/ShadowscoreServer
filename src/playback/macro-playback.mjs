export function createMacroPlayback(store, config = {}, options = {}) {
  const timers = options.timers ?? globalThis;
  const jackTransport = options.jackTransport;
  const afterAdvance = options.afterAdvance;
  let running = false;
  let mode = "stopped";
  let timer = undefined;
  let nextAdvanceAt = null;
  let currentBlockDurationMs = 0;
  let activeBlockStartBeat = null;
  let activeBlockEndBeat = null;
  let activeBlockDurationBeats = 0;
  let lastJackAbsoluteBeat = null;
  let lastJackState = "";
  let lastJackStatus = "unusable";
  let phaseAlignmentPending = false;
  let lastPhaseAlignment = null;

  const onChange = (event) => {
    if (!running) {
      return;
    }
    if (shouldReschedule(event)) {
      if (mode === "jack") {
        if (event.sourceClientId !== "macro-playback") {
          anchorJackFollower();
        }
      } else {
        scheduleNext();
      }
    }
  };
  const onJackSnapshot = (event) => {
    if (mode === "jack") {
      followJackSnapshot(event.transport ?? jackTransport?.snapshot?.());
    }
  };
  store.events.on("change", onChange);
  jackTransport?.events?.on?.("snapshot", onJackSnapshot);

  return {
    start(startOptions = {}) {
      const requestedMode = startOptions.mode === "jack" ? "jack" : "timer";
      if (running && mode === requestedMode) {
        clearTimer();
        if (mode === "jack") {
          anchorJackFollower();
        } else {
          scheduleNext();
        }
        return snapshot();
      }
      clearTimer();
      mode = requestedMode;
      running = true;
      if (startOptions.reset) {
        store.resetStructurePlayhead({ sourceClientId: startOptions.sourceClientId });
      }
      if (mode === "jack") {
        anchorJackFollower();
        followJackSnapshot(jackTransport?.snapshot?.());
      } else {
        scheduleNext();
      }
      return snapshot();
    },
    stop() {
      running = false;
      mode = "stopped";
      clearTimer();
      nextAdvanceAt = null;
      currentBlockDurationMs = 0;
      clearJackAnchor();
      return snapshot();
    },
    snapshot,
    close() {
      running = false;
      mode = "stopped";
      clearTimer();
      store.events.off("change", onChange);
      jackTransport?.events?.off?.("snapshot", onJackSnapshot);
    }
  };

  function scheduleNext() {
    clearTimer();
    clearJackAnchor();
    const score = store.getScore();
    currentBlockDurationMs = macroBlockDurationMs(score, config);
    const delayMs = Math.max(1, currentBlockDurationMs);
    nextAdvanceAt = Date.now() + delayMs;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (!running) {
        return;
      }
      try {
        store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
      } catch (error) {
        running = false;
        nextAdvanceAt = null;
        currentBlockDurationMs = 0;
        console.error(`[macro-playback] advance failed: ${messageForError(error)}`);
      }
    }, delayMs);
  }

  function clearTimer() {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
  }

  function anchorJackFollower() {
    clearTimer();
    const transport = jackTransport?.snapshot?.();
    const latest = usableJackSnapshot(transport);
    lastJackState = transport?.latest?.state ?? "";
    lastJackStatus = transport?.status ?? "unusable";
    lastJackAbsoluteBeat = latest?.absoluteBeat ?? null;
    activeBlockDurationBeats = macroBlockDurationBeats(store.getScore(), config);
    currentBlockDurationMs = macroBlockDurationMs(store.getScore(), config);
    if (!latest) {
      activeBlockStartBeat = null;
      activeBlockEndBeat = null;
      return;
    }
    activeBlockStartBeat = latest.absoluteBeat;
    activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats;
  }

  function followJackSnapshot(transport) {
    const latestRaw = transport?.latest;
    lastJackState = latestRaw?.state ?? "";
    lastJackStatus = transport?.status ?? "unusable";
    if (latestRaw?.absoluteBeat !== undefined) {
      lastJackAbsoluteBeat = latestRaw.absoluteBeat;
    }
    const latest = usableJackSnapshot(transport);
    if (!latest) {
      return;
    }
    if (activeBlockStartBeat === null || activeBlockEndBeat === null) {
      anchorJackFollower();
      return;
    }

    let guard = 0;
    while (running && mode === "jack" && latest.absoluteBeat >= activeBlockEndBeat) {
      if (guard >= 16) {
        console.error("[macro-playback] JACK follower catch-up guard stopped after 16 block advances");
        break;
      }
      const previousEndBeat = activeBlockEndBeat;
      try {
        store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
      } catch (error) {
        running = false;
        mode = "stopped";
        clearJackAnchor();
        console.error(`[macro-playback] JACK advance failed: ${messageForError(error)}`);
        return;
      }
      activeBlockStartBeat = previousEndBeat;
      activeBlockDurationBeats = macroBlockDurationBeats(store.getScore(), config);
      currentBlockDurationMs = macroBlockDurationMs(store.getScore(), config);
      runAfterJackAdvance({
        anchorBeat: activeBlockStartBeat,
        boundaryBeat: previousEndBeat,
        absoluteBeat: latest.absoluteBeat
      });
      if (activeBlockDurationBeats <= 0) {
        activeBlockEndBeat = activeBlockStartBeat;
        console.error("[macro-playback] JACK follower cannot advance through a zero-duration block");
        break;
      }
      activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats;
      guard += 1;
    }
  }

  function clearJackAnchor() {
    activeBlockStartBeat = null;
    activeBlockEndBeat = null;
    activeBlockDurationBeats = 0;
    lastJackAbsoluteBeat = null;
    lastJackState = "";
    lastJackStatus = "unusable";
  }

  function snapshot() {
    const score = store.getScore();
    const beatsRemaining = mode === "jack" && activeBlockEndBeat !== null && lastJackAbsoluteBeat !== null
      ? Math.max(0, activeBlockEndBeat - lastJackAbsoluteBeat)
      : null;
    return {
      running,
      mode,
      activeBlockId: score.structureState?.activeBlockId ?? "",
      macroIndex: score.structureState?.macroIndex ?? 0,
      nextAdvanceAt,
      currentBlockDurationMs,
      activeBlockStartBeat,
      activeBlockEndBeat,
      activeBlockDurationBeats,
      beatsRemaining,
      jack: {
        status: lastJackStatus,
        state: lastJackState,
        absoluteBeat: lastJackAbsoluteBeat
      },
      phaseAlignment: {
        pending: phaseAlignmentPending,
        last: lastPhaseAlignment
      }
    };
  }

  function runAfterJackAdvance(detail) {
    if (typeof afterAdvance !== "function") {
      return;
    }
    phaseAlignmentPending = true;
    Promise.resolve()
      .then(() => afterAdvance({
        mode: "jack",
        activeBlockId: store.getScore().structureState?.activeBlockId ?? "",
        macroIndex: store.getScore().structureState?.macroIndex ?? 0,
        ...detail
      }))
      .then((result) => {
        phaseAlignmentPending = false;
        lastPhaseAlignment = {
          ok: true,
          at: new Date().toISOString(),
          action: result?.action ?? "SetStage",
          value: result?.value ?? 0,
          writeCount: Array.isArray(result?.writes) ? result.writes.length : 0
        };
      })
      .catch((error) => {
        phaseAlignmentPending = false;
        lastPhaseAlignment = {
          ok: false,
          at: new Date().toISOString(),
          action: "SetStage",
          value: 0,
          error: messageForError(error)
        };
        console.error(`[macro-playback] phase alignment failed: ${messageForError(error)}`);
      });
  }
}

export function macroBlockDurationBeats(score, config = {}) {
  const blockId = score.structureState?.activeBlockId ?? score.macrostructure?.blocks?.[0];
  const block = blockId ? score.mesostructure?.[blockId] : undefined;
  return durationBeats(block?.duration, score.context);
}

export function macroBlockDurationMs(score, config = {}) {
  const beats = macroBlockDurationBeats(score, config);
  const tempo = finiteNumber(score.macrostructure?.tempo, finiteNumber(config.rnbo?.transport?.Tempo, 120));
  if (beats <= 0 || tempo <= 0) {
    return 0;
  }
  return Math.round(beats * 60000 / tempo);
}

function shouldReschedule(event) {
  return (
    event.type === "structure.playhead.updated" ||
    event.type === "macrostructure.updated" ||
    event.type === "mesostructure.block.replaced" ||
    event.type === "mesostructure.block.removed" ||
    (event.type === "admin.reset" && event.detail?.structure)
  );
}

function durationBeats(duration, context) {
  if (!duration) {
    return 0;
  }
  if (Number.isFinite(duration.beats)) {
    return Number(duration.beats);
  }
  if (Number.isFinite(duration.bars)) {
    const numerator = finiteNumber(context?.clip?.TimeSignature?.numerator, 4);
    return Number(duration.bars) * Math.max(1, numerator);
  }
  return 0;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function usableJackSnapshot(transport) {
  const latest = transport?.latest;
  if (!latest || transport.status !== "fresh" || latest.bbtValid !== true || latest.state !== "rolling") {
    return null;
  }
  return Number.isFinite(latest.absoluteBeat) ? latest : null;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
