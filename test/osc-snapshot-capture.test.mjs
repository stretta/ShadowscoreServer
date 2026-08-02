import assert from "node:assert/strict";
import test from "node:test";

import { captureOscTarget } from "../src/osc/snapshot-capture.mjs";

test("capture reads fresh params and list ACK state from exactly one normalized target", async () => {
  const sends = [];
  const reads = new Map([
    ["http://heron.local:5678/rnbo/inst/2/params", { CONTENTS: {
      ClockRate: { VALUE: "8n" },
      GateTime: { VALUE: 0.45 },
      Clock: { VALUE: 1 }
    } }],
    ["http://heron.local:5678/rnbo/inst/2/messages/out/StepsAck", { VALUE: [1, 0, 1, 0] }]
  ]);
  const captured = await captureOscTarget(target(), {
    name: "Heron opening",
    now: () => Date.parse("2026-07-15T16:00:00.000Z"),
    delay: async () => {},
    sender: async (write) => sends.push(write),
    fetchImpl: async (url) => response(reads.get(url))
  });

  assert.deepEqual(captured.clip.params, { ClockRate: 1, GateTime: 0.45, Clock: 1 });
  assert.deepEqual(captured.clip.inputPorts, { Steps: [1, 0, 1, 0] });
  assert.deepEqual(sends.map(({ address, args }) => [address, args]), [["/rnbo/inst/2/messages/in/Steps", [-999]]]);
  assert.equal(captured.clip.capture.deviceId, "heron");
  assert.equal(captured.clip.capture.targetId, "heron:listsequencer:main");
  assert.equal(captured.clip.capture.complete, true);
  assert.deepEqual(captured.clip.capture.diagnostics, []);
});

test("capture rejects incomplete persistent list readback unless explicitly allowed", async () => {
  const options = {
    delay: async () => {},
    sender: async () => {},
    fetchImpl: async (url) => url.endsWith("/params")
      ? response({ CONTENTS: { ClockRate: { VALUE: "4n" }, GateTime: { VALUE: 0.5 }, Clock: { VALUE: 0 } } })
      : response(undefined, 404)
  };
  await assert.rejects(() => captureOscTarget(target(), options), (error) => {
    assert.equal(error.code, "OSC_CAPTURE_INCOMPLETE");
    assert.equal(error.diagnostics[0].name, "Steps");
    return true;
  });

  const partial = await captureOscTarget(target(), { ...options, allowIncomplete: true });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.clip.inputPorts, {});
});

test("capture supports parameter-only AnalogSequencer and ListVel row ACK naming", async () => {
  const analog = await captureOscTarget({
    ...target(),
    id: "wren:analogsequencer:main",
    deviceId: "wren",
    app: "analogsequencer",
    baseAddress: "/rnbo/inst/4",
    parameters: [{ name: "Stage01", address: "/rnbo/inst/4/params/Stage01" }],
    inputPorts: [{ name: "RTZ", address: "/rnbo/inst/4/messages/in/RTZ" }]
  }, {
    fetchImpl: async () => response({ CONTENTS: { Stage01: { VALUE: 0.75 } } })
  });
  assert.deepEqual(analog.clip.params, { Stage01: 0.75 });
  assert.deepEqual(analog.clip.inputPorts, {});

  const sends = [];
  const listVel = await captureOscTarget({
    ...target(),
    id: "finch:listvelsequencer:main",
    deviceId: "finch",
    app: "listvelsequencer",
    baseAddress: "/rnbo/inst/7",
    parameters: [],
    inputPorts: [{ name: "4row", address: "/rnbo/inst/7/messages/in/4ow" }]
  }, {
    delay: async () => {},
    sender: async (write) => sends.push(write),
    fetchImpl: async (url) => url.endsWith("/params")
      ? response({ CONTENTS: {} })
      : response({ VALUE: [60, 62, 64] })
  });
  assert.deepEqual(listVel.clip.inputPorts, { "4row": [60, 62, 64] });
  assert.equal(sends[0].address, "/rnbo/inst/7/messages/in/4ow");
});

test("capture follows unified nested Clock addresses and stores enum indexes", async () => {
  const captured = await captureOscTarget({
    ...target(),
    parameters: [
      { name: "Clock", address: "/rnbo/inst/2/params/Clock/Clock", type: "s", values: ["Off", "On"] },
      { name: "Swing", address: "/rnbo/inst/2/params/Clock/Swing", type: "s", values: ["Off", "On"] },
      { name: "ClockInterval", address: "/rnbo/inst/2/params/Clock/ClockInterval" },
      { name: "SwingAmt", address: "/rnbo/inst/2/params/Clock/SwingAmt" }
    ],
    inputPorts: []
  }, {
    fetchImpl: async () => response({
      CONTENTS: {
        Clock: {
          CONTENTS: {
            Clock: { FULL_PATH: "/rnbo/inst/2/params/Clock/Clock", VALUE: "On" },
            Swing: { FULL_PATH: "/rnbo/inst/2/params/Clock/Swing", VALUE: "Off" },
            ClockInterval: { FULL_PATH: "/rnbo/inst/2/params/Clock/ClockInterval", VALUE: 240 },
            SwingAmt: { FULL_PATH: "/rnbo/inst/2/params/Clock/SwingAmt", VALUE: 0.75 }
          }
        }
      }
    })
  });
  assert.deepEqual(captured.clip.params, {
    Clock: 1,
    Swing: 0,
    ClockInterval: 240,
    SwingAmt: 0.75
  });
});

test("capture preserves unique nested parameter keys for repeated leaf names", async () => {
  const captured = await captureOscTarget({
    ...target(),
    app: "vantor",
    parameters: [
      { name: "Attack", key: "FilterEnv/Attack", address: "/rnbo/inst/9/params/Subtractive-I/FilterEnv/Attack" },
      { name: "Attack", key: "AmpEnv/Attack", address: "/rnbo/inst/9/params/Subtractive-I/AmpEnv/Attack" }
    ],
    inputPorts: []
  }, {
    fetchImpl: async () => response({ CONTENTS: {
      "Subtractive-I": { CONTENTS: {
        FilterEnv: { CONTENTS: { Attack: { FULL_PATH: "/rnbo/inst/9/params/Subtractive-I/FilterEnv/Attack", VALUE: 2 } } },
        AmpEnv: { CONTENTS: { Attack: { FULL_PATH: "/rnbo/inst/9/params/Subtractive-I/AmpEnv/Attack", VALUE: 5 } } }
      } }
    } })
  });

  assert.deepEqual(captured.clip.params, { "FilterEnv/Attack": 2, "AmpEnv/Attack": 5 });
});

function target() {
  return {
    id: "heron:listsequencer:main",
    deviceId: "heron",
    app: "listsequencer",
    status: "online",
    sendable: true,
    host: "heron.local",
    port: 1234,
    baseAddress: "/rnbo/inst/2",
    parameters: [
      { name: "ClockRate", address: "/rnbo/inst/2/params/ClockRate", type: "s", values: ["4n", "8n"] },
      { name: "GateTime", address: "/rnbo/inst/2/params/GateTime" },
      { name: "Clock", address: "/rnbo/inst/2/params/Clock" }
    ],
    inputPorts: [
      { name: "Steps", address: "/rnbo/inst/2/messages/in/Steps" },
      { name: "rtz", address: "/rnbo/inst/2/messages/in/rtz" }
    ]
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
