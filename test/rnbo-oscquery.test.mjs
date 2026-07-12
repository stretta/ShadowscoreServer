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

test("extracts SoftPiano OSC control targets from RNBOOSCQuery instance names", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: { host: "192.168.68.96", port: 1234, oscQuery: { enabled: true, url: "http://pt5.local:5678/" } }
  });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: { info: { CONTENTS: { ports: { CONTENTS: { properties: { CONTENTS: {
      "SoftPiano-7:out1": { VALUE: "{\"rnbo-instance-id\":7,\"source\":true,\"type\":\"audio\"}" }
    } } } } } } }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["7"] = {
    CONTENTS: { params: { CONTENTS: {
      LowPass: rnboParam("/rnbo/inst/7/params/LowPass", 8000, 20, 20000, 0),
      FilterVel: rnboParam("/rnbo/inst/7/params/FilterVel", 0.5, 0, 1, 1),
      FilterKeyTracking: rnboParam("/rnbo/inst/7/params/FilterKeyTracking", 0.5, 0, 1, 2),
      Spread: rnboParam("/rnbo/inst/7/params/Spread", 0.25, 0, 1, 3),
      Attack: rnboParam("/rnbo/inst/7/params/Attack", 0.01, 0, 2, 4),
      Decay: rnboParam("/rnbo/inst/7/params/Decay", 0.5, 0, 4, 5),
      Sustain: rnboParam("/rnbo/inst/7/params/Sustain", 0.8, 0, 1, 6),
      Release: rnboParam("/rnbo/inst/7/params/Release", 1, 0, 8, 7)
    } } }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-7:softpiano");
  assert.equal(targets[0].app, "softpiano");
  assert.equal(targets[0].label, "Softpiano 7");
  assert.equal(targets[0].instance, "main");
  assert.equal(targets[0].oscCapabilities.includes("softpiano-edit"), true);
  assert.equal(targets[0].parameters.length, 8);
});

test("control target identity prefers explicit RNBO parameter metadata", () => {
  const config = mergeConfig(defaultConfig, { rnbo: { host: "127.0.0.1", port: 1234 } });
  const tree = createOscQueryTree();
  const gain = rnboParam("/rnbo/inst/18/params/Gain", 0.5, 0, 1, 0);
  gain.CONTENTS.meta = { VALUE: "{\"app\":\"GranularClouds\",\"capabilities\":[\"freeze\"]}" };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["18"] = { CONTENTS: { params: { CONTENTS: { Gain: gain } } } };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].app, "granularclouds");
  assert.equal(targets[0].id, "rnbo-inst-18:granularclouds");
  assert.equal(targets[0].oscCapabilities.includes("granularclouds-edit"), true);
  assert.equal(targets[0].oscCapabilities.includes("freeze"), true);
});

test("control target discovery publishes previously unknown named RNBO apps", () => {
  const config = mergeConfig(defaultConfig, { rnbo: { host: "127.0.0.1", port: 1234 } });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: { info: { CONTENTS: { ports: { CONTENTS: { properties: { CONTENTS: {
      "Granular Clouds-19:out1": { VALUE: "{\"rnbo-instance-id\":19,\"source\":true,\"type\":\"audio\"}" }
    } } } } } } }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["19"] = {
    CONTENTS: { params: { CONTENTS: { Density: rnboParam("/rnbo/inst/19/params/Density", 4, 1, 20, 0) } } }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].app, "granular-clouds");
  assert.equal(targets[0].oscCapabilities.includes("granular-clouds-edit"), true);
});

test("control target discovery keeps unnamed controllable RNBO instances generic", () => {
  const config = mergeConfig(defaultConfig, { rnbo: { host: "127.0.0.1", port: 1234 } });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["20"] = {
    CONTENTS: { params: { CONTENTS: { Gain: rnboParam("/rnbo/inst/20/params/Gain", 0.5, 0, 1, 0) } } }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].app, "rnbo-instance");
  assert.equal(targets[0].id, "rnbo-inst-20:rnbo-instance");
});

