import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../public/matrix-edit/index.html", import.meta.url);
const appRoot = new URL("../public/matrix-edit/", import.meta.url);
const buildInfoPath = new URL("../public/matrix-edit/build-info.json", import.meta.url);

test("Matrix Edit static app is an exported Vite app with /app assets", async () => {
  const html = await fs.readFile(appPath, "utf8");

  assert.match(html, /<script type="module" crossorigin src="\/app\/assets\/[^"]+\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/app\/assets\/[^"]+\.css">/);
});

test("Matrix Edit static app includes ShadowScore client wiring", async () => {
  const { js } = await readBuiltApp();

  assert.match(js, /\/session/);
  assert.match(js, /\/score/);
  assert.match(js, /\/collab/);
  assert.match(js, /\/events/);
  assert.match(js, /\/voices\/\$\{encodeURIComponent\([^}]+\)\}\/notes/);
  assert.match(js, /\/voices\/\$\{encodeURIComponent\([^}]+\)\}\/assignment/);
  assert.match(js, /new WebSocket/);
  assert.match(js, /new EventSource/);
  assert.match(js, /presence\.update/);
  assert.match(js, /voice\.notes\.replace/);
  assert.match(js, /voice\.assignment\.replace/);
});

test("Matrix Edit static app includes build provenance", async () => {
  const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));

  assert.equal(buildInfo.appName, "@matrixedit/rnbo-matrix-editor");
  assert.equal(buildInfo.target, "shadowscore-server");
  assert.equal(buildInfo.outputBase, "/app/");
  assert.match(buildInfo.matrixeditCommit, /^[0-9a-f]{40}$/);
  assert.doesNotThrow(() => new Date(buildInfo.buildTime).toISOString());
});

async function readBuiltApp() {
  const html = await fs.readFile(appPath, "utf8");
  const jsPath = html.match(/src="\/app\/(assets\/[^"]+\.js)"/)?.[1];
  const cssPath = html.match(/href="\/app\/(assets\/[^"]+\.css)"/)?.[1];

  assert.ok(jsPath, "expected built JS asset");
  assert.ok(cssPath, "expected built CSS asset");

  const [js, css] = await Promise.all([
    fs.readFile(new URL(jsPath, appRoot), "utf8"),
    fs.readFile(new URL(cssPath, appRoot), "utf8")
  ]);

  return { html, js, css };
}
