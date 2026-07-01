import dgram from "node:dgram";
import { encodeOscMessage } from "./osc.mjs";
import { discoverRnboTargets } from "./rnbo-oscquery.mjs";
import { rnboPlaybackCapabilities } from "../playback/target-capabilities.mjs";

const OPCODES = Object.freeze({
  BEGIN_REPLACE: 1,
  NOTE: 20,
  COMMIT: 90
});

export function createRnboOscAdapter(config, runtime = {}) {
  if (!config.rnbo.enabled) {
    return {
      enabled: false,
      attach() {},
      close() {}
    };
  }

  const socket = dgram.createSocket("udp4");
  let transactionId = Number(config.rnbo.transactionStart) || 1000;
  let store;
  let discoveryTimer;
  let lastTargetSignature = "";
  let discoveryCheckPending = false;

  const adapter = {
    enabled: true,
    attach(nextStore) {
      store = nextStore;
      store.events.on("change", (event) => {
        if (!shouldSendScoreTransaction(event)) {
          return;
        }
        void resendScore(event.score).catch((error) => {
          console.error(`[rnbo] send failed: ${messageForError(error)}`);
        });
      });
      startTargetDiscoveryMonitor();
    },
    resendCurrentScore(reason = "manual") {
      if (!store) {
        return Promise.reject(new Error("RNBO adapter is not attached to a score store"));
      }
      return resendScore(store.getScore(), reason);
    },
    close() {
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = undefined;
      }
      try {
        socket.close();
      } catch {
        // Closing an idle dgram socket can throw on some Node versions.
      }
    }
  };
  return adapter;

  function nextTransactionId() {
    transactionId += 1;
    return transactionId;
  }

  async function resendScore(score, reason = "") {
    const result = await sendScoreTransaction(socket, config, score, nextTransactionId(), { runtime });
    if (reason && config.rnbo.log !== false) {
      console.log(`[rnbo] resend reason=${reason}`);
    }
    return result;
  }

  function startTargetDiscoveryMonitor() {
    const intervalMs = Number(config.rnbo.discoveryResendIntervalMs ?? 5000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || discoveryTimer) {
      return;
    }
    void checkTargetDiscovery();
    discoveryTimer = setInterval(() => {
      void checkTargetDiscovery();
    }, intervalMs);
    discoveryTimer.unref?.();
  }

  async function checkTargetDiscovery() {
    if (!store || discoveryCheckPending) {
      return;
    }
    discoveryCheckPending = true;
    try {
      const liveTargets = await readLiveRnboTargets(config, runtime);
      const signature = rnboTargetSignature(liveTargets);
      if (signature && signature !== lastTargetSignature) {
        lastTargetSignature = signature;
        await resendScore(store.getScore(), "target-discovery");
      } else {
        lastTargetSignature = signature;
      }
    } catch (error) {
      console.error(`[rnbo] target discovery resend check failed: ${messageForError(error)}`);
    } finally {
      discoveryCheckPending = false;
    }
  }
}

export async function sendScoreTransaction(socket, config, score, transactionId, options = {}) {
  const targets = await rnboTargetsForSend(config, score, options.runtime);
  const compiledTargets = [];

  for (const target of targets) {
    const compiled = compileScoreTransaction(score, config, transactionId, target);
    for (const message of compiled.messages) {
      await sendOscMessage(socket, config, target, message.values);
      if (config.rnbo.sendDelayMs > 0) {
        await delay(config.rnbo.sendDelayMs);
      }
    }
    for (const message of scoreTransportInportMessages(config, compiled)) {
      await sendOscInportMessage(socket, target, message.name, message.value);
      if (config.rnbo.sendDelayMs > 0) {
        await delay(config.rnbo.sendDelayMs);
      }
    }
    compiledTargets.push({ target, compiled });
    if (config.rnbo.log !== false) {
      console.log(
        `[rnbo] sent score v${score.version} txn=${transactionId} voice=${target.voiceId ?? "*"} notes=${compiled.noteCount} maxSteps=${compiled.patternLength} -> ${target.host}:${target.port}${target.address}`
      );
    }
  }

  return compiledTargets.length === 1 ? compiledTargets[0].compiled : { targets: compiledTargets };
}

