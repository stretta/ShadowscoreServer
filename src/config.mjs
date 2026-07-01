import fs from "node:fs/promises";
import os from "node:os";

export const defaultConfig = Object.freeze({
  http: {
    host: "0.0.0.0",
    port: 8790,
    publicUrl: ""
  },
  server: {
    role: "host",
    advertisedName: os.hostname(),
    hostIdentity: os.hostname()
  },
  registration: {
    enabled: true,
    sessionHostUrl: "",
    heartbeatIntervalMs: 10000,
    heartbeatTtlMs: 30000
  },
  transport: {
    tempoAuthority: "link",
    jack: {
      enabled: false,
      host: "",
      freshnessMs: 500,
      pollIntervalMs: 75,
      python: "python3",
      bridgeScript: "bin/jack-transport-bridge.py",
      controlClientName: "shadowscore-jack-control",
      library: ""
    },
    rnboClient: {
      maxSkewBeats: 0.25
    }
  },
  static: {
    enabled: true,
    root: "public/matrix-edit",
    index: "index.html",
    apps: {
      matrixEdit: {
        root: "public/matrix-edit",
        index: "index.html",
        routes: ["/matrix-edit"]
      },
      eventList: {
        root: "public/event-list",
        index: "index.html",
        routes: ["/event-list"]
      },
      structureEditor: {
        root: "public/structure-editor",
        index: "index.html",
        routes: ["/structure-editor", "/"]
      }
    }
  },
  ensemble: {
    id: "berklee-b51",
    voices: ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"],
    assignmentDefaults: {
      "player-1": { label: "Player 1", color: "#d1453b" },
      "player-2": { label: "Player 2", color: "#256f86" },
      "player-3": { label: "Player 3", color: "#2f855a" },
      "player-4": { label: "Player 4", color: "#8a5a16" },
      "player-5": { label: "Player 5", color: "#6f42c1" },
      "player-6": { label: "Player 6", color: "#c04778" }
    },
    assignmentPresets: {
      "six-player-shadowbox": {
        label: "Six Shadowboxes",
        assignments: {
          "player-1": { label: "Shadowbox A / Source", assignee: "Player 1", deviceId: "shadowbox-a", color: "#d1453b" },
          "player-2": { label: "Shadowbox B / Source", assignee: "Player 2", deviceId: "shadowbox-b", color: "#256f86" },
          "player-3": { label: "Shadowbox C / Source", assignee: "Player 3", deviceId: "shadowbox-c", color: "#2f855a" },
          "player-4": { label: "Shadowbox D / Source", assignee: "Player 4", deviceId: "shadowbox-d", color: "#8a5a16" },
          "player-5": { label: "Shadowbox E / Source", assignee: "Player 5", deviceId: "shadowbox-e", color: "#6f42c1" },
          "player-6": { label: "Shadowbox F / Source", assignee: "Player 6", deviceId: "shadowbox-f", color: "#c04778" }
        }
      }
    }
  },
  persistence: {
    enabled: true,
    path: "data/score.json",
    backupPath: "data/score.previous.json",
    libraryPath: "data/scores",
    debounceMs: 150
  },
  rnbo: {
    enabled: false,
    host: "127.0.0.1",
    port: 9000,
    address: "/rnbo/inst/2/messages/in/shadowscore",
    oscQuery: {
      enabled: false,
      url: "http://127.0.0.1:5678/",
      timeoutMs: 1000,
      addressPattern: "shadowscore"
    },
    stagesPerBeat: 16,
    resolution: {
      mode: "fixed",
      defaultStagesPerBeat: 16,
      maxStages: 4096,
      maxNoteRows: 819,
      noteDataFloatCount: 8192,
      noteRowWidth: 10,
      contextDataFloatCount: 64,
      quantizationErrorTargetBeats: 0.0020833333333333333,
      candidateStagesPerBeat: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480],
      supportedClockIntervals: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480]
    },
    transport: {
      Tempo: 120,
      ClockInterval: 120,
      MaxSteps: 64
    },
    clearRowCount: 64,
    transactionStart: 1000,
    sendDelayMs: 5
  }
});

export async function loadConfig(argv = process.argv.slice(2)) {
  const configPath = readFlag(argv, "--config");
  if (!configPath) {
    return structuredClone(defaultConfig);
  }

  const raw = await fs.readFile(configPath, "utf8");
  const fileConfig = JSON.parse(raw);
  return mergeConfig(defaultConfig, fileConfig);
}

export function mergeConfig(base, override) {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