test("control target discovery excludes named ShadowScore playback protocol instances", () => {
  const config = mergeConfig(defaultConfig, { rnbo: { host: "127.0.0.1", port: 1234 } });
  const tree = createOscQueryTree();
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: { info: { CONTENTS: { ports: { CONTENTS: { properties: { CONTENTS: {
      "ShadowScoreClient-2:out1": { VALUE: "{\"rnbo-instance-id\":2,\"source\":true,\"type\":\"audio\"}" }
    } } } } } } }
  };

  assert.deepEqual(extractRnboControlTargets(tree, config), []);
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

test("extracts ListSequencer OSC control targets with message inports and TTID params", () => {
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
  tree.CONTENTS.rnbo.CONTENTS.jack = {
    CONTENTS: {
      info: {
        CONTENTS: {
          ports: {
            CONTENTS: {
              properties: {
                CONTENTS: {
                  "ListSequencer-13:out1": {
                    VALUE: "{\"rnbo-instance-id\":13,\"source\":true,\"type\":\"audio\"}"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["13"] = {
    CONTENTS: {
      params: {
        CONTENTS: {
          ClockRate: rnboParam("/rnbo/inst/13/params/ClockRate", "16n", undefined, undefined, 0),
          Root: rnboParam("/rnbo/inst/13/params/Root", 60, 0, 127, 1),
          ChromaticTranspose: rnboParam("/rnbo/inst/13/params/ChromaticTranspose", 0, -24, 24, 2),
          ScalarTranspose: rnboParam("/rnbo/inst/13/params/ScalarTranspose", 0, -24, 24, 3),
          Scale: {
            ...rnboParam("/rnbo/inst/13/params/Scale", 2741, 0, 4095, 4),
            CONTENTS: {
              ...rnboParam("/rnbo/inst/13/params/Scale", 2741, 0, 4095, 2).CONTENTS,
              meta: {
                VALUE: "{\"display_precision\":\"0\",\"editor\":\"ttid\"}"
              }
            }
          }
        }
      },
      messages: {
        CONTENTS: {
          in: {
            CONTENTS: {
              Steps: rnboInport("/rnbo/inst/13/messages/in/Steps"),
              PrimaryRotation: rnboInport("/rnbo/inst/13/messages/in/PrimaryRotation"),
              SecondaryRotation: rnboInport("/rnbo/inst/13/messages/in/SecondaryRotation"),
              Velocity: rnboInport("/rnbo/inst/13/messages/in/Velocity"),
              Duration: rnboInport("/rnbo/inst/13/messages/in/Duration")
            }
          }
        }
      }
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-13:listsequencer");
  assert.equal(targets[0].app, "listsequencer");
  assert.equal(targets[0].label, "Listsequencer 13");
  assert.equal(targets[0].oscCapabilities.includes("listsequencer-edit"), true);
  assert.equal(targets[0].oscCapabilities.includes("ttid-edit"), true);
  assert.deepEqual(targets[0].inputPorts.map((inputPort) => inputPort.name), [
    "Duration",
    "PrimaryRotation",
    "SecondaryRotation",
    "Steps",
    "Velocity"
  ]);
  assert.equal(targets[0].parameters.find((param) => param.name === "Scale")?.meta?.editor, "ttid");
});

test("extracts AnalogSequencer OSC control targets with zero-padded stage params", () => {
  const config = mergeConfig(defaultConfig, {
    rnbo: {
      host: "127.0.0.1",
      port: 1234,
      oscQuery: {
        enabled: true,
        url: "http://wren.local:5678/"
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
                  "AnalogSequencer-15:out1": {
                    VALUE: "{\"rnbo-instance-id\":15,\"source\":true,\"type\":\"midi\"}"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  tree.CONTENTS.rnbo.CONTENTS.inst.CONTENTS["15"] = {
    CONTENTS: {
      params: {
        CONTENTS: {
          "01StageStep": rnboParam("/rnbo/inst/15/params/01StageStep", 1, 0, 1, 0),
          "01StageValue": rnboParam("/rnbo/inst/15/params/01StageValue", 61, 0, 127, 1),
          "02StageStep": rnboParam("/rnbo/inst/15/params/02StageStep", 0, 0, 1, 2),
          "02StageValue": rnboParam("/rnbo/inst/15/params/02StageValue", 64, 0, 127, 3)
        }
      },
      messages: {
        CONTENTS: {
          in: {
            CONTENTS: {
              rtz: rnboInport("/rnbo/inst/15/messages/in/rtz")
            }
          }
        }
      }
    }
  };

  const targets = extractRnboControlTargets(tree, config);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "rnbo-inst-15:analogsequencer");
  assert.equal(targets[0].app, "analogsequencer");
  assert.equal(targets[0].label, "Analogsequencer 15");
  assert.equal(targets[0].oscCapabilities.includes("analogsequencer-edit"), true);
  assert.deepEqual(targets[0].inputPorts.map((inputPort) => inputPort.name), ["rtz"]);
  assert.deepEqual(targets[0].parameters.map((param) => param.name), [
    "01StageStep",
    "01StageValue",
    "02StageStep",
    "02StageValue"
  ]);
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

function rnboInport(path) {
  return {
    FULL_PATH: path,
    TYPE: "",
    VALUE: [],
    CONTENTS: {
      meta: {
        VALUE: ""
      }
    }
  };
}