async function rnboTargetsForSend(config, score, runtime = {}) {
  const liveTargets = await readLiveRnboTargets(config, runtime);
  return rnboTargets(config, score, liveTargets);
}

async function readLiveRnboTargets(config, runtime = {}) {
  const localTargets = await discoverRnboTargets(config).catch(() => []);
  const peerTargets = runtime.peerRegistry?.targets?.() ?? [];
  return [...localTargets, ...peerTargets];
}

export function rnboTargetSignature(targets = []) {
  return targets
    .map((target) => [
      target.id ?? "",
      target.localId ?? "",
      target.instanceId ?? "",
      target.host ?? "",
      target.port ?? "",
      target.address ?? "",
      target.messagePath ?? "",
      target.available === false ? "offline" : "online",
      target.capabilities?.maxStages ?? "",
      target.capabilities?.maxNoteRows ?? "",
      target.capabilities?.noteDataFloatCount ?? ""
    ].join("\u001f"))
    .sort()
    .join("\u001e");
}

export function scoreTransportInportMessages(config, compiled) {
  const transport = config.rnbo?.transport ?? {};
  const messages = [
    { name: "ClockInterval", value: finiteNumber(compiled.timing?.ticksPerStage, finiteNumber(transport.ClockInterval, 120)) },
    { name: "MaxSteps", value: compiled.patternLength }
  ];
  if (tempoAuthority(config) === "server") {
    messages.unshift({ name: "Tempo", value: finiteNumber(transport.Tempo, 120) });
  }
  return messages;
}

export function tempoAuthority(config) {
  return config.transport?.tempoAuthority === "server" ? "server" : "link";
}

export function shouldSendScoreTransaction(event) {
  return Boolean(
    event.type === "context.updated" ||
    event.type === "clip.added" ||
    event.type === "clip.replaced" ||
    event.type === "clip.renamed" ||
    event.type === "clip.removed" ||
    event.type === "mesostructure.block.replaced" ||
    event.type === "mesostructure.block.removed" ||
    event.type === "macrostructure.updated" ||
    event.type === "structure.playhead.updated" ||
    event.type === "voice.notes.replaced" ||
    event.type === "voice.assignment.replaced" ||
    event.type === "admin.legacyVoiceNotes.imported" ||
    (event.type === "admin.reset" && (event.detail?.context || event.detail?.voices || event.detail?.assignments || event.detail?.structure || event.detail?.notes))
  );
}

export function compileTimingContract(score, config, target = rnboTargets(config, score)[0], options = {}) {
  const resolution = config.rnbo?.resolution ?? {};
  const mode = resolutionMode(resolution.mode);
  const maxStages = clampInt(target?.capabilities?.maxStages ?? resolution.maxStages ?? 4096, 1, 2147483647);
  const maxNoteRows = clampInt(target?.capabilities?.maxNoteRows ?? resolution.maxNoteRows ?? 819, 1, 2147483647);
  const selectionStart = readNumber(options.selectionStart, 0);
  const selectionEnd = readNumber(options.selectionEnd, selectionStart + readNumber(options.blockBeats, 0));
  const blockBeats = Math.max(0, selectionEnd - selectionStart);
  const selected = chooseTimingResolution(mode, resolution, config, blockBeats, maxStages, options.notes ?? [], selectionStart);
  const stagesPerBeat = selected.stagesPerBeat;
  const patternLength = clampInt((selectionEnd - selectionStart) * stagesPerBeat, 1, 2147483647);
  const ticksPerStage = 480 / stagesPerBeat;

  return {
    blockId: stringField(options.blockId, ""),
    stagesPerBeat,
    ticksPerStage,
    patternLength,
    maxStages,
    maxNoteRows,
    resolutionMode: mode,
    quantizationError: selected.quantizationError
  };
}

