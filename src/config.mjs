import fs from "node:fs/promises";

export const defaultConfig = Object.freeze({
  http: {
    host: "0.0.0.0",
    port: 8790
  },
  ensemble: {
    id: "berklee-b51",
    voices: ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"]
  },
  persistence: {
    enabled: true,
    path: "data/score.json",
    backupPath: "data/score.previous.json",
    debounceMs: 150
  },
  rnbo: {
    enabled: false,
    host: "127.0.0.1",
    port: 9000,
    address: "/rnbo/inst/2/messages/in/shadowscore",
    stagesPerBeat: 16,
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
