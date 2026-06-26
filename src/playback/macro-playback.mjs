export function createMacroPlayback(store, config = {}, options = {}) {
  const timers = options.timers ?? globalThis;
  let running = false;
  let timer = undefined;
  let nextAdvanceAt = null;
  let currentBlockDurationMs = 0;

  const onChange = (event) => {
    if (!running) {
      return;
    }
    if (shouldReschedule(event)) {
      scheduleNext();
    }
  };
  store.events.on("change", onChange);

  return {
    start(startOptions = {}) {
      if (running) {
        scheduleNext();
        return snapshot();
      }
      running = true;
      if (startOptions.reset) {
        store.resetStructurePlayhead({ sourceClientId: startOptions.sourceClientId });
      } else {
        scheduleNext();
      }
      return snapshot();
    },
    stop() {
      running = false;
      clearTimer();
      nextAdvanceAt = null;
      currentBlockDurationMs = 0;
      return snapshot();
    },
    snapshot,
    close() {
      running = false;
      clearTimer();
      store.events.off("change", onChange);
    }
  };

  function scheduleNext() {
    clearTimer();
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

  function snapshot() {
    const score = store.getScore();
    return {
      running,
      activeBlockId: score.structureState?.activeBlockId ?? "",
      macroIndex: score.structureState?.macroIndex ?? 0,
      nextAdvanceAt,
      currentBlockDurationMs
    };
  }
}

export function macroBlockDurationMs(score, config = {}) {
  const blockId = score.structureState?.activeBlockId ?? score.macrostructure?.blocks?.[0];
  const block = blockId ? score.mesostructure?.[blockId] : undefined;
  const beats = durationBeats(block?.duration, score.context);
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

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