export function compileScoreTransaction(score, config, transactionId, target = rnboTargets(config, score)[0]) {
  const activeBlock = activeMesoBlock(score);
  const activeBlockId = activeMesoBlockId(score);
  const selectionStart = readNumber(score.context.clip?.time_selection_start, 0);
  const blockBeats = blockDurationBeats(activeBlock, score.context);
  const notes = activeBlock ? flattenBlockNotes(score, activeBlock, target.voiceId, blockBeats) : flattenScoreNotes(score, target.voiceId);
  const selectionEnd = inferSelectionEnd(score, notes, selectionStart, activeBlock);
  const timing = compileTimingContract(score, config, target, {
    blockId: activeBlock ? activeBlockId : "",
    blockBeats,
    notes,
    selectionStart,
    selectionEnd
  });
  const { patternLength, stagesPerBeat } = timing;
  const prefix = target.clientId === undefined ? [] : [clampInt(target.clientId, 0, 2147483647)];

  const clearRowCount = clampInt(config.rnbo.clearRowCount ?? 0, 0, 1024);
  const transmittedRowCount = Math.max(notes.length, clearRowCount);
  const messages = [
    {
      label: "BEGIN_REPLACE",
      values: [...prefix, OPCODES.BEGIN_REPLACE, transactionId, 1, transmittedRowCount, patternLength, stagesPerBeat, 0]
    }
  ];

  for (let index = 0; index < transmittedRowCount; index += 1) {
    const note = notes[index];
    messages.push({
      label: note ? `NOTE_${index}` : `CLEAR_${index}`,
      values: noteValues(prefix, transactionId, index, note, selectionStart, stagesPerBeat)
    });
  }

  messages.push({
    label: "COMMIT",
    values: [...prefix, OPCODES.COMMIT, transactionId, transmittedRowCount, 0]
  });

  return {
    messages,
    noteCount: notes.length,
    transmittedRowCount,
    patternLength,
    stagesPerBeat,
    timing
  };
}

function noteValues(prefix, transactionId, index, note, selectionStart, stagesPerBeat) {
  if (!note) {
    return [
      ...prefix,
      OPCODES.NOTE,
      transactionId,
      index,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      64
    ];
  }

  return [
    ...prefix,
    OPCODES.NOTE,
    transactionId,
    index,
    clampInt(note.note_id ?? index + 1, 0, 2147483647),
    clampInt(note.pitch, 0, 127),
    clampInt((readNumber(note.start_time, 0) - selectionStart) * stagesPerBeat, 0, 2147483647),
    clampInt(readNumber(note.duration, 0) * stagesPerBeat, 1, 2147483647),
    clampInt(note.velocity, 0, 127),
    clampInt(note.mute ?? 0, 0, 1),
    clampInt(readNumber(note.probability, 1) * 10000, 0, 10000),
    clampInt(note.velocity_deviation ?? 0, 0, 127),
    clampInt(note.release_velocity ?? 64, 0, 127)
  ];
}

function chooseTimingResolution(mode, resolution, config, blockBeats, maxStages, notes, selectionStart) {
  const fixedStagesPerBeat = clampInt(resolution.defaultStagesPerBeat ?? config.rnbo?.stagesPerBeat ?? 16, 1, 960);
  if (mode !== "fit" && mode !== "fidelity" && mode !== "hybrid") {
    return { stagesPerBeat: fixedStagesPerBeat, quantizationError: null };
  }

  const candidates = stageCandidates(resolution.candidateStagesPerBeat);
  const maxFitStagesPerBeat = blockBeats > 0 ? Math.floor(maxStages / blockBeats) : maxStages;
  const fitting = candidates.filter((candidate) => candidate <= maxFitStagesPerBeat);
  const fallback = fitting.at(-1) ?? candidates[0] ?? fixedStagesPerBeat;

  if (mode === "fit") {
    return { stagesPerBeat: fallback, quantizationError: null };
  }

  const targetBeats = finiteNumber(resolution.quantizationErrorTargetBeats, 1 / 480);
  const scored = (fitting.length ? fitting : [fallback]).map((candidate) => ({
    stagesPerBeat: candidate,
    quantizationError: quantizationErrorForCandidate(candidate, notes, selectionStart, targetBeats)
  }));
  const acceptable = scored.find((candidate) => candidate.quantizationError.worstBeats <= targetBeats);
  if (acceptable) {
    return acceptable;
  }
  if (mode === "hybrid") {
    return scored.at(-1);
  }
  return [...scored].sort(compareQuantizationScores)[0];
}

