import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import {
  createScorePersistence,
  loadPersistedScore,
  reconcileScore,
  writeScoreSnapshot
} from "../src/state/persistence.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("loads fallback score when persistence file is missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-persist-"));
  const config = configFor(directory);
  const fallback = createInitialScore(config);

  const loaded = await loadPersistedScore(config, fallback);

  assert.deepEqual(loaded, fallback);
});

test("reconciles persisted voices with configured voices", () => {
  const config = mergeConfig(defaultConfig, {
    ensemble: {
      id: "berklee-b51-next",
      voices: ["player-1", "player-7"]
    }
  });
  const fallback = createInitialScore(config);
  const persisted = {
    ensembleId: "old-room",
    version: 5,
    context: { clip: {}, scale: { scale_name: "Aeolian" }, grid: {}, seed: 0 },
    voices: {
      "player-1": { version: 2, notes: [{ pitch: 60 }] },
      guest: { version: 1, notes: [] }
    }
  };

  const reconciled = reconcileScore(config, fallback, persisted);

  assert.equal(reconciled.ensembleId, "berklee-b51-next");
  assert.equal(reconciled.version, 5);
  assert.equal(reconciled.voices["player-1"].notes[0].pitch, 60);
  assert.deepEqual(reconciled.voices["player-7"], { version: 0, notes: [] });
  assert.deepEqual(reconciled.voices.guest, { version: 1, notes: [] });
});

test("writes score snapshots and keeps previous backup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-persist-"));
  const scorePath = path.join(directory, "score.json");
  const backupPath = path.join(directory, "score.previous.json");

  await writeScoreSnapshot(scorePath, scoreWithVersion(1), { backupPath });
  await writeScoreSnapshot(scorePath, scoreWithVersion(2), { backupPath });

  const current = JSON.parse(await fs.readFile(scorePath, "utf8"));
  const previous = JSON.parse(await fs.readFile(backupPath, "utf8"));
  assert.equal(current.version, 2);
  assert.equal(previous.version, 1);
});

test("store persistence saves debounced changes on flush", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-persist-"));
  const config = configFor(directory, { debounceMs: 10000 });
  const store = createScoreStore(createInitialScore(config));
  const persistence = createScorePersistence(store, config);

  store.updateContext({ scale: { scale_name: "Aeolian" } });
  await persistence.flush();

  const saved = JSON.parse(await fs.readFile(config.persistence.path, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.context.scale.scale_name, "Aeolian");
});

function configFor(directory, persistence = {}) {
  return mergeConfig(defaultConfig, {
    persistence: {
      path: path.join(directory, "score.json"),
      backupPath: path.join(directory, "score.previous.json"),
      ...persistence
    }
  });
}

function scoreWithVersion(version) {
  return {
    ensembleId: "berklee-b51",
    version,
    context: { clip: {}, scale: {}, grid: {}, seed: 0 },
    voices: {
      "player-1": {
        version,
        notes: []
      }
    }
  };
}
