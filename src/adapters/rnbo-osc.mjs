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
  const compiled = compileScoreTransaction(score, config, transactionId);
  for (const message of compiled.messages) {
    await sendOscMessage(socket, config, message.values);
    if (config.rnbo.sendDelayMs > 0) {
      await delay(config.rnbo.sendDelayMs);
    }
  }
  if (config.rnbo.log !== false) {
    console.log(
      `[rnbo] sent score v${score.version} txn=${transactionId} notes=${compiled.noteCount} -> ${config.rnbo.host}:${config.rnbo.port}${config.rnbo.address}`
    );
  }
  return compiled;
}

export function compileScoreTransaction(score, config, transactionId) {
  const stagesPerBeat = clampInt(config.rnbo.stagesPerBeat, 1, 960);
  const notes = flattenScoreNotes(score);
  const selectionStart = readNumber(score.context.clip?.time_selection_start, 0);
  const selectionEnd = inferSelectionEnd(score, notes, selectionStart);
  const patternLength = clampInt((selectionEnd - selectionStart) * stagesPerBeat, 1, 2147483647);

  const messages = [
    {
      label: "BEGIN_REPLACE",
      values: [OPCODES.BEGIN_REPLACE, transactionId, 1, notes.length, patternLength, stagesPerBeat, 0]
    }
  ];

  notes.forEach((note, index) => {
    messages.push({
      label: `NOTE_${index}`,
      values: [
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
      ]
    });
  });

  messages.push({
    label: "COMMIT",
    values: [OPCODES.COMMIT, transactionId, notes.length, 0]
  });

  return {
    messages,
    noteCount: notes.length,
    patternLength,
    stagesPerBeat
  };
}

function flattenScoreNotes(score) {
  return Object.entries(score.voices)
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

async function sendOscMessage(socket, config, values) {
  const packet = encodeOscMessage(config.rnbo.address, values);
  await new Promise((resolve, reject) => {
    socket.send(packet, config.rnbo.port, config.rnbo.host, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
