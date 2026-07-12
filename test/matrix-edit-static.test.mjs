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
  assert.match(html, /<link rel="stylesheet" href="\/shared\/shadowscore-style\.css"\s*\/?>/);
  assert.match(html, /<nav class="ss-route-tabs" aria-label="ShadowScore routes">/);
  assert.match(html, /<a href="\/matrix-edit" aria-current="page">Matrix<\/a>/);
  assert.match(html, /<a href="\/piano-roll">Piano Roll<\/a>/);
  assert.match(html, /<a href="\/editors">OSC Generators<\/a>/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.match(html, /id="start-transport"/);
  assert.match(html, /id="stop-transport"/);
  assert.match(html, /id="return-start"/);
  assert.match(html, /id="create-clip"/);
  assert.match(html, /id="projection-header"/);
  assert.match(html, /id="playing-block"/);
  assert.match(html, /id="projection-playback"/);
  assert.match(html, /performance-toolbar/);
  assert.match(html, /<div class="toolbar compact">[\s\S]*<div class="edit-tools" aria-label="Focused player editing tools">/);
  assert.match(html, /advanced-panel/);
  assert.match(html, /Play/);
  assert.match(html, /Return to A/);
  assert.match(html, /Create Clip/);
  assert.match(html, /id="duration"[^>]+value="0\.25"/);
  assert.doesNotMatch(html, /\/macrostructure\/playback\/\$\{running \? "start" : "stop"\}/);
  assert.doesNotMatch(html, /targetId: targetSelect\.value/);
  assert.doesNotMatch(html, /\/rnbo\/targets\/\$\{encodeURIComponent\(targetId\)\}\/params/);
});

test("Matrix Edit static app includes ShadowScore client wiring", async () => {
  const { html, js, css } = await readBuiltApp();

  assert.match(html, /<span class="voice-combobox">/);
  assert.match(html, /<select id="voice" class="native-voice-select" aria-label="ShadowScore player" tabindex="-1"><\/select>/);
  assert.match(html, /id="voice-menu-button"/);
  assert.match(html, /aria-controls="voice-menu-options"/);
  assert.match(html, /id="voice-color-swatch"/);
  assert.match(html, /id="voice-menu-options" class="voice-menu-options" role="listbox" hidden/);
  assert.match(html, /<select id="clip" aria-label="ShadowScore clip"><\/select>/);
  assert.match(html, /<select id="rnbo-target" aria-label="Live client"><\/select>/);
  assert.match(html, /id="routing-status"/);
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
  assert.match(js, /\/transport\//);
  assert.match(js, /return-to-start/);
  assert.match(js, /Transport/);
  assert.match(js, /cellFillFractions/);
  assert.match(js, /setCellFillFractions/);
  assert.match(js, /dragWithinCell/);
  assert.match(js, /cellY/);
  assert.match(js, /Velocity \$\{[^}]+\} selected for new notes\./);
  assert.match(js, /clip stage \$\{[^}]+\}\$\{[^}]+\} velocity \$\{[^}]+\}\. Saving/);
  assert.match(js, /via alias/);
  assert.match(js, /aliases mapped/);
  assert.match(js, /No live client/);
  assert.match(js, /Assigned target offline/);
  assert.match(js, /Choose a live client/);
  assert.doesNotMatch(js, /rowIndicators:m\(\)\?\[\]:vo\(e\.size\.height\)/);
  assert.match(css, /input\[type=number\].*appearance:textfield/);
  assert.match(css, /webkit-inner-spin-button/);
  assert.match(css, /performance-toolbar/);
  assert.match(css, /advanced-panel/);
  assert.match(css, /voice-menu-option/);
  assert.match(css, /--ss-bg:\s*#111821/);
  assert.match(css, /ss-route-tabs/);
  assert.match(css, /routing-status/);
  assert.match(css, /routing-status\.ambiguous/);
  assert.match(css, /grid-template-rows:auto auto auto minmax\(320px,1fr\) auto/);
  assert.match(css, /\.edit-tools\{[^}]*display:flex[^}]*flex-wrap:nowrap[^}]*margin-left:auto/);
});

test("Matrix Edit static app includes build provenance", async () => {
  const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));

  assert.equal(buildInfo.appName, "@matrixedit/rnbo-matrix-editor");
  assert.equal(buildInfo.target, "shadowscore-server");
  assert.equal(buildInfo.outputBase, "/matrix-edit/");
  assert.match(buildInfo.matrixeditCommit, /^[0-9a-f]{40}$/);
  assert.equal(buildInfo.matrixeditDirty, false);
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
