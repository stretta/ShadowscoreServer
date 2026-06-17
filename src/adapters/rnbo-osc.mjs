import dgram from "node:dgram";
import { encodeOscMessage } from "./osc.mjs";

const OPCODES = Object.freeze({
  BEGIN_REPLACE: 1,
  NOTE: 20,
  COMMIT: 90
});

export function createRnboOscAdapter(config) {
  if (!config.rnbo.enabled) {
    return {
      enabled: false,
      attach() {},
      close() {}
    };
  }

  const socket = dgram.createSocket("udp4");
  let transactionId = Number(config.rnbo.transactionStart) || 1000;

  return {
    enabled: true,
    attach(store) {
      store.events.on("change", (event) => {
        if (!shouldSendScoreTransaction(event)) {
          return;
        }
        void sendScoreTransaction(socket, config, event.score, nextTransactionId()).catch((error) => {
          console.error(`[rnbo] send failed: ${messageForError(error)}`);
        });
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // Closing an idle dgram socket can throw on some Node versions.
      }
    }
  };

  function nextTransactionId() {
    transactionId += 1;
    return transactionId;
  }
}

export async function sendScoreTransaction(socket, config, score, transactionId) {
  const targets = rnboTargets(config, score);
  const compiledTargets = [];

  for (const target of targets) {
    const compiled = compileScoreTransaction(score, config, transactionId, target);
    for (const message of compiled.messages) {
      await sendOscMessage(socket, config, target, message.values);
      if (config.rnbo.sendDelayMs > 0) {
        await delay(config.rnbo.sendDelayMs);
      }
    }
    compiledTargets.push({ target, compiled });
    if (config.rnbo.log !== false) {
      console.log(
        `[rnbo] sent score v${score.version} txn=${transactionId} voice=${target.voiceId ?? "*"} notes=${compiled.noteCount} -> ${target.host}:${target.port}${target.address}`
      );
    }
  }

  return compiledTargets.length === 1 ? compiledTargets[0].compiled : { targets: compiledTargets };
}

export function shouldSendScoreTransaction(event) {
  return Boolean(
    event.type === "context.updated" ||
    event.type === "voice.notes.replaced" ||
    (event.type === "admin.reset" && (event.detail?.context || event.detail?.voices))
  );
}

export function compileScoreTransaction(score, config, transactionId, target = rnboTargets(config, score)[0]) {
  const stagesPerBeat = clampInt(config.rnbo.stagesPerBeat, 1, 960);
  const notes = flattenScoreNotes(score, target.voiceId);
  const selectionStart = readNumber(score.context.clip?.time_selection_start, 0);
  const selectionEnd = inferSelectionEnd(score, notes, selectionStart);
  const patternLength = clampInt((selectionEnd - selectionStart) * stagesPerBeat, 1, 2147483647);
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
    stagesPerBeat
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

function inferSelectionEnd(score, notes, selectionStart) {
  const configuredEnd = score.context.clip?.time_selection_end;
  if (typeof configuredEnd === "number" && configuredEnd > selectionStart) {
    return configuredEnd;
  }
  const lastNoteEnd = Math.max(
    selectionStart + 4,
    ...notes.map((note) => readNumber(note.start_time, 0) + Math.max(0, readNumber(note.duration, 0)))
  );
  return lastNoteEnd;
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

function rnboTargets(config, score) {
  const assignedTargets = assignmentRnboTargets(config, score);
  if (assignedTargets.length > 0) {
    return assignedTargets;
  }
  if (Array.isArray(config.rnbo.targets) && config.rnbo.targets.length > 0) {
    return config.rnbo.targets.map((target) => ({
      host: target.host ?? config.rnbo.host,
      port: target.port ?? config.rnbo.port,
      address: target.address ?? config.rnbo.address,
      voiceId: target.voiceId,
      clientId: target.clientId
    }));
  }
  return [
    {
      host: config.rnbo.host,
      port: config.rnbo.port,
      address: config.rnbo.address,
      clientId: config.rnbo.clientId
    }
  ];
}

function assignmentRnboTargets(config, score) {
  if (!score?.assignments) {
    return [];
  }
  return Object.entries(score.assignments)
    .filter(([, assignment]) => assignment?.rnboAddress)
    .map(([voiceId, assignment]) => ({
      host: assignment.rnboHost || config.rnbo.host,
      port: assignment.rnboPort ?? config.rnbo.port,
      address: assignment.rnboAddress,
      voiceId,
      clientId: assignment.clientId ?? undefined,
      id: assignment.rnboTargetId || undefined
    }));
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
