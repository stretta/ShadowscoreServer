import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPeerConfig, parseArgs, run as runConfigurePeer } from "../bin/configure-peer.mjs";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { readLocalTargets, refreshRegistration } from "../src/registration-agent.mjs";

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
          address: "/rnbo/inst/1/messages/in/shadowscore",
          capabilities: {
            maxStages: 1024,
            maxNoteRows: 256
          }
        }
      ]
    }
  });

  const targets = await readLocalTargets(config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].host, "finch.local");
  assert.equal(targets[0].hardwareUnitId, "finch");
  assert.equal(targets[0].hardwareUnitName, "Finch");
  assert.equal(targets[0].capabilities.maxStages, 1024);
  assert.equal(targets[0].capabilities.maxNoteRows, 256);
  assert.equal(targets[0].capabilities.noteRowWidth, 10);
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

test("registration refresh re-registers when local RNBO targets are available", async () => {
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
  const requests = [];

  await refreshRegistration(config, "http://wren.local:8790", "finch", {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return okResponse();
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://wren.local:8790/hardware/register");
  assert.equal(requests[0].body.id, "finch");
  assert.equal(requests[0].body.targets.length, 1);
  assert.equal(requests[0].body.targets[0].host, "finch.local");
});

test("registration refresh heartbeats instead of replacing targets with an empty discovery result", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      hostIdentity: "finch"
    },
    rnbo: {
      oscQuery: {
        enabled: false
      },
      targets: []
    }
  });
  const requests = [];

  await refreshRegistration(config, "http://wren.local:8790", "finch", {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return okResponse();
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://wren.local:8790/hardware/units/finch/heartbeat");
  assert.deepEqual(requests[0].body, {});
});

test("registration refresh re-registers RNBO devices without ShadowScore targets", async () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      advertisedName: "Wren",
      hostIdentity: "wren"
    },
    rnbo: {
      host: "127.0.0.1",
      oscQuery: {
        enabled: true,
        url: "http://127.0.0.1:5678/"
      },
      targets: []
    }
  });
  const requests = [];

  await refreshRegistration(config, "http://wren.local:8790", "wren", {
    fetchImpl: async (url, options = {}) => {
      if (!options.method || options.method === "GET") {
        return jsonResponse(oscQueryTreeWithoutShadowscore());
      }
      requests.push({ url, body: JSON.parse(options.body) });
      return okResponse();
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://wren.local:8790/hardware/register");
  assert.deepEqual(requests[0].body.targets, []);
  assert.equal(requests[0].body.rnboDevices.length, 1);
  assert.equal(requests[0].body.rnboDevices[0].graphEditorUrl, "http://wren.local:3000");
});

test("peer config generator writes repeatable local peer config", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shadowscore-peer-config-"));
  const output = path.join(tmp, "config", "shadowscore.peer.local.json");

  const result = await runConfigurePeer([
    "--id", "bob",
    "--ip", "192.168.68.111",
    "--host", "192.168.68.102",
    "--output", output
  ]);
  const written = JSON.parse(await fs.readFile(output, "utf8"));

  assert.equal(result.output, output);
  assert.equal(written.server.role, "peer");
  assert.equal(written.server.hostIdentity, "bob");
  assert.equal(written.server.advertisedName, "bob");
  assert.equal(written.registration.sessionHostUrl, "http://192.168.68.102:8790");
  assert.equal(written.rnbo.port, 1234);
  assert.equal(written.rnbo.registrationHost, "192.168.68.111");
  assert.equal(written.rnbo.oscQuery.oscHost, "192.168.68.111");
});

test("peer config generator accepts urls, names, and explicit RNBO ports", () => {
  const config = buildPeerConfig(parseArgs([
    "--id=heron",
    "--name", "Heron",
    "--ip", "192.168.68.101",
    "--host", "http://wren.local:8790/",
    "--rnbo-port", "9000"
  ]));

  assert.equal(config.server.advertisedName, "Heron");
  assert.equal(config.registration.sessionHostUrl, "http://wren.local:8790");
  assert.equal(config.rnbo.port, 9000);
  assert.equal(config.rnbo.registrationHost, "192.168.68.101");
});

function okResponse() {
  return {
    ok: true,
    async json() {
      return { ok: true };
    }
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    async json() {
      return body;
    }
  };
}

function oscQueryTreeWithoutShadowscore() {
  return {
    FULL_PATH: "/",
    CONTENTS: {
      rnbo: {
        CONTENTS: {
          info: {
            CONTENTS: {
              version: {
                VALUE: "1.4.4"
              },
              runner_version: {
                VALUE: "1.4.4-9"
              }
            }
          },
          inst: {
            CONTENTS: {
              "0": {
                CONTENTS: {
                  name: {
                    VALUE: "TimeDomainScope"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