function stageCandidates(values) {
  const candidates = Array.isArray(values) ? values : [];
  return [...new Set(candidates.map((value) => clampInt(value, 1, 480)).filter((value) => 480 % value === 0))]
    .sort((a, b) => a - b);
}

function quantizationErrorForCandidate(stagesPerBeat, notes, selectionStart, targetBeats) {
  const values = notes.flatMap((note) => [
    { type: "onset", value: readNumber(note.start_time, 0) - selectionStart },
    { type: "duration", value: readNumber(note.duration, 0) }
  ]);
  if (values.length === 0) {
    return {
      targetBeats,
      noteCount: 0,
      worstBeats: 0,
      worstOnsetBeats: 0,
      worstDurationBeats: 0,
      meanAbsoluteBeats: 0,
      meanSignedOnsetBeats: 0,
      meanSignedDurationBeats: 0
    };
  }

  let absoluteTotal = 0;
  let onsetSignedTotal = 0;
  let onsetCount = 0;
  let durationSignedTotal = 0;
  let durationCount = 0;
  let worstOnsetBeats = 0;
  let worstDurationBeats = 0;

  for (const entry of values) {
    const quantized = Math.round(entry.value * stagesPerBeat) / stagesPerBeat;
    const signed = quantized - entry.value;
    const absolute = Math.abs(signed);
    absoluteTotal += absolute;
    if (entry.type === "onset") {
      onsetSignedTotal += signed;
      onsetCount += 1;
      worstOnsetBeats = Math.max(worstOnsetBeats, absolute);
    } else {
      durationSignedTotal += signed;
      durationCount += 1;
      worstDurationBeats = Math.max(worstDurationBeats, absolute);
    }
  }

  return {
    targetBeats,
    noteCount: notes.length,
    worstBeats: roundBeat(Math.max(worstOnsetBeats, worstDurationBeats)),
    worstOnsetBeats: roundBeat(worstOnsetBeats),
    worstDurationBeats: roundBeat(worstDurationBeats),
    meanAbsoluteBeats: roundBeat(absoluteTotal / values.length),
    meanSignedOnsetBeats: roundBeat(onsetCount ? onsetSignedTotal / onsetCount : 0),
    meanSignedDurationBeats: roundBeat(durationCount ? durationSignedTotal / durationCount : 0)
  };
}

function compareQuantizationScores(a, b) {
  return a.quantizationError.worstBeats - b.quantizationError.worstBeats ||
    a.quantizationError.meanAbsoluteBeats - b.quantizationError.meanAbsoluteBeats ||
    a.stagesPerBeat - b.stagesPerBeat;
}

function usesDerivedClock(mode) {
  return mode === "fit" || mode === "fidelity" || mode === "hybrid";
}

function resolutionMode(value) {
  return ["fixed", "fit", "fidelity", "hybrid"].includes(value) ? value : "fixed";
}

function roundBeat(value) {
  return Math.round(value * 1e12) / 1e12;
}

function flattenScoreNotes(score, voiceFilter) {
  return Object.entries(score.voices)
    .filter(([voiceId]) => voiceFilter === undefined || voiceId === voiceFilter)
    .flatMap(([voiceId, voice]) =>
      voice.notes.map((note, voiceIndex) => ({
        ...note,
        voiceId,
        voiceIndex
      }))
    )
    .sort((a, b) => readNumber(a.start_time, 0) - readNumber(b.start_time, 0) || readNumber(a.pitch, 0) - readNumber(b.pitch, 0));
}

