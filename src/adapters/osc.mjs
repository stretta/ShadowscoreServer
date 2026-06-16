export function encodeOscMessage(address, args) {
  if (typeof address !== "string" || !address.startsWith("/")) {
    throw new Error("OSC address must start with /");
  }

  const encodedArgs = args.map(encodeOscArg);
  return Buffer.concat([
    encodeOscString(address),
    encodeOscString(`,${encodedArgs.map((arg) => arg.type).join("")}`),
    ...encodedArgs.map((arg) => arg.buffer)
  ]);
}

function encodeOscArg(value) {
  if (Number.isInteger(value)) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return { type: "i", buffer };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(value);
    return { type: "f", buffer };
  }
  if (typeof value === "string") {
    return { type: "s", buffer: encodeOscString(value) };
  }
  throw new Error(`unsupported OSC argument: ${String(value)}`);
}

function encodeOscString(value) {
  const raw = Buffer.from(`${value}\0`);
  const padding = (4 - (raw.length % 4)) % 4;
  return padding === 0 ? raw : Buffer.concat([raw, Buffer.alloc(padding)]);
}
