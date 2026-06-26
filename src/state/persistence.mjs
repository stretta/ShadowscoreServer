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

export async function listSavedScores(config) {
  const directory = scoreLibraryDirectory(config);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const scores = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const id = entry.name.slice(0, -5);
      try {
        const filePath = path.join(directory, entry.name);
        const [stat, score] = await Promise.all([
          fs.stat(filePath),
          readScoreSnapshot(filePath)
        ]);
        scores.push({
          id,
          name: typeof score.savedScoreName === "string" && score.savedScoreName.trim() ? score.savedScoreName.trim() : id,
          savedAt: typeof score.savedAt === "string" ? score.savedAt : stat.mtime.toISOString(),
          ensembleId: score.ensembleId,
          version: score.version
        });
      } catch {
        // Ignore malformed library entries so one bad file does not hide the rest.
      }
    }
    return scores.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function saveScoreToLibrary(config, score, options = {}) {
  assertScoreShape(score);
  const name = scoreLibraryName(options.name);
  const savedAt = new Date().toISOString();
  const id = await uniqueSavedScoreId(scoreLibraryDirectory(config), `${slugify(name)}-${savedAt.replace(/[:.]/g, "-")}`);
  const filePath = savedScorePath(config, id);
  await writeScoreSnapshot(filePath, {
    ...structuredClone(score),
    savedScoreName: name,
    savedAt
  });
  return {
    id,
    name,
    savedAt,
    ensembleId: score.ensembleId,
    version: score.version
  };
}

export async function loadScoreFromLibrary(config, id) {
  return readScoreSnapshot(savedScorePath(config, id));
}

export async function deleteScoreFromLibrary(config, id) {
  await fs.unlink(savedScorePath(config, id));
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
    clips: normalizePersistedClips(persistedScore.clips ?? fallbackScore.clips ?? {}),
    mesostructure: structuredClone(persistedScore.mesostructure ?? fallbackScore.mesostructure ?? {}),
    macrostructure: structuredClone(persistedScore.macrostructure ?? fallbackScore.macrostructure ?? {}),
    structureState: normalizePersistedStructureState(persistedScore.structureState ?? fallbackScore.structureState ?? {}, persistedScore.mesostructure ?? fallbackScore.mesostructure ?? {}, persistedScore.macrostructure ?? fallbackScore.macrostructure ?? {}),
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
  if (score.clips !== undefined && !isPlainObject(score.clips)) {
    throw new Error("score.clips must be an object");
  }
  if (score.mesostructure !== undefined && !isPlainObject(score.mesostructure)) {
    throw new Error("score.mesostructure must be an object");
  }
  if (score.macrostructure !== undefined && !isPlainObject(score.macrostructure)) {
    throw new Error("score.macrostructure must be an object");
  }
  if (score.structureState !== undefined && !isPlainObject(score.structureState)) {
    throw new Error("score.structureState must be an object");
  }
  if (score.macrostructure !== undefined) {
    if (!Number.isFinite(score.macrostructure.tempo)) {
      throw new Error("score.macrostructure.tempo must be numeric");
    }
    if (!Array.isArray(score.macrostructure.blocks)) {
      throw new Error("score.macrostructure.blocks must be an array");
    }
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

async function readScoreSnapshot(scorePath) {
  const raw = await fs.readFile(scorePath, "utf8");
  const score = JSON.parse(raw);
  assertScoreShape(score);
  return score;
}

function scoreLibraryDirectory(config) {
  return resolvePath(config.persistence?.libraryPath ?? "data/scores");
}

function savedScorePath(config, id) {
  return path.join(scoreLibraryDirectory(config), `${scoreLibraryId(id)}.json`);
}

function scoreLibraryName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name || "Untitled score";
}

function scoreLibraryId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("saved score id must contain only letters, numbers, dots, dashes, and underscores");
  }
  return id;
}

async function uniqueSavedScoreId(directory, baseId) {
  let id = scoreLibraryId(baseId);
  for (let index = 2; ; index += 1) {
    try {
      await fs.access(path.join(directory, `${id}.json`));
      id = scoreLibraryId(`${baseId}-${index}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return id;
      }
      throw error;
    }
  }
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "score";
}

function normalizePersistedClips(clips) {
  if (!isPlainObject(clips)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(clips).map(([clipId, clip]) => [
      clipId,
      {
        ...structuredClone(clip),
        notes: Array.isArray(clip?.notes) ? structuredClone(clip.notes) : [],
        context: isPlainObject(clip?.context) ? structuredClone(clip.context) : { clip: {}, scale: {}, grid: {}, seed: 0 },
        duration: isPlainObject(clip?.duration) ? structuredClone(clip.duration) : {},
        playbackType: clip?.playbackType === "one-shot" ? "one-shot" : "looped",
        behavior: isPlainObject(clip?.behavior) ? structuredClone(clip.behavior) : {}
      }
    ])
  );
}

function normalizePersistedStructureState(structureState, mesostructure, macrostructure) {
  const blocks = Array.isArray(macrostructure?.blocks) ? macrostructure.blocks : [];
  const fallbackBlockId = blocks.find((blockId) => mesostructure?.[blockId]) ?? Object.keys(mesostructure ?? {})[0] ?? "";
  const activeBlockId = typeof structureState?.activeBlockId === "string" && mesostructure?.[structureState.activeBlockId]
    ? structureState.activeBlockId
    : fallbackBlockId;
  const activeIndex = blocks.indexOf(activeBlockId);
  const macroIndex = Number.isFinite(structureState?.macroIndex)
    ? Math.max(0, Math.min(Math.max(0, blocks.length - 1), Math.floor(structureState.macroIndex)))
    : Math.max(0, activeIndex);
  return {
    ...structuredClone(structureState ?? {}),
    activeBlockId,
    macroIndex
  };
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
