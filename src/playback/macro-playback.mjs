import { selectBeatWitness } from "./beat-witness.mjs";
import { activeWrittenTempo } from "./tempo.mjs";

export function createMacroPlayback(store, config = {}, options = {}) {
  const timers = options.timers ?? globalThis;
  const now = options.now ?? Date.now;
  const jackTransport = options.jackTransport;
  const afterAdvance = options.afterAdvance;
  const beforeAdvance = options.beforeAdvance;
  const armAdvance = options.armAdvance;
  let running = false;
  let mode = "stopped";
  let timer = undefined;
  let lookAheadTimer = undefined;
  let activationArmTimer = undefined;
  let nextAdvanceAt = null;
  let currentBlockDurationMs = 0;
  let timerTempo = null;
  let timerElapsedBeats = 0;
  let timerBlockStartedAt = null;
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
  let lookAheadPromise = null;
  let lastLookAhead = null;
  let lastActivationArmKey = "";
  let activationArmPending = false;
  let activationArmPromise = null;
  let lastActivationArm = null;
  let traversalBlocks = [];
  let traversalMacroIndex = 0;
  let traversalBlockId = "";
  let pendingArrangement = null;
  let witnessPollTimer;
  let witnessPollPending = false;
  let lastWitnessContext = {};
  let anchoredWitnessSource = "";
  let rnboWitnessTargetId = "";
  let rnboWitnessRawBeat = null;
  let rnboWitnessEpochBeats = 0;
  let pendingCue = null;
  let cueSequence = 0;
  let transitionGeneration = 0;

  const onChange = (event) => {
    if (!running) {
      return;
    }
    if (event.type === "macrostructure.updated") {
      pendingArrangement = {
        blocks: [...(event.score?.macrostructure?.blocks ?? store.getScore().macrostructure?.blocks ?? [])],
        scoreRevision: event.score?.scoreRevision ?? event.score?.version ?? store.getScore().scoreRevision ?? store.getScore().version ?? 0
      };
      lastLookAheadKey = "";
      lastActivationArmKey = "";
      return;
    }
    if (event.type === "structure.playhead.updated") {
      latchTraversal(event.score ?? store.getScore());
      pendingArrangement = null;
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
      lastWitnessContext = startOptions.witnessContext ?? lastWitnessContext;
      if (running && mode === requestedMode) {
        clearTimer();
        if (mode === "jack") {
          resetWitnessNormalization();
          anchorBeatDerivedPlayback(lastWitnessContext, startOptions.anchorOffsetBeats);
          followSelectedWitness(lastWitnessContext);
          startWitnessPolling();
        } else {
          scheduleNext();
        }
        return snapshot();
      }
      clearTimer();
      mode = requestedMode;
      running = true;
      latchTraversal(store.getScore());
      pendingArrangement = null;
      lastLookAheadKey = "";
      lookAheadPending = false;
      lastActivationArmKey = "";
      activationArmPending = false;
      resetWitnessNormalization();
      if (startOptions.reset) {
        store.resetStructurePlayhead({ sourceClientId: startOptions.sourceClientId });
      }
      if (mode === "jack") {
        anchorBeatDerivedPlayback(lastWitnessContext, startOptions.anchorOffsetBeats);
        updateJackStatus(jackTransport?.snapshot?.());
        followSelectedWitness(lastWitnessContext);
        startWitnessPolling();
      } else {
        clearWitnessPolling();
        scheduleNext();
      }
      return snapshot();
    },
    stop() {
      running = false;
      mode = "stopped";
      clearTimer();
      clearWitnessPolling();
      nextAdvanceAt = null;
      currentBlockDurationMs = 0;
      pendingArrangement = null;
      traversalBlocks = [];
      traversalMacroIndex = 0;
      traversalBlockId = "";
      clearTimerAnchor();
      clearBeatAnchor();
      resetWitnessNormalization();
      return snapshot();
    },
    cue(cueRequest = {}) {
      const score = store.getScore();
      const target = normalizeCueTarget(score, cueRequest);
      if (activationArmPending || pendingCue?.state === "armed") {
        throw new Error("the current cue is already armed and cannot be replaced");
      }
      resetTransitionAttempt({ preserveCue: true });
      pendingCue = {
        id: ++cueSequence,
        source: String(cueRequest.source ?? "manual"),
        requestedAt: new Date().toISOString(),
        blockId: target.blockId,
        macroIndex: target.macroIndex,
        boundary: running ? "end-of-section" : "now",
        state: "selected",
        error: ""
      };
      if (running && mode === "jack") {
        preparePendingCue();
        followSelectedWitness();
      } else if (running && mode === "timer") {
        scheduleTimerTransition({ prepareImmediately: true });
      }
      return snapshot();
    },
    clearCue() {
      pendingCue = null;
      resetTransitionAttempt();
      return snapshot();
    },
    tempoChanged() {
      if (!running) return snapshot();
      if (mode === "timer") {
        reanchorTimerTempo();
      } else {
        const score = store.getScore();
        currentBlockDurationMs = durationMsAtTempo(
          macroBlockDurationBeats(score, config),
          effectiveTempo(score)
        );
      }
      return snapshot();
    },
    snapshot,
    close() {
      running = false;
      mode = "stopped";
      clearTimer();
      clearWitnessPolling();
      store.events.off("change", onChange);
      jackTransport?.events?.off?.("snapshot", onJackSnapshot);
    }
  };

  function scheduleNext() {
    clearTimer();
    clearBeatAnchor();
    const score = store.getScore();
    const durationBeats = macroBlockDurationBeats(score, config);
    scheduleTimer(durationBeats, 0, effectiveTempo(score));
  }

  function scheduleTimer(durationBeats, elapsedBeats, tempo) {
    clearTimer();
    timerTempo = tempo;
    timerElapsedBeats = Math.max(0, Math.min(durationBeats, elapsedBeats));
    timerBlockStartedAt = now();
    currentBlockDurationMs = durationMsAtTempo(durationBeats, tempo);
    const remainingBeats = Math.max(0, durationBeats - timerElapsedBeats);
    const delayMs = Math.max(1, durationMsAtTempo(remainingBeats, tempo));
    nextAdvanceAt = timerBlockStartedAt + delayMs;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (!running) {
        return;
      }
      if (!transactionalAdvanceEnabled()) {
        try {
          adoptPendingArrangement();
          store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
        } catch (error) {
          running = false;
          nextAdvanceAt = null;
          currentBlockDurationMs = 0;
          console.error(`[macro-playback] advance failed: ${messageForError(error)}`);
        }
        return;
      }
      void completeTimerTransition();
    }, delayMs);
    scheduleTimerTransition();
  }

  function scheduleTimerTransition(options = {}) {
    clearTransitionTimers();
    if (!running || mode !== "timer" || !transactionalAdvanceEnabled()) return;
    const score = traversalScore(store.getScore());
    const durationBeats = macroBlockDurationBeats(score, config);
    const tempo = effectiveTempo(score);
    const elapsedBeats = timerElapsedBeats + (timerBlockStartedAt === null ? 0 : Math.max(0, now() - timerBlockStartedAt) * tempo / 60000);
    const remainingBeats = Math.max(0, durationBeats - elapsedBeats);
    const lookAheadBeats = Math.max(0, Number(config.rnbo?.lookAheadBeats ?? 12));
    const armLeadBeats = Math.min(0.999, Math.max(0, Number(config.rnbo?.activation?.armLeadBeats ?? 0.75)));
    const prepareDelayMs = options.prepareImmediately ? 0 : durationMsAtTempo(Math.max(0, remainingBeats - lookAheadBeats), tempo);
    const armDelayMs = durationMsAtTempo(Math.max(0, remainingBeats - armLeadBeats), tempo);
    lookAheadTimer = timers.setTimeout(() => {
      lookAheadTimer = undefined;
      runTimerBeforeAdvance({ force: options.prepareImmediately === true });
    }, Math.max(1, prepareDelayMs));
    activationArmTimer = timers.setTimeout(() => {
      activationArmTimer = undefined;
      runTimerArmAdvance();
    }, Math.max(1, armDelayMs));
  }

  function timerDerivedPosition() {
    const score = traversalScore(store.getScore());
    const durationBeats = macroBlockDurationBeats(score, config);
    const tempo = effectiveTempo(score);
    const elapsed = timerBlockStartedAt === null ? 0 : Math.max(0, now() - timerBlockStartedAt) * tempo / 60000;
    const beatIntoBlock = Math.max(0, Math.min(durationBeats, timerElapsedBeats + elapsed));
    return {
      activeBlockId: traversalBlockId,
      macroIndex: traversalMacroIndex,
      durationBeats,
      beatIntoBlock,
      compositionBeat: cumulativeBeatsBeforeIndex(score, traversalMacroIndex) + beatIntoBlock
    };
  }

  function runTimerBeforeAdvance(options = {}) {
    runBeforeAdvance(traversalScore(store.getScore()), timerDerivedPosition(), { source: "timer" }, options);
  }

  function runTimerArmAdvance() {
    runArmAdvance(traversalScore(store.getScore()), timerDerivedPosition(), { source: "timer" });
  }

  function preparePendingCue() {
    const score = traversalScore(store.getScore());
    const durationBeats = activeBlockDurationBeats || macroBlockDurationBeats(score, config);
    runBeforeAdvance(score, {
      activeBlockId: traversalBlockId,
      macroIndex: traversalMacroIndex,
      durationBeats,
      beatIntoBlock: Math.max(0, Number(beatIntoBlock) || 0),
      compositionBeat: Math.max(0, Number(compositionBeat) || cumulativeBeatsBeforeIndex(score, traversalMacroIndex))
    }, selectedWitness(), { force: true });
  }

  async function completeTimerTransition() {
    try {
      if (activationArmPending && activationArmPromise) {
        await activationArmPromise.catch(() => undefined);
      }
      const score = traversalScore(store.getScore());
      const current = { macroIndex: traversalMacroIndex, activeBlockId: traversalBlockId };
      const next = nextArrangementEntry(score, current);
      if (!next) {
        scheduleNext();
        return;
      }
      if (transitionIsActive(current.activeBlockId, next.nextBlockId)) {
        commitTransition(next);
        return;
      }
      markCueMissed(`block '${next.nextBlockId}' was not ACTIVE at the requested boundary`);
      resetTransitionAttempt({ preserveCue: true });
      scheduleNext();
    } catch (error) {
      running = false;
      nextAdvanceAt = null;
      currentBlockDurationMs = 0;
      markCueMissed(messageForError(error));
      console.error(`[macro-playback] advance failed: ${messageForError(error)}`);
    }
  }

  function reanchorTimerTempo() {
    const score = store.getScore();
    const durationBeats = macroBlockDurationBeats(score, config);
    const observedAt = now();
    const elapsedSinceAnchor = timerBlockStartedAt === null || !Number.isFinite(timerTempo)
      ? 0
      : Math.max(0, observedAt - timerBlockStartedAt) * timerTempo / 60000;
    const elapsedBeats = Math.max(0, Math.min(durationBeats, timerElapsedBeats + elapsedSinceAnchor));
    scheduleTimer(durationBeats, elapsedBeats, effectiveTempo(score));
  }

  function clearTimer() {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
    clearTransitionTimers();
  }

  function clearTransitionTimers() {
    if (lookAheadTimer !== undefined) {
      timers.clearTimeout(lookAheadTimer);
      lookAheadTimer = undefined;
    }
    if (activationArmTimer !== undefined) {
      timers.clearTimeout(activationArmTimer);
      activationArmTimer = undefined;
    }
  }

  function clearTimerAnchor() {
    timerTempo = null;
    timerElapsedBeats = 0;
    timerBlockStartedAt = null;
  }

  function anchorBeatDerivedPlayback(snapshotOptions = {}, requestedOffsetBeats = 0) {
    clearTimer();
    const score = traversalScore(store.getScore());
    const witness = selectedWitness(snapshotOptions);
    macroStartIndex = traversalMacroIndex;
    macroStartOffsetBeats = cumulativeBeatsBeforeIndex(score, macroStartIndex);
    activeBlockDurationBeats = macroBlockDurationBeats(score, config);
    currentBlockDurationMs = durationMsAtTempo(activeBlockDurationBeats, effectiveTempo(score));
    const offsetBeats = Math.max(0, Math.min(activeBlockDurationBeats, finiteNumber(requestedOffsetBeats, 0)));
    compositionBeat = macroStartOffsetBeats + offsetBeats;
    beatIntoBlock = offsetBeats;
    if (!witness.usable || !Number.isFinite(witness.absoluteBeat)) {
      macroStartBeat = null;
      activeBlockStartBeat = null;
      activeBlockEndBeat = null;
      return;
    }
    macroStartBeat = witness.absoluteBeat - offsetBeats;
    activeBlockStartBeat = macroStartBeat;
    activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats;
    anchoredWitnessSource = witness.source;
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
    if (anchoredWitnessSource && witness.source !== anchoredWitnessSource) {
      reanchorWitnessSource(witness);
    }
    anchoredWitnessSource = witness.source;
    deriveMacroLocation(witness);
  }

  function reanchorWitnessSource(witness) {
    const offsetFromMacroStart = finiteNumber(compositionBeat, macroStartOffsetBeats) - macroStartOffsetBeats;
    macroStartBeat = witness.absoluteBeat - offsetFromMacroStart;
    const currentOffset = finiteNumber(beatIntoBlock, 0);
    activeBlockStartBeat = witness.absoluteBeat - currentOffset;
    activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats;
  }

  function deriveMacroLocation(witness) {
    const score = traversalScore(store.getScore());
    const timeline = macroTimeline(score);
    if (timeline.totalBeats <= 0 || !timeline.entries.length) {
      return;
    }
    const previousBlockEndBeat = activeBlockEndBeat;
    let derivedCompositionBeat = witness.absoluteBeat - macroStartBeat + macroStartOffsetBeats;
    if (Number.isFinite(compositionBeat) && derivedCompositionBeat < compositionBeat) {
      // jack_transport_link can rewrite JACK BBT backward while adopting a new
      // tempo. Preserve the arrangement's musical position and move the JACK
      // anchor with that discontinuity instead of re-entering the prior block.
      macroStartBeat = witness.absoluteBeat - compositionBeat + macroStartOffsetBeats;
      derivedCompositionBeat = compositionBeat;
    }
    const derived = deriveMacroPosition(score, derivedCompositionBeat);
    compositionBeat = derived.compositionBeat;
    beatIntoBlock = derived.beatIntoBlock;
    activeBlockStartBeat = macroStartBeat + derived.blockStartBeat - macroStartOffsetBeats;
    activeBlockEndBeat = macroStartBeat + derived.blockEndBeat - macroStartOffsetBeats;
    activeBlockDurationBeats = derived.durationBeats;
    currentBlockDurationMs = durationMsAtTempo(derived.durationBeats, effectiveTempo(score));

    const current = {
      macroIndex: traversalMacroIndex,
      activeBlockId: traversalBlockId
    };
    if (derived.macroIndex === current.macroIndex && derived.activeBlockId === current.activeBlockId) {
      runBeforeAdvance(score, derived, witness);
      runArmAdvance(score, derived, witness);
      return;
    }

    let committed = { nextMacroIndex: derived.macroIndex, nextBlockId: derived.activeBlockId };
    if (transactionalAdvanceEnabled()) {
      const next = nextArrangementEntry(score, current);
      if (!next) return;
      if (activationArmPending) return;
      if (!transitionIsActive(current.activeBlockId, next.nextBlockId)) {
        holdAtCurrentBlock(witness, `block '${next.nextBlockId}' was not ACTIVE at the requested boundary`);
        return;
      }
      committed = next;
    }

    if (pendingArrangement) {
      adoptPendingArrangementAtBeatBoundary(witness, derived, previousBlockEndBeat);
      return;
    }

    try {
      commitTransition(committed);
    } catch (error) {
      running = false;
      mode = "stopped";
      clearBeatAnchor();
      console.error(`[macro-playback] beat-derived advance failed: ${messageForError(error)}`);
      return;
    }
    if (transactionalAdvanceEnabled()) {
      reanchorCommittedTransition(witness, committed, previousBlockEndBeat);
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

  function adoptPendingArrangementAtBeatBoundary(witness, derived, previousBlockEndBeat) {
    const boundaryBeat = Number.isFinite(previousBlockEndBeat)
      ? previousBlockEndBeat
      : macroStartBeat + derived.blockStartBeat - macroStartOffsetBeats;
    try {
      adoptPendingArrangement();
      store.advanceStructurePlayhead({ sourceClientId: "macro-playback" });
    } catch (error) {
      running = false;
      mode = "stopped";
      clearBeatAnchor();
      console.error(`[macro-playback] arrangement adoption failed: ${messageForError(error)}`);
      return;
    }

    const score = traversalScore(store.getScore());
    macroStartIndex = traversalMacroIndex;
    macroStartOffsetBeats = cumulativeBeatsBeforeIndex(score, macroStartIndex);
    macroStartBeat = boundaryBeat;
    activeBlockStartBeat = boundaryBeat;
    activeBlockDurationBeats = macroBlockDurationBeats(score, config);
    activeBlockEndBeat = boundaryBeat + activeBlockDurationBeats;
    const overshootBeats = Math.max(0, witness.absoluteBeat - boundaryBeat);
    compositionBeat = macroStartOffsetBeats + overshootBeats;
    beatIntoBlock = Math.min(activeBlockDurationBeats, overshootBeats);
    currentBlockDurationMs = durationMsAtTempo(activeBlockDurationBeats, effectiveTempo(score));
    lastLookAheadKey = "";
    lastActivationArmKey = "";
    runAfterBeatDerivedAdvance({
      anchorBeat: boundaryBeat,
      boundaryBeat,
      absoluteBeat: witness.absoluteBeat,
      compositionBeat,
      beatIntoBlock,
      witnessSource: witness.source,
      arrangementAdopted: true
    });
  }

  function adoptPendingArrangement() {
    if (!pendingArrangement) {
      return false;
    }
    traversalBlocks = [...pendingArrangement.blocks];
    pendingArrangement = null;
    latchTraversal(store.getScore(), { preserveBlocks: true });
    lastLookAheadKey = "";
    lastActivationArmKey = "";
    return true;
  }

  function latchTraversal(score, options = {}) {
    if (!options.preserveBlocks) {
      traversalBlocks = [...(score.macrostructure?.blocks ?? [])];
    }
    const current = currentMacroPosition({
      ...score,
      macrostructure: {
        ...score.macrostructure,
        blocks: traversalBlocks
      }
    });
    traversalMacroIndex = current.macroIndex;
    traversalBlockId = current.activeBlockId;
  }

  function traversalScore(score) {
    return {
      ...score,
      macrostructure: {
        ...score.macrostructure,
        blocks: traversalBlocks
      },
      structureState: {
        ...score.structureState,
        macroIndex: traversalMacroIndex,
        activeBlockId: traversalBlockId
      }
    };
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
    anchoredWitnessSource = "";
  }

  function snapshot(snapshotOptions = {}) {
    updateJackStatus(jackTransport?.snapshot?.());
    followSelectedWitness(snapshotOptions);
    const score = store.getScore();
    const witness = selectedWitness(snapshotOptions);
    const beatsRemaining = mode === "jack" && activeBlockEndBeat !== null && beatIntoBlock !== null
      ? Math.max(0, activeBlockDurationBeats - beatIntoBlock)
      : mode === "timer"
        ? timerBeatsRemaining(score)
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
      traversalMacroIndex,
      traversalBlockId,
      arrangementAdoption: {
        pending: Boolean(pendingArrangement),
        scoreRevision: pendingArrangement?.scoreRevision ?? null,
        blocks: pendingArrangement ? [...pendingArrangement.blocks] : null
      },
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
      },
      cue: cueSnapshot()
    };
  }

  function cueSnapshot() {
    if (pendingCue) return { ...pendingCue };
    if (lastActivationArm?.ok && lastActivationArm.nextBlockId) {
      return {
        id: null,
        source: "automatic",
        requestedAt: null,
        blockId: lastActivationArm.nextBlockId,
        macroIndex: null,
        boundary: "end-of-section",
        state: "active",
        error: ""
      };
    }
    return null;
  }

  function timerBeatsRemaining(score) {
    const durationBeats = macroBlockDurationBeats(score, config);
    const elapsedSinceAnchor = timerBlockStartedAt === null || !Number.isFinite(timerTempo)
      ? 0
      : Math.max(0, now() - timerBlockStartedAt) * timerTempo / 60000;
    return Math.max(0, durationBeats - timerElapsedBeats - elapsedSinceAnchor);
  }

  function effectiveTempo(score) {
    const runtimeTempo = Number(options.getTempo?.());
    return Number.isFinite(runtimeTempo) && runtimeTempo > 0
      ? runtimeTempo
      : activeWrittenTempo(score, finiteNumber(config.rnbo?.transport?.Tempo, 120));
  }

  function selectedWitness(snapshotOptions = {}) {
    if (snapshotOptions?.rnboTargets) lastWitnessContext = snapshotOptions;
    return normalizeWitness(selectBeatWitness({
      mode,
      running,
      jackTransport: jackTransport?.snapshot?.(),
      rnboTargets: snapshotOptions.rnboTargets ?? lastWitnessContext.rnboTargets,
      timingContracts: snapshotOptions.timingContracts ?? lastWitnessContext.timingContracts,
      rnboClient: config.transport?.rnboClient
    }));
  }

  function normalizeWitness(witness) {
    if (witness.source !== "rnbo-client" || !Number.isFinite(witness.absoluteBeat)) return witness;
    const targetId = String(witness.targetId ?? "");
    if (targetId !== rnboWitnessTargetId) {
      rnboWitnessTargetId = targetId;
      rnboWitnessRawBeat = null;
      rnboWitnessEpochBeats = 0;
    }
    if (
      Number.isFinite(rnboWitnessRawBeat) &&
      witness.absoluteBeat < rnboWitnessRawBeat - 0.25 &&
      Number.isFinite(witness.cycleBeats) &&
      witness.cycleBeats > 0
    ) {
      rnboWitnessEpochBeats += witness.cycleBeats;
    }
    rnboWitnessRawBeat = witness.absoluteBeat;
    return {
      ...witness,
      absoluteBeat: witness.absoluteBeat + rnboWitnessEpochBeats
    };
  }

  function resetWitnessNormalization() {
    anchoredWitnessSource = "";
    rnboWitnessTargetId = "";
    rnboWitnessRawBeat = null;
    rnboWitnessEpochBeats = 0;
  }

  function startWitnessPolling() {
    clearWitnessPolling();
    if (typeof options.loadWitnessContext !== "function" || typeof timers.setInterval !== "function") return;
    const intervalMs = Math.max(25, finiteNumber(config.transport?.rnboClient?.pollIntervalMs, 125));
    witnessPollTimer = timers.setInterval(async () => {
      if (witnessPollPending || !running || mode !== "jack") return;
      witnessPollPending = true;
      try {
        const context = await options.loadWitnessContext();
        if (context) followSelectedWitness(context);
      } catch (error) {
        console.error(`[macro-playback] witness poll failed: ${messageForError(error)}`);
      } finally {
        witnessPollPending = false;
      }
    }, intervalMs);
    witnessPollTimer?.unref?.();
  }

  function clearWitnessPolling() {
    if (witnessPollTimer !== undefined && typeof timers.clearInterval === "function") {
      timers.clearInterval(witnessPollTimer);
    }
    witnessPollTimer = undefined;
    witnessPollPending = false;
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

  function runBeforeAdvance(score, derived, witness, options = {}) {
    if (typeof beforeAdvance !== "function" || lookAheadPending) return;
    const threshold = Math.max(0, Number(config.rnbo?.lookAheadBeats ?? 12));
    const beatsRemaining = Math.max(0, derived.durationBeats - derived.beatIntoBlock);
    if (!options.force && beatsRemaining > threshold) return;
    const next = nextArrangementEntry(score, derived);
    if (!next) return;
    const { nextMacroIndex, nextBlockId } = next;
    const boundaryCompositionBeat = derived.compositionBeat - derived.beatIntoBlock + derived.durationBeats;
    const key = `${boundaryCompositionBeat}:${derived.macroIndex}:${nextMacroIndex}:${nextBlockId}`;
    if (key === lastLookAheadKey) return;
    lastLookAheadKey = key;
    lookAheadPending = true;
    const generation = transitionGeneration;
    if (pendingCue) pendingCue.state = "preparing";
    lookAheadPromise = Promise.resolve(beforeAdvance({
      activeBlockId: derived.activeBlockId,
      macroIndex: derived.macroIndex,
      nextBlockId,
      nextMacroIndex,
      beatsRemaining,
      boundaryBeat: activeBlockEndBeat,
      witnessSource: witness.source
    })).then((result) => {
      if (generation !== transitionGeneration) return;
      lookAheadPending = false;
      lastLookAhead = {
        ok: true,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat: activeBlockEndBeat,
        result: result ?? null
      };
      if (pendingCue && pendingCue.blockId === nextBlockId) pendingCue.state = "ready";
      if (mode === "timer" && activationArmTimer === undefined) runTimerArmAdvance();
    }).catch((error) => {
      if (generation !== transitionGeneration) return;
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
    return lookAheadPromise;
  }

  function runArmAdvance(score, derived, witness) {
    if (typeof armAdvance !== "function" || activationArmPending) return;
    const leadBeats = Math.min(0.999, Math.max(0, Number(config.rnbo?.activation?.armLeadBeats ?? 0.75)));
    const beatsRemaining = Math.max(0, derived.durationBeats - derived.beatIntoBlock);
    if (beatsRemaining <= 0 || beatsRemaining > leadBeats) return;
    const next = nextArrangementEntry(score, derived);
    if (!next) return;
    const { nextMacroIndex, nextBlockId } = next;
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
    const generation = transitionGeneration;
    if (pendingCue) pendingCue.state = "armed";
    activationArmPromise = Promise.resolve(armAdvance({
      activeBlockId: derived.activeBlockId,
      macroIndex: derived.macroIndex,
      nextBlockId,
      nextMacroIndex,
      beatsRemaining,
      boundaryBeat,
      witnessSource: witness.source,
      preparation: lastLookAhead.result
    })).then((result) => {
      if (generation !== transitionGeneration) return;
      activationArmPending = false;
      lastActivationArm = {
        ok: true,
        at: new Date().toISOString(),
        activeBlockId: derived.activeBlockId,
        nextBlockId,
        boundaryBeat,
        result: result ?? null
      };
      if (pendingCue && pendingCue.blockId === nextBlockId) pendingCue.state = "active";
      if (mode === "jack") followSelectedWitness();
    }).catch((error) => {
      if (generation !== transitionGeneration) return;
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
    return activationArmPromise;
  }

  function nextArrangementEntry(traversal, derived) {
    if (pendingCue) {
      return {
        nextMacroIndex: pendingCue.macroIndex,
        nextBlockId: pendingCue.blockId
      };
    }
    if (pendingArrangement) {
      const canonical = store.getScore();
      const blocks = pendingArrangement.blocks;
      if (blocks.length < 2) return null;
      const currentIndex = Number.isInteger(canonical.structureState?.macroIndex)
        ? Math.min(blocks.length - 1, Math.max(0, canonical.structureState.macroIndex))
        : Math.max(0, blocks.indexOf(canonical.structureState?.activeBlockId));
      const nextMacroIndex = (currentIndex + 1) % blocks.length;
      return {
        nextMacroIndex,
        nextBlockId: blocks[nextMacroIndex]
      };
    }
    const blocks = traversal.macrostructure?.blocks ?? [];
    if (blocks.length < 2) return null;
    const nextMacroIndex = (derived.macroIndex + 1) % blocks.length;
    return {
      nextMacroIndex,
      nextBlockId: blocks[nextMacroIndex]
    };
  }

  function transactionalAdvanceEnabled() {
    return typeof beforeAdvance === "function" && typeof armAdvance === "function";
  }

  function transitionIsActive(activeBlockId, nextBlockId) {
    return lastActivationArm?.ok === true &&
      lastActivationArm.activeBlockId === activeBlockId &&
      lastActivationArm.nextBlockId === nextBlockId;
  }

  function commitTransition(next) {
    adoptPendingArrangement();
    store.updateStructureState({
      macroIndex: next.nextMacroIndex,
      activeBlockId: next.nextBlockId
    }, { sourceClientId: "macro-playback" });
    traversalMacroIndex = next.nextMacroIndex;
    traversalBlockId = next.nextBlockId;
    pendingCue = null;
    resetTransitionAttempt();
  }

  function holdAtCurrentBlock(witness, reason) {
    markCueMissed(reason);
    const score = traversalScore(store.getScore());
    macroStartIndex = traversalMacroIndex;
    macroStartOffsetBeats = cumulativeBeatsBeforeIndex(score, traversalMacroIndex);
    macroStartBeat = witness.absoluteBeat;
    activeBlockStartBeat = witness.absoluteBeat;
    activeBlockDurationBeats = macroBlockDurationBeats(score, config);
    activeBlockEndBeat = witness.absoluteBeat + activeBlockDurationBeats;
    compositionBeat = macroStartOffsetBeats;
    beatIntoBlock = 0;
    resetTransitionAttempt({ preserveCue: true });
  }

  function reanchorCommittedTransition(witness, committed, boundaryBeat) {
    const score = traversalScore(store.getScore());
    const anchor = Number.isFinite(boundaryBeat) ? boundaryBeat : witness.absoluteBeat;
    macroStartIndex = committed.nextMacroIndex;
    macroStartOffsetBeats = cumulativeBeatsBeforeIndex(score, committed.nextMacroIndex);
    macroStartBeat = anchor;
    activeBlockStartBeat = anchor;
    activeBlockDurationBeats = macroBlockDurationBeats(score, config);
    activeBlockEndBeat = anchor + activeBlockDurationBeats;
    const overshoot = Math.max(0, witness.absoluteBeat - anchor);
    compositionBeat = macroStartOffsetBeats + overshoot;
    beatIntoBlock = Math.min(activeBlockDurationBeats, overshoot);
  }

  function markCueMissed(error) {
    if (pendingCue) {
      pendingCue.state = "missed";
      pendingCue.error = error;
    }
  }

  function resetTransitionAttempt(options = {}) {
    transitionGeneration += 1;
    lastLookAheadKey = "";
    lookAheadPending = false;
    lookAheadPromise = null;
    lastLookAhead = null;
    lastActivationArmKey = "";
    activationArmPending = false;
    activationArmPromise = null;
    lastActivationArm = null;
    if (!options.preserveCue) pendingCue = null;
  }
}

function normalizeCueTarget(score, cueRequest) {
  const blockId = String(cueRequest.blockId ?? "").trim();
  if (!blockId || !score.mesostructure?.[blockId]) {
    throw new Error(`unknown mesostructural block '${blockId}'`);
  }
  const blocks = score.macrostructure?.blocks ?? [];
  const requestedIndex = Number(cueRequest.macroIndex);
  const macroIndex = Number.isInteger(requestedIndex) && blocks[requestedIndex] === blockId
    ? requestedIndex
    : blocks.indexOf(blockId);
  return {
    blockId,
    macroIndex: macroIndex >= 0 ? macroIndex : Math.max(0, Number(score.structureState?.macroIndex) || 0)
  };
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
  const tempo = activeWrittenTempo(score, finiteNumber(config.rnbo?.transport?.Tempo, 120));
  return durationMsAtTempo(beats, tempo);
}

function durationMsAtTempo(beats, tempo) {
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
