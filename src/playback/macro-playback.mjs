import { selectBeatWitness } from "./beat-witness.mjs";

export function createMacroPlayback(store, config = {}, options = {}) {
  const timers = options.timers ?? globalThis;
  const jackTransport = options.jackTransport;
  const afterAdvance = options.afterAdvance;
  const beforeAdvance = options.beforeAdvance;
  const armAdvance = options.armAdvance;
  let running = false;
  let mode = "stopped";
  let timer = undefined;
  let nextAdvanceAt = null;
  let currentBlockDurationMs = 0;
  let activeBlockStartBeat = null;
  let activeBlockEndBeat = null;
  let activeBlockDurationBeats = 0;
  let macroStartBeat = null;
  let macroStartIndex = 0;
  let macroStartOffsetBeats = 0;
  let compositionBeat = null;
  let beatIntoBlock = null;
  let lastJackAbsoluteBeat = null;
  let lastJackState = "";
  let lastJackStatus = "unusable";
  let phaseAlignmentPending = false;
  let lastPhaseAlignment = null;
  let lastLookAheadKey = "";
  let lookAheadPending = false;
  let lastLookAhead = null;
  let lastActivationArmKey = "";
  let activationArmPending = false;
  let lastActivationArm = null;

  const onChange = (event) => {
    if (!running) {
      return;
    }
    if (shouldReschedule(event)) {
      if (mode === "jack") {
        if (event.sourceClientId !== "macro-playback") {
          anchorBeatDerivedPlayback();
          followSelectedWitness();
        }
      } else {
        scheduleNext();
      }
    }
  };
  const onJackSnapshot = (event) => {
    if (mode === "jack") {
      updateJackStatus(event.transport ?? jackTransport?.snapshot?.());
      followSelectedWitness();
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
          anchorBeatDerivedPlayback();
          followSelectedWitness();
        } else {
          scheduleNext();
        }
        return snapshot();
      }
      clearTimer();
      mode = requestedMode;
      running = true;
      lastLookAheadKey = "";
      lookAheadPending = false;
      lastActivationArmKey = "";
      activationArmPending = false;
      if (startOptions.reset) {
        store.resetStructurePlayhead({ sourceClientId: startOptions.sourceClientId });
      }
      if (mode === "jack") {
        anchorBeatDerivedPlayback();
        updateJackStatus(jackTransport?.snapshot?.());
        followSelectedWitness();
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
      clearBeatAnchor();
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
    clearBeatAnchor();
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

  function anchorBeatDerivedPlayback(snapshotOptions = {}) {
    clearTimer();
    const score = store.getScore();
    const witness = selectedWitness(snapshotOptions);
    const current = currentMacroPosition(score);
    macroStartIndex = current.macroIndex;
    macroStartOffsetBeats = cumulativeBeatsBeforeIndex(score, macroStartIndex);
    activeBlockDurationBeats = macroBlockDurationBeats(score, config);
    currentBlockDurationMs = macroBlockDurationMs(score, config);
    compositionBeat = macroStartOffsetBeats;
    beatIntoBlock = 0;
    if (!witness.usable || !Number.isFinite(witness.absoluteBeat)) {
      macroStartBeat = null;
      activeBlockStartBeat = null;
      activeBlockEndBeat = null;
      return;
    }
    macroStartBeat = witness.absoluteBeat;
    activeBlockStartBeat = macroStartBeat;
    activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats;
  }

  function updateJackStatus(transport) {
    const latestRaw = transport?.latest;
    lastJackState = latestRaw?.state ?? "";
    lastJackStatus = transport?.status ?? "unusable";
    if (latestRaw?.absoluteBeat !== undefined) {
      lastJackAbsoluteBeat = latestRaw.absoluteBeat;
    }
  }

  function followSelectedWitness(snapshotOptions = {}) {
    if (!running || mode !== "jack") {
      return;
    }
    const witness = selectedWitness(snapshotOptions);
    if (!witness.usable || !Number.isFinite(witness.absoluteBeat)) {
      return;
    }
    if (macroStartBeat === null) {
      anchorBeatDerivedPlayback(snapshotOptions);
      return;
    }
    deriveMacroLocation(witness);
  }

  function deriveMacroLocation(witness) {
    const score = store.getScore();
    const timeline = macroTimeline(score);
    if (timeline.totalBeats <= 0 || !timeline.entries.length) {
      return;
    }
    const derivedCompositionBeat = witness.absoluteBeat - macroStartBeat + macroStartOffsetBeats;
    const derived = deriveMacroPosition(score, derivedCompositionBeat);
    compositionBeat = derived.compositionBeat;
    beatIntoBlock = derived.beatIntoBlock;
    activeBlockStartBeat = macroStartBeat + derived.blockStartBeat - macroStartOffsetBeats;
    activeBlockEndBeat = macroStartBeat + derived.blockEndBeat - macroStartOffsetBeats;
    activeBlockDurationBeats = derived.durationBeats;
    currentBlockDurationMs = durationMsFromBeats(derived.durationBeats, score, config);
    runBeforeAdvance(score, derived, witness);
    runArmAdvance(score, derived, witness);

    const current = currentMacroPosition(score);
    if (derived.macroIndex === current.macroIndex && derived.activeBlockId === current.activeBlockId) {
      return;
    }

    try {
      store.updateStructureState({
        macroIndex: derived.macroIndex,
        activeBlockId: derived.activeBlockId
      }, { sourceClientId: "macro-playback" });
    } catch (error) {
      running = false;
      mode = "stopped";
      clearBeatAnchor();
      console.error(`[macro-playback] beat-derived advance failed: ${messageForError(error)}`);
      return;
    }
    runAfterBeatDerivedAdvance({
      anchorBeat: activeBlockStartBeat,
      boundaryBeat: activeBlockStartBeat,
      absoluteBeat: witness.absoluteBeat,
      compositionBeat,
      beatIntoBlock,
      witnessSource: witness.source
    });
  }

  function clearBeatAnchor() {
    activeBlockStartBeat = null;
    activeBlockEndBeat = null;
    activeBlockDurationBeats = 0;
    macroStartBeat = null;
    macroStartIndex = 0;
    macroStartOffsetBeats = 0;
    compositionBeat = null;
    beatIntoBlock = null;
    lastJackAbsoluteBeat = null;
    lastJackState = "";
    lastJackStatus = "unusable";
  }

  function snapshot(snapshotOptions = {}) {
    updateJackStatus(jackTransport?.snapshot?.());
    followSelectedWitness(snapshotOptions);
    const score = store.getScore();
    const witness = selectedWitness(snapshotOptions);
    const beatsRemaining = mode === "jack" && activeBlockEndBeat !== null && beatIntoBlock !== null
      ? Math.max(0, activeBlockDurationBeats - beatIntoBlock)
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
      macroStartBeat,
      macroStartIndex,
      macroStartOffsetBeats,
      compositionBeat,
      beatIntoBlock,
      beatsRemaining,
      witness,
      jack: {
        status: lastJackStatus,
        state: lastJackState,
        absoluteBeat: lastJackAbsoluteBeat
      },
      phaseAlignment: {
        pending: phaseAlignmentPending,
        last: lastPhaseAlignment
      },
      lookAhead: {
        pending: lookAheadPending,
        last: lastLookAhead
      },
      activationArm: {
        pending: activationArmPending,
        last: lastActivationArm
      }
    };
  }

  function selectedWitness(snapshotOptions = {}) {
    return selectBeatWitness({
      mode,
      running,
      jackTransport: jackTransport?.snapshot?.(),
      rnboTargets: snapshotOptions.rnboTargets,
      timingContracts: snapshotOptions.timingContracts,
      rnboClient: config.transport?.rnboClient
    });
  }

  function runAfterBeatDerivedAdvance(detail) {
    if (typeof afterAdvance !== "function") {
      return;
    }
    phaseAlignmentPending = true;
    Promise.resolve()
      .then(() => afterAdvance({
        mode,
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

  function runBeforeAdvance(score, derived, witness) {
    if (typeof beforeAdvance !== "function" || lookAheadPending) return;
    const threshold = Math.max(0, Number(config.rnbo?.lookAheadBeats ?? 12));
    const beatsRemaining = Math.max(0, derived.durationBeats - derived.beatIntoBlock);
    if (beatsRemaining > threshold) return;
    const blocks = score.macrostructure?.blocks ?? [];
    if (blocks.length < 2) return;
    const nextMacroIndex = (derived.macroIndex + 1) % blocks.length;
    const nextBlockId = blocks[nextMacroIndex];
    const boundaryCompositionBeat = derived.compositionBeat - derived.beatIntoBlock + derived.durationBeats;
    const key = `${boundaryCompositionBeat}:${derived.macroIndex}:${nextMacroIndex}:${nextBlockId}`;
    if (key === lastLookAheadKey) return;
    lastLookAheadKey = key;
    lookAheadPending = true;
    Promise.resolve(beforeAdvance({
      activeBlockId: derived.activeBlockId,
      macroIndex: derived.macroIndex,
      nextBlockId,
      nextMacroIndex,
      beatsRemaining,
      boundaryBeat: activeBlockEndBeat,
      witnessSource: witness.source
    })).then((result) => {
      lookAheadPending = false;
      lastLookAhead = {
        ok: true,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat: activeBlockEndBeat,
        result: result ?? null
      };
    }).catch((error) => {
      lookAheadPending = false;
      lastLookAheadKey = "";
      lastLookAhead = {
        ok: false,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat: activeBlockEndBeat,
        error: messageForError(error)
      };
      console.error(`[macro-playback] look-ahead preparation failed: ${messageForError(error)}`);
    });
  }

  function runArmAdvance(score, derived, witness) {
    if (typeof armAdvance !== "function" || activationArmPending) return;
    const leadBeats = Math.min(0.999, Math.max(0, Number(config.rnbo?.activation?.armLeadBeats ?? 0.75)));
    const beatsRemaining = Math.max(0, derived.durationBeats - derived.beatIntoBlock);
    if (beatsRemaining <= 0 || beatsRemaining > leadBeats) return;
    const blocks = score.macrostructure?.blocks ?? [];
    if (blocks.length < 2) return;
    const nextMacroIndex = (derived.macroIndex + 1) % blocks.length;
    const nextBlockId = blocks[nextMacroIndex];
    if (
      lastLookAhead?.ok !== true ||
      lastLookAhead.activeBlockId !== derived.activeBlockId ||
      lastLookAhead.nextBlockId !== nextBlockId
    ) return;
    const boundaryCompositionBeat = derived.compositionBeat - derived.beatIntoBlock + derived.durationBeats;
    const key = `${boundaryCompositionBeat}:${derived.macroIndex}:${nextMacroIndex}:${nextBlockId}`;
    if (key === lastActivationArmKey) return;
    const boundaryBeat = activeBlockEndBeat;
    lastActivationArmKey = key;
    activationArmPending = true;
    Promise.resolve(armAdvance({
      activeBlockId: derived.activeBlockId,
      macroIndex: derived.macroIndex,
      nextBlockId,
      nextMacroIndex,
      beatsRemaining,
      boundaryBeat,
      witnessSource: witness.source,
      preparation: lastLookAhead.result
    })).then((result) => {
      activationArmPending = false;
      lastActivationArm = {
        ok: true,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat,
        result: result ?? null
      };
    }).catch((error) => {
      activationArmPending = false;
      lastActivationArmKey = "";
      lastActivationArm = {
        ok: false,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat,
        error: messageForError(error)
      };
      console.error(`[macro-playback] activation arm failed: ${messageForError(error)}`);
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
  return durationMsFromBeats(beats, score, config);
}

function durationMsFromBeats(beats, score, config = {}) {
  const tempo = finiteNumber(score.macrostructure?.tempo, finiteNumber(config.rnbo?.transport?.Tempo, 120));
  if (beats <= 0 || tempo <= 0) {
    return 0;
  }
  return Math.round(beats * 60000 / tempo);
}

export function deriveMacroPosition(score, compositionBeat) {
  const timeline = macroTimeline(score);
  if (!timeline.entries.length || timeline.totalBeats <= 0) {
    const current = currentMacroPosition(score);
    return {
      macroIndex: current.macroIndex,
      activeBlockId: current.activeBlockId,
      compositionBeat: 0,
      cycleBeat: 0,
      blockStartBeat: 0,
      blockEndBeat: 0,
      beatIntoBlock: 0,
      durationBeats: 0
    };
  }

  const normalizedCompositionBeat = Math.max(0, Number.isFinite(compositionBeat) ? compositionBeat : 0);
  const cycleBeat = positiveModulo(normalizedCompositionBeat, timeline.totalBeats);
  const entry = timeline.entries.find((candidate) => cycleBeat >= candidate.startBeat && cycleBeat < candidate.endBeat)
    ?? timeline.entries.at(-1);
  return {
    macroIndex: entry.index,
    activeBlockId: entry.blockId,
    compositionBeat: normalizedCompositionBeat,
    cycleBeat,
    blockStartBeat: normalizedCompositionBeat - cycleBeat + entry.startBeat,
    blockEndBeat: normalizedCompositionBeat - cycleBeat + entry.endBeat,
    beatIntoBlock: cycleBeat - entry.startBeat,
    durationBeats: entry.durationBeats
  };
}

export function macroTimeline(score) {
  const blocks = score.macrostructure?.blocks ?? [];
  const entries = [];
  let cursor = 0;
  for (const [index, blockId] of blocks.entries()) {
    const block = score.mesostructure?.[blockId];
    const duration = durationBeats(block?.duration, score.context);
    if (duration <= 0) {
      continue;
    }
    entries.push({
      index,
      blockId,
      startBeat: cursor,
      endBeat: cursor + duration,
      durationBeats: duration
    });
    cursor += duration;
  }
  return {
    entries,
    totalBeats: cursor
  };
}

function shouldReschedule(event) {
  return (
    event.type === "structure.playhead.updated" ||
    event.type === "macrostructure.updated" ||
    event.type === "mesostructure.block.replaced" ||
    event.type === "mesostructure.block.duplicated" ||
    event.type === "mesostructure.block.removed" ||
    (event.type === "admin.reset" && event.detail?.structure)
  );
}

function currentMacroPosition(score) {
  const blocks = score.macrostructure?.blocks ?? [];
  if (!blocks.length) {
    return {
      macroIndex: 0,
      activeBlockId: score.structureState?.activeBlockId ?? ""
    };
  }
  const macroIndex = Number.isInteger(score.structureState?.macroIndex)
    ? Math.min(blocks.length - 1, Math.max(0, score.structureState.macroIndex))
    : 0;
  return {
    macroIndex,
    activeBlockId: blocks[macroIndex] ?? score.structureState?.activeBlockId ?? ""
  };
}

function cumulativeBeatsBeforeIndex(score, macroIndex) {
  const timeline = macroTimeline(score);
  const entry = timeline.entries.find((candidate) => candidate.index === macroIndex);
  if (entry) {
    return entry.startBeat;
  }
  return timeline.entries.reduce((total, entry) => entry.index < macroIndex ? total + entry.durationBeats : total, 0);
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

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
