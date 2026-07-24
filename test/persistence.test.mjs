import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import {
  createScorePersistence,
  loadPersistedScore,
  migratePersistedScore,
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
    assignments: {
      "player-1": { assignee: "Ari", deviceId: "shadowbox-05", clientId: "5505", label: "", color: "", locked: true }
    },
    clips: {
      oldClip: { notes: [{ pitch: 48 }], context: { clip: {}, scale: {}, grid: {}, seed: 0 }, behavior: {} },
      oneShot: { notes: [], context: { clip: {}, scale: {}, grid: {}, seed: 0 }, duration: { beats: 2 }, playbackType: "one-shot", behavior: {} }
    },
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
  assert.equal(reconciled.assignments["player-1"].assignee, "Ari");
  assert.equal(reconciled.assignments["player-7"].assignee, "");
  assert.equal(reconciled.clips.oldClip.playbackType, "looped");
  assert.equal(reconciled.clips.oneShot.playbackType, "one-shot");
  assert.deepEqual(reconciled.clips.oldClip.duration, {});
  assert.deepEqual(reconciled.clips.oneShot.duration, { beats: 2 });
});

test("declaratively initialized exact players survive persistence reconciliation", () => {
  const config = mergeConfig(defaultConfig, {
    ensemble: { voices: ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"] }
  });
  const fallback = createInitialScore(config);
  const playerIds = ["player-1", "player-2", "player-3", "player-4"];
  const persisted = {
    ...structuredClone(fallback),
    scoreInitialization: { schemaVersion: 1, name: "Quartet", exactPlayers: true },
    voices: Object.fromEntries(playerIds.map((id) => [id, { version: 0, notes: [] }])),
    assignments: Object.fromEntries(playerIds.map((id) => [id, fallback.assignments[id]]))
  };

  const reconciled = reconcileScore(config, fallback, persisted);

  assert.deepEqual(Object.keys(reconciled.voices), playerIds);
  assert.equal(reconciled.assignments["player-5"], undefined);
  assert.equal(reconciled.mesostructure.A.players["player-5"], undefined);
  assert.equal(reconciled.mesostructure.A.players["player-6"], undefined);
  assert.equal(reconciled.clips["a-player-5"], undefined);
  assert.equal(reconciled.clips["a-player-6"], undefined);
  assert.deepEqual(reconciled.scoreInitialization, { schemaVersion: 1, name: "Quartet", exactPlayers: true });
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

test("OSC assignments, clips, and layers survive persistence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-persist-"));
  const config = configFor(directory, { debounceMs: 10000 });
  const fallback = createInitialScore(config);
  const store = createScoreStore(fallback);
  const persistence = createScorePersistence(store, config);

  store.replaceOscAssignment("list-a", { app: "listsequencer", deviceId: "finch", oscTargetId: "finch:listsequencer:main" });
  store.addOscClip("list-opening", {
    app: "listsequencer",
    params: { Clock: 1 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  });
  store.assignOscLayer("F", "list-a", "list-opening");
  await persistence.flush();

  const loaded = await loadPersistedScore(config, fallback);
  assert.equal(loaded.oscAssignments["list-a"].deviceId, "finch");
  assert.equal(loaded.mesostructure.F.oscLayers["list-a"].clipId, "list-opening");
  assert.deepEqual(loaded.oscClips["list-opening"].inputPorts.Steps, [1, 0, 1, 0]);

  const legacy = structuredClone(fallback);
  delete legacy.oscAssignments;
  delete legacy.oscClips;
  for (const block of Object.values(legacy.mesostructure)) delete block.oscLayers;
  assert.deepEqual(reconcileScore(config, fallback, legacy).oscAssignments, {});
  assert.deepEqual(reconcileScore(config, fallback, legacy).oscClips, {});
  assert.deepEqual(reconcileScore(config, fallback, legacy).mesostructure.A.oscLayers, {});
});

test("persisted OSC clips migrate legacy TTID parameters out of snapshot ownership", () => {
  const persisted = scoreWithVersion(1);
  persisted.oscClips = {
    legacy: {
      app: "listsequencer",
      params: { Clock: 1, Scale: 2741, "T-T-I-D": 4095 },
      inputPorts: { Steps: [1, 0, 1, 0] }
    }
  };

  const migrated = migratePersistedScore(persisted);

  assert.deepEqual(migrated.oscClips.legacy.params, { Clock: 1 });
  assert.deepEqual(persisted.oscClips.legacy.params, { Clock: 1, Scale: 2741, "T-T-I-D": 4095 });
});

test("persisted macrostructure tempo migrates into missing block tempos", () => {
  const persisted = createInitialScore(defaultConfig);
  persisted.macrostructure.tempo = 96;
  delete persisted.mesostructure.A.tempo;
  persisted.mesostructure.B.tempo = 84;

  const migrated = migratePersistedScore(persisted);

  assert.equal(migrated.mesostructure.A.tempo, 96);
  assert.equal(migrated.mesostructure.B.tempo, 84);
  assert.equal(migrated.macrostructure.tempo, undefined);
  assert.equal(persisted.macrostructure.tempo, 96);
  assert.equal(persisted.mesostructure.A.tempo, undefined);
});

test("legacy persisted scores load through the mesostructural TTID cutover", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-persist-"));
  const config = configFor(directory);
  const fallback = createInitialScore(config);
  const persisted = structuredClone(fallback);
  persisted.mesostructure.A.scale = {};
  delete persisted.mesostructure.A.ttid;
  persisted.oscClips.legacy = {
    app: "listsequencer",
    params: { Clock: 1, Scale: 2741 },
    inputPorts: { Steps: [1, 0, 1, 0] }
  };
  await fs.mkdir(path.dirname(config.persistence.path), { recursive: true });
  await fs.writeFile(config.persistence.path, `${JSON.stringify(persisted)}\n`);

  const loaded = await loadPersistedScore(config, fallback);
  const score = createScoreStore(loaded).getScore();

  assert.deepEqual(score.oscClips.legacy.params, { Clock: 1 });
  assert.equal(score.mesostructure.A.scale.scale_name, "Ionian");
  assert.equal(score.mesostructure.A.ttid, 2741);
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
    assignments: {
      "player-1": {
        assignee: "",
        deviceId: "",
        clientId: null,
        label: "",
        color: "",
        locked: false
      }
    },
    voices: {
      "player-1": {
        version,
        notes: []
      }
    }
  };
}
