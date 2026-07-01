import { spawn } from "node:child_process";

const DEFAULT_SCRIPT = "bin/jack-transport-bridge.py";

export function createJackTransportController(config = {}, options = {}) {
  const python = options.python ?? config.transport?.jack?.python ?? "python3";
  const script = options.script ?? config.transport?.jack?.bridgeScript ?? DEFAULT_SCRIPT;
  const clientName = options.clientName ?? config.transport?.jack?.controlClientName ?? "shadowscore-jack-control";
  const library = options.library ?? config.transport?.jack?.library ?? "";
  const cwd = options.cwd ?? process.cwd();

  return {
    start() {
      return runControl({ action: "start" });
    },
    stop() {
      return runControl({ action: "stop" });
    },
    locate(frame) {
      return runControl({ action: "locate", frame });
    }
  };

  async function runControl({ action, frame }) {
    const args = [
      script,
      "--client-name",
      clientName,
      "--control",
      action
    ];
    if (library) {
      args.push("--jack-library", library);
    }
    if (action === "locate") {
      args.push("--frame", String(nonNegativeInteger(frame, "frame")));
    }
    await spawnFile(python, args, { cwd });
    return {
      ok: true,
      action,
      ...(action === "locate" ? { frame: nonNegativeInteger(frame, "frame") } : {})
    };
  }
}

function spawnFile(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with ${code}`));
      }
    });
  });
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}