function flattenBlockNotes(score, block, voiceFilter, blockBeats = 0) {
  return Object.entries(block.players ?? {})
    .filter(([voiceId]) => voiceFilter === undefined || voiceId === voiceFilter)
    .flatMap(([voiceId, assignment]) => {
      const clipId = mesoPlayerClipId(assignment);
      const clip = score.clips?.[clipId];
      return expandClipNotes(clip, {
        voiceId,
        clipId,
        blockBeats,
        context: score.context
      });
    })
    .sort((a, b) => readNumber(a.start_time, 0) - readNumber(b.start_time, 0) || readNumber(a.pitch, 0) - readNumber(b.pitch, 0));
}

function expandClipNotes(clip, { voiceId, clipId, blockBeats, context }) {
  if (!clip) {
    return [];
  }
  const clipNotes = clip.notes ?? [];
  const clipBeats = clipDurationBeats(clip, context);
  const playbackType = clip.playbackType === "one-shot" ? "one-shot" : "looped";
  if (playbackType === "one-shot" || blockBeats <= 0 || clipBeats <= 0) {
    return clipNotes.map((note, voiceIndex) => ({
      ...note,
      voiceId,
      clipId,
      voiceIndex
    }));
  }

  const notes = [];
  for (let offset = 0, iteration = 0; offset < blockBeats; offset += clipBeats, iteration += 1) {
    for (let voiceIndex = 0; voiceIndex < clipNotes.length; voiceIndex += 1) {
      const note = clipNotes[voiceIndex];
      const start = readNumber(note.start_time, 0) + offset;
      if (start >= blockBeats) {
        continue;
      }
      const duration = Math.min(Math.max(0, readNumber(note.duration, 0)), Math.max(0, blockBeats - start));
      if (duration <= 0) {
        continue;
      }
      notes.push({
        ...note,
        note_id: note.note_id === undefined ? undefined : readNumber(note.note_id, voiceIndex + 1) + iteration * clipNotes.length,
        start_time: start,
        duration,
        voiceId,
        clipId,
        voiceIndex
      });
    }
  }
  return notes;
}

function activeMesoBlock(score) {
  const blockId = activeMesoBlockId(score);
  const block = blockId ? score.mesostructure?.[blockId] : undefined;
  if (!block) {
    return undefined;
  }
  const hasAssignedClips = Object.values(block.players ?? {}).some((assignment) => score.clips?.[mesoPlayerClipId(assignment)]);
  return hasAssignedClips ? block : undefined;
}

function activeMesoBlockId(score) {
  return score.structureState?.activeBlockId ?? score.macrostructure?.blocks?.[0] ?? "";
}

function mesoPlayerClipId(assignment) {
  return typeof assignment === "string" ? assignment : assignment?.clipId;
}

function inferSelectionEnd(score, notes, selectionStart, activeBlock) {
  const configuredEnd = score.context.clip?.time_selection_end;
  if (typeof configuredEnd === "number" && configuredEnd > selectionStart) {
    return configuredEnd;
  }
  const blockBeats = blockDurationBeats(activeBlock, score.context);
  if (blockBeats > 0) {
    return selectionStart + blockBeats;
  }
  const lastNoteEnd = Math.max(
    selectionStart + 4,
    ...notes.map((note) => readNumber(note.start_time, 0) + Math.max(0, readNumber(note.duration, 0)))
  );
  return lastNoteEnd;
}

function blockDurationBeats(block, context) {
  return durationBeats(block?.duration, context);
}

function clipDurationBeats(clip, context) {
  const configured = durationBeats(clip?.duration, clip?.context ?? context);
  if (configured > 0) {
    return configured;
  }
  const contextClip = clip?.context?.clip;
  if (typeof contextClip?.time_selection_start === "number" && typeof contextClip.time_selection_end === "number" && contextClip.time_selection_end > contextClip.time_selection_start) {
    return contextClip.time_selection_end - contextClip.time_selection_start;
  }
  return Math.max(0, ...(clip?.notes ?? []).map((note) => readNumber(note.start_time, 0) + Math.max(0, readNumber(note.duration, 0))));
}

