import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, mergeConfig } from "../src/config.mjs";
import { discoverRnboTargets, extractRnboControlTargets, extractRnboDevices, extractRnboTargets, rnboTransportControlWrites } from "../src/adapters/rnbo-oscquery.mjs";

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
  const { capabilities, ...target } = targets[0];
  assert.deepEqual(target, {
    id: "rnbo-inst-2:shadowscore",
    name: "ShadowScoreClient / shadowscore",
    host: "192.168.68.96",
    port: 1234,
    address: "/rnbo/inst/2/messages/in/shadowscore",
    instanceId: "2",
    messagePath: "/rnbo/inst/2/messages/in/shadowscore",
    ackPath: "/rnbo/inst/2/messages/out/shadowscore_ack",
    currentStagePath: "/rnbo/inst/2/messages/out/current_stage",
    currentStage: 40,
    clientId: "2202",
    source: "rnbooscquery",
    available: true
  });
  assert.equal(capabilities.maxStages, 4096);
  assert.equal(capabilities.maxNoteRows, 819);
  assert.equal(capabilities.noteRowWidth, 10);
  assert.equal(capabilities.supportsAdaptiveResolution, true);
  assert.equal(capabilities.activeRowCountCommit, false);
  assert.equal(capabilities.compactScoreReplace, false);
});

test("extracts ShadowScoreClient compact replacement capabilities from OSCQuery metadata", () => {
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
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["2"].CONTENTS.messages.CONTENTS.in.CONTENTS.shadowscore.CONTENTS = {
    capabilities: {
      VALUE: JSON.stringify({
        supportsBeginReplaceClear: true,
        activeRowCountCommit: true,
        compactScoreReplace: true
      })
    }
  };

  const targets = extractRnboTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].capabilities.supportsBeginReplaceClear, true);
  assert.equal(targets[0].capabilities.activeRowCountCommit, true);
  assert.equal(targets[0].capabilities.compactScoreReplace, true);
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

test("extracts RNBO devices even when no ShadowScore target is loaded", () => {
  const config = mergeConfig(defaultConfig, {
    server: {
      advertisedName: "wren",
      hostIdentity: "wren"
    },
    rnbo: {
      host: "127.0.0.1",
      oscQuery: {
        enabled: true,
        url: "http://127.0.0.1:5678/"
      }
    }
  });
  const tree = createOscQueryTree();
  delete tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["2"];

  const targets = extractRnboTargets(tree, config);
  const devices = extractRnboDevices(tree, config);

  assert.deepEqual(targets, []);
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0], {
    id: "wren",
    name: "wren",
    host: "wren.local",
    oscQueryUrl: "http://wren.local:5678",
    graphEditorUrl: "http://wren.local:3000",
    source: "rnbooscquery",
    available: true,
    rnboVersion: "1.4.4",
    runnerVersion: "1.4.4-9"
  });
});

