#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT = "config/shadowscore.peer.local.json";
const DEFAULT_RNBO_PORT = 1234;
const DEFAULT_HTTP_PORT = 8790;

if (import.meta.url === `file://${process.argv[1]}`) {
  await run(process.argv.slice(2)).catch((error) => {
    console.error(`[configure-peer] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const output = parsed.output || DEFAULT_OUTPUT;
  const document = buildPeerConfig(parsed);
  const writeFile = options.writeFile ?? fs.writeFile;
  const mkdir = options.mkdir ?? fs.mkdir;

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`[configure-peer] wrote ${output} for ${document.server.hostIdentity}`);
  return { output, document };
}

export function buildPeerConfig(options) {
  const id = requiredString(options.id, "--id");
  const ip = requiredString(options.ip, "--ip");
  const host = requiredString(options.host, "--host");
  const rnboPort = positiveInteger(options.rnboPort ?? DEFAULT_RNBO_PORT, "--rnbo-port");

  return {
    http: {
      host: "0.0.0.0",
      port: DEFAULT_HTTP_PORT,
      publicUrl: ""
    },
    server: {
      role: "peer",
      hostIdentity: id,
      advertisedName: options.name ? requiredString(options.name, "--name") : id
    },
    registration: {
      enabled: true,
      sessionHostUrl: sessionHostUrl(host),
      heartbeatIntervalMs: 10000,
      heartbeatTtlMs: 30000
    },
    rnbo: {
      enabled: true,
      host: "127.0.0.1",
      port: rnboPort,
      address: "/rnbo/inst/2/messages/in/shadowscore",
      registrationHost: ip,
      oscQuery: {
        enabled: true,
        url: "http://127.0.0.1:5678/",
        timeoutMs: 1000,
        addressPattern: "shadowscore",
        oscHost: ip
      }
    }
  };
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument '${arg}'`);
    }
    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    switch (name) {
      case "--id":
        options.id = value;
        break;
      case "--ip":
        options.ip = value;
        break;
      case "--host":
        options.host = value;
        break;
      case "--name":
        options.name = value;
        break;
      case "--output":
        options.output = value;
        break;
      case "--rnbo-port":
        options.rnboPort = value;
        break;
      default:
        throw new Error(`unknown option '${name}'`);
    }
  }
  return options;
}

function sessionHostUrl(host) {
  const value = requiredString(host, "--host").replace(/\/+$/, "");
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `http://${value}:${DEFAULT_HTTP_PORT}`;
}

function requiredString(value, name) {
  const stringValue = value === undefined || value === null ? "" : String(value).trim();
  if (!stringValue) {
    throw new Error(`${name} is required`);
  }
  return stringValue;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}
