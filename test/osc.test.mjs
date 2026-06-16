import assert from "node:assert/strict";
import test from "node:test";
import { encodeOscMessage } from "../src/adapters/osc.mjs";

test("encodes integer OSC messages", () => {
  const packet = encodeOscMessage("/rnbo/inst/2/messages/in/shadowscore", [1, 42, 90]);

  assert.equal(readOscString(packet, 0), "/rnbo/inst/2/messages/in/shadowscore");
  assert.ok(packet.includes(Buffer.from(",iii")));
  assert.equal(packet.readInt32BE(packet.length - 12), 1);
  assert.equal(packet.readInt32BE(packet.length - 8), 42);
  assert.equal(packet.readInt32BE(packet.length - 4), 90);
});

function readOscString(packet, offset) {
  const end = packet.indexOf(0, offset);
  return packet.subarray(offset, end).toString("utf8");
}
