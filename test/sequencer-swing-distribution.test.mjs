import assert from "node:assert/strict";
import test from "node:test";

import { distributeBlockSwing } from "../src/sequencer/distribution.mjs";

test("block Swing distribution sends amount before the shared enum switch to every sequencer", async () => {
  const sends = [];
  const targets = ["analogsequencer", "listsequencer", "listvelsequencer", "triggersequencer"].map((app, index) => ({
    id: `${app}-${index}`,
    app,
    host: "127.0.0.1",
    port: 9000,
    status: "online",
    sendable: true,
    parameters: [
      { name: "Swing", address: `/rnbo/${index}/params/Clock/Swing`, type: "s", values: ["Off", "On"] },
      { name: "SwingAmt", address: `/rnbo/${index}/params/Clock/SwingAmt` }
    ]
  }));
  const result = await distributeBlockSwing({ mesostructure: { A: { swing: 1, swingAmt: 0.625 } } }, "A", targets, {
    sender: async (write) => { sends.push(write); return { ok: true }; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.succeededCount, 4);
  assert.equal(sends.length, 8);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const targetSends = sends.filter((send) => send.address.startsWith(`/rnbo/${targetIndex}/`));
    assert.match(targetSends[0].address, /SwingAmt$/);
    assert.deepEqual(targetSends[0].args, [0.625]);
    assert.match(targetSends[1].address, /Swing$/);
    assert.deepEqual(targetSends[1].args, ["On"]);
  }
});
