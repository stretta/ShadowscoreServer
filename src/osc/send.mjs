import dgram from "node:dgram";
import { encodeOscMessage } from "../adapters/osc.mjs";

export async function sendOscMessage(target, address, args = [], options = {}) {
  if (!target?.sendable && !options.allowUnavailable) {
    throw new Error(`OSC target '${target?.id ?? ""}' is ${target?.status ?? "unavailable"}`);
  }
  const host = target?.host;
  const port = Number(target?.port);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`OSC target '${target?.id ?? ""}' is missing host or port`);
  }
  const packet = encodeOscMessage(address, normalizeArgs(args));
  const sender = options.sender ?? udpSender;
  await sender({ host, port, packet, address, args: normalizeArgs(args), targetId: target.id });
  return {
    ok: true,
    targetId: target.id,
    host,
    port,
    address,
    args: normalizeArgs(args)
  };
}

export function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    throw new Error("OSC args must be an array");
  }
  return args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    if (typeof arg === "number" && Number.isFinite(arg)) {
      return arg;
    }
    throw new Error(`unsupported OSC argument: ${String(arg)}`);
  });
}

async function udpSender({ host, port, packet }) {
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.send(packet, port, host, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } finally {
    socket.close();
  }
}
