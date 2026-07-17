import assert from "node:assert/strict";
import test from "node:test";

import { distributeBlockTtid } from "../src/harmonic/distribution.mjs";

test("harmonic distribution resolves metadata-driven TTID controls and honors ignoreScale", async () => {
  const sends = [];
  const target = (id, deviceId) => ({
    id,
    deviceId,
    unitId: deviceId,
    status: "online",
    sendable: true,
    host: "127.0.0.1",
    port: 9000,
    capabilities: ["ttid-edit"],
    parameters: [
      { name: "Root", address: `/rnbo/${id}/Root`, meta: {} },
      { name: id === "a" ? "Scale" : "PitchSet", address: `/rnbo/${id}/ttid`, meta: { editor: "ttid" } }
    ]
  });
  const score = {
    mesostructure: { A: { ttid: 2741 } },
    oscAssignments: {
      percussion: { deviceId: "drums", oscTargetId: "b", ignoreScale: true }
    }
  };
  const result = await distributeBlockTtid(score, "A", [target("a", "keys"), target("b", "drums")], {
    sender: async (send) => sends.push(send)
  });

  assert.equal(result.ok, true);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.results[1].reason, "ignore-scale");
  assert.equal(sends[0].address, "/rnbo/a/ttid");
  assert.deepEqual(sends[0].args, [2741]);
});
