import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../public/piano-roll/index.html", import.meta.url);
const jsUrl = new URL("../public/piano-roll/app.js", import.meta.url);

test("Piano Roll exposes explicit draft controls and editing surfaces", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /<title>ShadowScore Piano Roll<\/title>/);
  assert.match(html, /id="save"[^>]*disabled/);
  assert.match(html, /id="revert"[^>]*disabled/);
  assert.match(html, /id="roll"/);
  assert.match(html, /id="roll"[^>]*tabindex="0"/);
  assert.match(html, /id="velocity"/);
});

test("Piano Roll saves revision-aware clip drafts and supports right-edge resize", async () => {
  const js = await readFile(jsUrl, "utf8");
  assert.match(js, /expectedVersion:state\.score\.version/);
  assert.match(js, /kind:right-p\.x<=9\?"resize":"move"/);
  assert.match(js, /resizeNoteRight/);
  assert.match(js, /moveNote/);
  assert.match(js, /projectClipOccurrences/);
  assert.match(js, /\/macrostructure\/playback/);
  assert.match(js, /drawWiper/);
  assert.match(js, /addEventListener\("keydown"/);
  assert.match(js, /nudgeNote/);
  assert.match(js, /pointercancel",cancelDrag/);
  assert.match(js, /state\.draft\.notes\.push/);
  assert.match(js, /Save failed:/);
});
