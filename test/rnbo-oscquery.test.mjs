import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { discoverRnboTargets, extractRnboTargets } from "../src/adapters/rnbo-oscquery.mjs";

test("extracts ShadowScoreClient RNBO message targets from OSCQuery tree", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "192.168.68.96",
      port: 1234,
      oscQuery: {
        enabled: true,
        url: "http://pt5.local:5678/"
      }
    }
  });

  const targets = extractRnboTargets(createOscQueryTree(), config);

  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0], {
    id: "rnbo-inst-2:shadowscore",
    name: "ShadowScoreClient / shadowscore",
    host: "192.168.68.96",
    port: 1234,
    address: "/rnbo/inst/2/messages/in/shadowscore",
    instanceId: "2",
    messagePath: "/rnbo/inst/2/messages/in/shadowscore",
    ackPath: "/rnbo/inst/2/messages/out/shadowscore_ack",
    currentStagePath: "/rnbo/inst/2/messages/out/current_stage",
    clientId: "2202",
    source: "rnbooscquery",
    available: true
  });
});

test("ignores nested ShadowScore metadata message paths", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      oscQuery: {
        enabled: true
      }
    }
  });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["2"].CONTENTS.messages.CONTENTS.in.CONTENTS.shadowscore.CONTENTS = {
    meta: {
      FULL_PATH: "/rnbo/inst/2/messages/in/shadowscore/meta",
      TYPE: "m"
    }
  };

  const targets = extractRnboTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].address, "/rnbo/inst/2/messages/in/shadowscore");
});

test("RNBOOSCQuery discovery returns an empty target list on fetch failure", async () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      oscQuery: {
        enabled: true,
        url: "http://pt5.local:5678/"
      },
      log: false
    }
  });

  const targets = await discoverRnboTargets(config, {
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });

  assert.deepEqual(targets, []);
});

function createOscQueryTree() {
  return {
    FULL_PATH: "/",
    CONTENTS: {
      rnbo: {
        CONTENTS: {
          inst: {
            CONTENTS: {
              "2": {
                CONTENTS: {
                  messages: {
                    CONTENTS: {
                      in: {
                        CONTENTS: {
                          shadowscore: {
                            FULL_PATH: "/rnbo/inst/2/messages/in/shadowscore",
                            TYPE: "m",
                            VALUE: [2202, 90, 1001, 0, 0, 1]
                          }
                        }
                      },
                      out: {
                        CONTENTS: {
                          shadowscore_ack: {
                            FULL_PATH: "/rnbo/inst/2/messages/out/shadowscore_ack",
                            TYPE: "m"
                          },
                          current_stage: {
                            FULL_PATH: "/rnbo/inst/2/messages/out/current_stage",
                            TYPE: "m"
                          }
                        }
                      }
                    }
                  },
                  parameters: {
                    CONTENTS: {
                      ClockMode: {
                        FULL_PATH: "/rnbo/inst/2/params/ClockMode"
                      }
                    }
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