test("extracts Poland OSC control targets from RNBOOSCQuery params", () => {
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
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: {
      info: {
        CONTENTS: {
          ports: {
            CONTENTS: {
              properties: {
                CONTENTS: {
                  "Poland-2:out1": {
                    VALUE: "{\"rnbo-instance-id\":2,\"source\":true,\"type\":\"audio\"}"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["2"].CONTENTS.params = {
    CONTENTS: {
      VolA: rnboParam("/rnbo/inst/2/params/VolA", 0.5, 0, 1, 0),
      VolB: rnboParam("/rnbo/inst/2/params/VolB", 0.6, 0, 1, 1),
      WaveA: rnboParam("/rnbo/inst/2/params/WaveA", 1, 0, 127, 2),
      WaveB: rnboParam("/rnbo/inst/2/params/WaveB", 2, 0, 127, 3)
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-2:poland");
  assert.equal(targets[0].app, "poland");
  assert.equal(targets[0].instance, "main");
  assert.equal(targets[0].baseAddress, "/rnbo/inst/2");
  assert.equal(targets[0].parameters.length, 4);
  assert.deepEqual(targets[0].parameters[0], {
    name: "VolA",
    address: "/rnbo/inst/2/params/VolA",
    type: "f",
    value: 0.5,
    range: [{ MIN: 0, MAX: 1 }],
    min: 0,
    max: 1,
    displayName: "VolA",
    index: 0,
    normalized: 0.5
  });
});

test("extracts Plate OSC control targets from RNBOOSCQuery instance names", () => {
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
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: {
      info: {
        CONTENTS: {
          ports: {
            CONTENTS: {
              properties: {
                CONTENTS: {
                  "Plate-3:out1": {
                    VALUE: "{\"rnbo-instance-id\":3,\"source\":true,\"type\":\"audio\"}"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["3"] = {
    CONTENTS: {
      params: {
        CONTENTS: {
          Decay: rnboParam("/rnbo/inst/3/params/Decay", 0.8, 0, 1, 0),
          PreDelay: rnboParam("/rnbo/inst/3/params/PreDelay", 22, 0, 200, 1),
          Mix: rnboParam("/rnbo/inst/3/params/Mix", 0.35, 0, 1, 2)
        }
      }
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-3:plate");
  assert.equal(targets[0].app, "plate");
  assert.equal(targets[0].label, "Plate 3");
  assert.equal(targets[0].instance, "main");
  assert.equal(targets[0].baseAddress, "/rnbo/inst/3");
  assert.equal(targets[0].oscCapabilities.includes("plate-edit"), true);
  assert.equal(targets[0].parameters.length, 3);
});

test("extracts Plate OSC control targets from lowercase reverb params", () => {
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
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["4"] = {
    CONTENTS: {
      params: {
        CONTENTS: {
          decay: rnboParam("/rnbo/inst/4/params/decay", 0.6, 0, 1, 0),
          mix: rnboParam("/rnbo/inst/4/params/mix", 0.3, 0, 1, 1),
          damp: rnboParam("/rnbo/inst/4/params/damp", 0.4, 0, 1, 2),
          diff: rnboParam("/rnbo/inst/4/params/diff", 0.7, 0, 1, 3)
        }
      }
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-4:plate");
  assert.equal(targets[0].app, "plate");
  assert.equal(targets[0].parameters.length, 4);
});

test("extracts TTID OSC control targets from editor metadata", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "192.168.68.70",
      port: 1234,
      oscQuery: {
        enabled: true,
        url: "http://wren.local:5678/"
      }
    }
  });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["12"] = {
    CONTENTS: {
      params: {
        CONTENTS: {
          ttid: {
            ...rnboParam("/rnbo/inst/12/params/ttid", 2741, 0, 4095, 0),
            CONTENTS: {
              ...rnboParam("/rnbo/inst/12/params/ttid", 2741, 0, 4095, 0).CONTENTS,
              meta: {
                VALUE: "[\"ttid\", \"display_precision:0\", \"display_as:int\", \"edit_as:int\"]"
              }
            }
          },
          Root: rnboParam("/rnbo/inst/12/params/Root", 0, 0, 11, 1)
        }
      }
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-12:ttid");
  assert.equal(targets[0].app, "ttid");
  assert.equal(targets[0].label, "TTID 12");
  assert.equal(targets[0].oscCapabilities.includes("ttid-edit"), true);
  assert.deepEqual(targets[0].parameters[0].meta, {
    tags: ["ttid", "display_precision:0", "display_as:int", "edit_as:int"],
    editor: "ttid",
    display_precision: 0,
    display_as: "int",
    edit_as: "int"
  });
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

test("plans scoped RNBO transport control writes", () => {
  const writes = rnboTransportControlWrites({
    id: "rnbo-inst-2:shadowscore",
    host: "192.168.68.96",
    port: 9000,
    address: "/rnbo/inst/2/messages/in/shadowscore"
  }, {
    Clock: 1,
    MaxSteps: 64,
    ClockInterval: 125,
    Tempo: 120,
    SetStage: 0,
    Stage: 0
  });

  assert.deepEqual(writes, [
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/params/Clock",
      value: 1
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/MaxSteps",
      value: 64
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/ClockInterval",
      value: 125
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/Tempo",
      value: 120
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/SetStage",
      value: 0
    },
    {
      host: "192.168.68.96",
      port: 9000,
      path: "/rnbo/inst/2/messages/in/Stage",
      value: 0
    }
  ]);
});

test("rejects unsupported RNBO transport writes", () => {
  assert.throws(
    () => rnboTransportControlWrites({
      id: "rnbo-inst-2:shadowscore",
      host: "192.168.68.96",
      port: 9000,
      address: "/rnbo/inst/2/messages/in/shadowscore"
    }, {
      Gain: 1
    }),
    /unsupported RNBO transport control 'Gain'/
  );
});

function createOscQueryTree() {
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
                            TYPE: "m",
                            VALUE: [40]
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

function rnboParam(path, value, min, max, index) {
  return {
    FULL_PATH: path,
    TYPE: "f",
    VALUE: value,
    RANGE: [{ MIN: min, MAX: max }],
    CONTENTS: {
      index: {
        VALUE: index
      },
      display_name: {
        VALUE: ""
      },
      normalized: {
        VALUE: value
      },
      meta: {
        VALUE: ""
      },
      unit: {
        VALUE: ""
      }
    }
  };
}
