import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../public/matrix-edit/index.html", import.meta.url);

test("Matrix Edit static app includes Phase 4 ensemble collaboration wiring", async () => {
  const html = await fs.readFile(appPath, "utf8");

  assert.match(html, /fetch\("\/session"\)/);
  assert.match(html, /new WebSocket\(url\)/);
  assert.match(html, /type: "presence\.update"/);
  assert.match(html, /type: "voice\.notes\.replace"/);
  assert.match(html, /expectedVoiceVersion: score\.voices\[selectedVoiceId\]\.version/);
});

test("Matrix Edit static app renders server voices as a radio group with layer opacity states", async () => {
  const html = await fs.readFile(appPath, "utf8");

  assert.match(html, /role="radiogroup"/);
  assert.match(html, /radio\.type = "radio"/);
  assert.match(html, /orderedVoiceIds\(\)/);
  assert.match(html, /\.note\.editable \{ opacity: 0\.95; \}/);
  assert.match(html, /\.note\.reference \{ opacity: 0\.24; \}/);
});

test("Matrix Edit static app exposes disconnected and stale-write states", async () => {
  const html = await fs.readFile(appPath, "utf8");

  assert.match(html, /Server unavailable:/);
  assert.match(html, /Disconnected\. Reconnect before saving\./);
  assert.match(html, /message\.error\?\.includes\("stale"\)/);
});