function durationBeats(duration, context) {
  if (!duration) {
    return 0;
  }
  if (Number.isFinite(duration.beats)) {
    return Number(duration.beats);
  }
  if (Number.isFinite(duration.bars)) {
    const numerator = readNumber(context?.clip?.TimeSignature?.numerator, 4);
    return Number(duration.bars) * Math.max(1, numerator);
  }
  return 0;
}

async function sendOscMessage(socket, config, target, values) {
  const packet = encodeOscMessage(target.address, values);
  await new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.host, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sendOscInportMessage(socket, target, name, value) {
  const instanceId = readInstanceId(target.address);
  if (!instanceId) {
    throw new Error(`RNBO target '${target.id ?? ""}' does not include an instance id`);
  }
  const packet = encodeOscMessage(`/rnbo/inst/${instanceId}/messages/in/${name}`, [value]);
  await new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.host, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function rnboTargets(config, score, liveTargets = []) {
  const assignedTargets = assignmentRnboTargets(config, score, liveTargets);
  if (assignedTargets.length > 0) {
    return assignedTargets;
  }
  if (Array.isArray(config.rnbo.targets) && config.rnbo.targets.length > 0) {
    return config.rnbo.targets.map((target) => ({
      host: target.host ?? config.rnbo.host,
      port: target.port ?? config.rnbo.port,
      address: target.address ?? config.rnbo.address,
      voiceId: target.voiceId,
      clientId: target.clientId,
      capabilities: rnboPlaybackCapabilities(config, target.capabilities)
    }));
  }
  return [
    {
      host: config.rnbo.host,
      port: config.rnbo.port,
      address: config.rnbo.address,
      clientId: config.rnbo.clientId,
      capabilities: rnboPlaybackCapabilities(config)
    }
  ];
}

function assignmentRnboTargets(config, score, liveTargets = []) {
  if (!score?.assignments) {
    return [];
  }
  return Object.entries(score.assignments)
    .filter(([, assignment]) => assignment?.rnboAddress)
    .map(([voiceId, assignment]) => {
      const configuredTarget = liveTargetForAssignment(liveTargets, assignment) ?? configuredTargetForAssignment(config, assignment);
      return {
        host: configuredTarget?.host ?? assignment.rnboHost ?? config.rnbo.host,
        port: configuredTarget?.port ?? assignment.rnboPort ?? config.rnbo.port,
        address: configuredTarget?.address ?? assignment.rnboAddress,
        voiceId,
        clientId: assignment.clientId ?? configuredTarget?.clientId,
        id: assignment.rnboTargetId || undefined,
        capabilities: rnboPlaybackCapabilities(config, configuredTarget?.capabilities)
      };
    });
}

function liveTargetForAssignment(targets, assignment) {
  return targets.find((target) => {
    if (assignment.rnboTargetId && (target.id === assignment.rnboTargetId || target.localId === assignment.rnboTargetId)) {
      return true;
    }
    return target.address === assignment.rnboAddress &&
      String(target.host ?? "") === String(assignment.rnboHost || "") &&
      Number(target.port) === Number(assignment.rnboPort);
  });
}

function configuredTargetForAssignment(config, assignment) {
  return (config.rnbo?.targets ?? []).find((target) => {
    if (assignment.rnboTargetId && target.id === assignment.rnboTargetId) {
      return true;
    }
    return target.address === assignment.rnboAddress &&
      String(target.host ?? config.rnbo?.host ?? "") === String(assignment.rnboHost || config.rnbo?.host || "") &&
      Number(target.port ?? config.rnbo?.port) === Number(assignment.rnboPort ?? config.rnbo?.port);
  });
}

function readNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampInt(value, min, max) {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) {
    return min;
  }
  return Math.min(max, Math.max(min, rounded));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringField(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readInstanceId(address) {
  const match = String(address ?? "").match(/\/rnbo\/inst\/([^/]+)/);
  return match ? match[1] : "";
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
