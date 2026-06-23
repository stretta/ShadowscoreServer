import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { readLocalTargets } from "../src/registration-agent.mjs";

test("peer registration rewrites loopback RNBO targets to the unit hostname", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      advertisedName: "Finch",
      hostIdentity: "finch"
    },
    rnbo: {
      host: "127.0.0.1",
      port: 1234,
      targets: [
        {
          id: "source",
          address: "/rnbo/inst/1/messages/in/shadowscore"
        }
      ]
    }
  });

  const targets = await readLocalTargets(config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].host, "finch.local");
  assert.equal(targets[0].hardwareUnitId, "finch");
  assert.equal(targets[0].hardwareUnitName, "Finch");
});

test("peer registration preserves explicit non-loopback RNBO targets", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      hostIdentity: "heron"
    },
    rnbo: {
      host: "192.168.68.72",
      port: 1234,
      targets: [
        {
          id: "source",
          address: "/rnbo/inst/1/messages/in/shadowscore"
        }
      ]
    }
  });

  const targets = await readLocalTargets(config);

  assert.equal(targets[0].host, "192.168.68.72");
  assert.equal(targets[0].hardwareUnitId, "heron");
});
