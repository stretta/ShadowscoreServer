import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function loadPersistedScore(config, fallbackScore) {
  if (!config.persistence?.enabled) {
    return structuredClone(fallbackScore);
  }

  const scorePath = resolvePath(config.persistence.path);
  try {
    const raw = await fs.readFile(scorePath, "utf8");
    const persisted = JSON.parse(raw);
    assertScoreShape(persisted);
    return reconcileScore(config, fallbackScore, persisted);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return structuredClone(fallbackScore);
    }
    throw new Error(`failed to load persisted score from ${scorePath}: ${messageForError(error)}`);
  }
}

export function createScorePersistence(store, config) {
  if (!config.persistence?.enabled) {
    return {
      enabled: false,
      flush: async () => {},
      close: async () => {}
    };
  }

  const scorePath = resolvePath(config.persistence.path);
  const backupPath = config.persistence.backupPath ? resolvePath(config.persistence.backupPath) : undefined;
  const debounceMs = Math.max(0, Number(config.persistence.debounceMs) || 0);
  let pendingScore;
  let timer;
  let writeChain = Promise.resolve();

  const schedule = (event) => {
    pendingScore = event.score;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      const score = pendingScore;
      pendingScore = undefined;
      writeChain = writeChain.then(() => writeScoreSnapshot(scorePath, score, { backupPath }));
    }, debounceMs);
  };

  store.events.on("change", schedule);

  return {
    enabled: true,
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pendingScore) {
        const score = pendingScore;
        pendingScore = undefined;
        writeChain = writeChain.then(() => writeScoreSnapshot(scorePath, score, { backupPath }));
      }
      await writeChain;
    },
    async close() {
      store.events.off("change", schedule);
      await this.flush();
    }
  };
}

export async function writeScoreSnapshot(scorePath, score, options = {}) {
  assertScoreShape(score);
  const resolvedScorePath = resolvePath(scorePath);
  const directory = path.dirname(resolvedScorePath);
  const tempPath = path.join(directory, `.${path.basename(resolvedScorePath)}.${randomUUID()}.tmp`);

  await fs.mkdir(directory, { recursive: true });
  if (options.backupPath) {
    await backupExistingSnapshot(resolvedScorePath, resolvePath(options.backupPath));
  }
  await fs.writeFile(tempPath, `${JSON.stringify(score, null, 2)}\n`);
  await fs.rename(tempPath, resolvedScorePath);
}

export function reconcileScore(config, fallbackScore, persistedScore) {
  assertScoreShape(persistedScore);

  const voices = structuredClone(persistedScore.voices);
  const assignments = {
    ...structuredClone(fallbackScore.assignments ?? {}),
    ...structuredClone(persistedScore.assignments ?? {})
  };

  for (const voiceId of config.ensemble.voices) {
    if (!voices[voiceId]) {
      voices[voiceId] = structuredClone(fallbackScore.voices[voiceId] ?? { version: 0, notes: [] });
    }
    if (!assignments[voiceId]) {
      assignments[voiceId] = structuredClone(fallbackScore.assignments?.[voiceId] ?? createEmptyAssignment());
    }
  }

  return {
    ensembleId: config.ensemble.id,
    version: persistedScore.version,
    context: structuredClone(persistedScore.context),
    assignments,
    voices
  };
}

export function assertScoreShape(score) {
  if (!score || typeof score !== "object" || Array.isArray(score)) {
    throw new Error("score must be an object");
  }
  if (typeof score.ensembleId !== "string") {
    throw new Error("score.ensembleId must be a string");
  }
  if (!Number.isFinite(score.version)) {
    throw new Error("score.version must be numeric");
  }
  if (!isPlainObject(score.context)) {
    throw new Error("score.context must be an object");
  }
  if (!isPlainObject(score.voices)) {
    throw new Error("score.voices must be an object");
  }
  if (score.assignments !== undefined && !isPlainObject(score.assignments)) {
    throw new Error("score.assignments must be an object");
  }
  for (const [voiceId, assignment] of Object.entries(score.assignments ?? {})) {
    if (!isPlainObject(assignment)) {
      throw new Error(`assignment ${voiceId} must be an object`);
    }
    for (const field of ["assignee", "deviceId", "rnboTargetId", "rnboHost", "rnboAddress", "label", "color"]) {
      if (assignment[field] !== undefined && typeof assignment[field] !== "string") {
        throw new Error(`assignment ${voiceId}.${field} must be a string`);
      }
    }
    if (
      assignment.clientId !== undefined &&
      assignment.clientId !== null &&
      typeof assignment.clientId !== "string" &&
      typeof assignment.clientId !== "number"
    ) {
      throw new Error(`assignment ${voiceId}.clientId must be a string, number, or null`);
    }
    if (
      assignment.rnboPort !== undefined &&
      assignment.rnboPort !== null &&
      typeof assignment.rnboPort !== "number"
    ) {
      throw new Error(`assignment ${voiceId}.rnboPort must be a number or null`);
    }
    if (assignment.locked !== undefined && typeof assignment.locked !== "boolean") {
      throw new Error(`assignment ${voiceId}.locked must be boolean`);
    }
  }
  for (const [voiceId, voice] of Object.entries(score.voices)) {
    if (!isPlainObject(voice)) {
      throw new Error(`voice ${voiceId} must be an object`);
    }
    if (!Number.isFinite(voice.version)) {
      throw new Error(`voice ${voiceId}.version must be numeric`);
    }
    if (!Array.isArray(voice.notes)) {
      throw new Error(`voice ${voiceId}.notes must be an array`);
    }
  }
}

async function backupExistingSnapshot(scorePath, backupPath) {
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(scorePath, backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function resolvePath(filePath) {
  return path.resolve(filePath);
}

function createEmptyAssignment() {
  return {
    assignee: "",
    deviceId: "",
    clientId: null,
    label: "",
    color: "",
    locked: false
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
