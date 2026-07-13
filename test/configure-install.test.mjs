import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInstallConfig, configureInstall } from "../bin/configure-install.mjs";
import { defaultConfig } from "../src/config.mjs";

const hostOptions = {
  role: "host",
  publicUrl: "http://wren.local:8790",
  sessionHostUrl: "",
  hostIdentity: "wren",
  advertisedName: "Wren",
  jackTransport: false,
  jackTransportIntervalMs: 75
};

test("installer config registry stays aligned with default applications and editors", () => {
  const config = buildInstallConfig({ http: {}, static: {} }, null, hostOptions);

  assert.deepEqual(config.static.apps, defaultConfig.static.apps);
  assert.deepEqual(config.editors, defaultConfig.editors);
  assert.deepEqual(config.static.apps.pianoRoll.routes, ["/piano-roll"]);
  assert.deepEqual(config.static.apps.analogSequencerEditor.routes, ["/editors/analogsequencer"]);
  assert.deepEqual(config.static.apps.listVelSequencerEditor.routes, ["/editors/listvelsequencer"]);
  assert.deepEqual(config.static.apps.softPianoEditor.routes, ["/editors/softpiano"]);
});

test("installer updates preserve local settings and custom registry entries", () => {
  const local = {
    http: { port: 9001 },
    server: { customSetting: true },
    static: {
      apps: {
        customApp: { root: "public/custom", index: "index.html", routes: ["/custom"] }
      }
    },
    editors: [
      { id: "poland", label: "Local Poland", route: "/editors/poland", targetFilter: { app: "poland" } },
      { id: "custom", label: "Custom", route: "/editors/custom", targetFilter: { app: "custom" } }
    ]
  };

  const config = buildInstallConfig({}, local, hostOptions);

  assert.equal(config.http.port, 9001);
  assert.equal(config.http.publicUrl, "http://wren.local:8790");
  assert.equal(config.server.customSetting, true);
  assert.equal(config.static.apps.customApp.routes[0], "/custom");
  assert.equal(config.static.apps.pianoRoll.routes[0], "/piano-roll");
  assert.equal(config.editors.find((editor) => editor.id === "poland").label, "Local Poland");
  assert.equal(config.editors.some((editor) => editor.id === "custom"), true);
  assert.equal(config.editors.some((editor) => editor.id === "analogsequencer"), true);
  assert.equal(config.editors.some((editor) => editor.id === "listvelsequencer"), true);
  assert.equal(config.editors.some((editor) => editor.id === "softpiano"), true);
});

test("installer writes a fresh config and then updates it in place", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadowscore-install-"));
  const templatePath = path.join(directory, "template.json");
  const configPath = path.join(directory, "local.json");
  fs.writeFileSync(templatePath, JSON.stringify({ http: { port: 8790 }, static: {} }));

  configureInstall({ templatePath, configPath, ...hostOptions });
  const first = JSON.parse(fs.readFileSync(configPath, "utf8"));
  first.localOnly = "keep-me";
  fs.writeFileSync(configPath, JSON.stringify(first));
  configureInstall({ templatePath, configPath, ...hostOptions, advertisedName: "Wren Updated" });
  const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(updated.localOnly, "keep-me");
  assert.equal(updated.server.advertisedName, "Wren Updated");
});
