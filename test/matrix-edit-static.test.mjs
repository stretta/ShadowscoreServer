import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../public/matrix-edit/index.html", import.meta.url);
const appRoot = new URL("../public/matrix-edit/", import.meta.url);
const buildInfoPath = new URL("../public/matrix-edit/build-info.json", import.meta.url);

test("Matrix Edit static app is an exported Vite app with /matrix-edit assets", async () => {
  const html = await fs.readFile(appPath, "utf8");

  assert.match(html, /<script type="module" crossorigin src="\/matrix-edit\/assets\/[^"]+\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/matrix-edit\/assets\/[^"]+\.css">/);
  assert.match(html, /id="start-transport"/);
  assert.match(html, /id="stop-transport"/);
  assert.match(html, /id="create-clip"/);
  assert.match(html, /Create Clip/);
  assert.match(html, /id="duration"[^>]+value="0\.25"/);
  assert.match(html, /\/macrostructure\/playback\/\$\{running \? "start" : "stop"\}/);
  assert.match(html, /targetId: targetSelect\.value/);
  assert.match(html, /Macro playback/);
  assert.doesNotMatch(html, /\/rnbo\/targets\/\$\{encodeURIComponent\(targetId\)\}\/params/);
});

test("Matrix Edit static app includes ShadowScore client wiring", async () => {
  const { html, js } = await readBuiltApp();

  assert.match(html, /<select id="voice" aria-label="ShadowScore voice"><\/select>/);
  assert.match(html, /<select id="clip" aria-label="ShadowScore clip"><\/select>/);
  assert.doesNotMatch(html, /voice-picker/);
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
  assert.match(js, /clip\.add/);
  assert.match(js, /mesostructure\.block\.replace/);
  assert.match(js, /Switching \$\{[^}]+\} to clip/);
  assert.match(js, /Switch clip failed/);
  assert.match(js, /needs a clip in section/);
  assert.match(js, /Switch the whole score to/);
  assert.match(js, /\/admin\/restore/);
  assert.match(js, /cellFillFractions/);
  assert.match(js, /setCellFillFractions/);
  assert.match(js, /dragWithinCell/);
  assert.match(js, /cellY/);
  assert.match(js, /Velocity \$\{[^}]+\} selected for new notes\./);
  assert.match(js, /stage \$\{[^}]+\} velocity \$\{[^}]+\}\. Saving/);
  assert.doesNotMatch(js, /rowIndicators:m\(\)\?\[\]:vo\(e\.size\.height\)/);
});

test("Matrix Edit static app includes build provenance", async () => {
  const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));

  assert.equal(buildInfo.appName, "@matrixedit/rnbo-matrix-editor");
  assert.equal(buildInfo.target, "shadowscore-server");
  assert.equal(buildInfo.outputBase, "/matrix-edit/");
  assert.match(buildInfo.matrixeditCommit, /^[0-9a-f]{40}$/);
  assert.doesNotThrow(() => new Date(buildInfo.buildTime).toISOString());
});

async function readBuiltApp() {
  const html = await fs.readFile(appPath, "utf8");
  const jsPath = html.match(/src="\/matrix-edit\/(assets\/[^"]+\.js)"/)?.[1];
  const cssPath = html.match(/href="\/matrix-edit\/(assets\/[^"]+\.css)"/)?.[1];

  assert.ok(jsPath, "expected built JS asset");
  assert.ok(cssPath, "expected built CSS asset");

  const [js, css] = await Promise.all([
    fs.readFile(new URL(jsPath, appRoot), "utf8"),
    fs.readFile(new URL(cssPath, appRoot), "utf8")
  ]);

  return { html, js, css };
}
