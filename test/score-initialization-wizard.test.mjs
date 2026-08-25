import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { defaultConfig } from "../src/config.mjs";
import { adminPage } from "../src/http/admin-page.mjs";
import { routeRequest } from "../src/http/routes.mjs";
import {
  createScoreInitializationPlan,
  createWizardScoreInitializationRequest
} from "../src/state/score-initialization.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("score initialization wizard creates independent empty clips by default", () => {
  const request = createWizardScoreInitializationRequest({
    name: "Seven by six",
    playerCount: 7,
    blockCount: 6,
    blockBars: 2,
    tempo: 96
  });
  const plan = createScoreInitializationPlan(request, { ensembleId: "test" });

  assert.equal(plan.summary.playerCount, 7);
  assert.equal(plan.summary.blockCount, 6);
  assert.equal(plan.summary.clipCount, 42);
  assert.equal(plan.summary.noteCount, 0);
  assert.deepEqual(plan.summary.macroOrder, ["A", "B", "C", "D", "E", "F"]);
  assert.equal(plan.score.mesostructure.A.tempo, 96);
  assert.deepEqual(plan.score.mesostructure.A.duration, { bars: 2 });
  assert.deepEqual(plan.score.mesostructure.A.scale, {
    root_note: 0,
    scale_intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    scale_name: "Chromatic"
  });
  assert.equal(plan.score.mesostructure.A.ttid, 4095);
  assert.equal(plan.score.mesostructure.A.players["player-1"], "a-player-1");
  assert.equal(plan.score.mesostructure.B.players["player-1"], "b-player-1");
  assert.notEqual(
    plan.score.mesostructure.A.players["player-1"],
    plan.score.mesostructure.B.players["player-1"]
  );
  assert.deepEqual(plan.score.clips["a-player-1"].notes, []);
  assert.deepEqual(plan.score.clips["a-player-1"].duration, { bars: 2 });
  assert.equal(plan.score.context.scale.scale_name, "Chromatic");
  assert.equal(plan.score.clips["a-player-1"].context.scale.scale_name, "Chromatic");
  assert.equal(plan.score.clips["a-player-1"].behavior.initialization.placeholder, true);
  assert.equal(plan.score.clips["a-player-1"].behavior.initialization.material, "empty");
  assert.equal(plan.score.clips["a-player-1"].behavior.initialization.clipDurationMultiplier, 1);
});

test("score initialization wizard scales clip duration independently from block duration", () => {
  const half = createScoreInitializationPlan(createWizardScoreInitializationRequest({
    playerCount: 1,
    blockCount: 1,
    blockBars: 3,
    clipDurationMultiplier: 0.5
  }));
  const quarter = createScoreInitializationPlan(createWizardScoreInitializationRequest({
    playerCount: 1,
    blockCount: 1,
    blockBars: 3,
    clipDurationMultiplier: 0.25
  }));

  assert.deepEqual(half.score.mesostructure.A.duration, { bars: 3 });
  assert.deepEqual(half.score.clips["a-player-1"].duration, { bars: 1.5 });
  assert.deepEqual(quarter.score.clips["a-player-1"].duration, { bars: 0.75 });
});

test("score initialization wizard can add test notes to only the first block", () => {
  const request = createWizardScoreInitializationRequest({
    players: [
      { id: "player-1", label: "Finch" },
      { id: "player-2", label: "Heron" }
    ],
    blockCount: 3,
    material: "first-block"
  });
  const plan = createScoreInitializationPlan(request);

  assert.equal(plan.summary.noteCount, 2);
  assert.deepEqual(plan.score.clips["a-player-1"].notes, [{ pitch: 48, start_time: 0, duration: 0.25, velocity: 100 }]);
  assert.deepEqual(plan.score.clips["a-player-2"].notes, [{ pitch: 49, start_time: 0, duration: 0.25, velocity: 100 }]);
  assert.deepEqual(plan.score.clips["b-player-1"].notes, []);
  assert.equal(plan.score.assignments["player-1"].label, "Finch");
  assert.equal(plan.score.assignments["player-2"].label, "Heron");
});

test("score initialization wizard can fill every block with sparse test notes", () => {
  const request = createWizardScoreInitializationRequest({
    playerCount: 4,
    blockCount: 6,
    material: "all-blocks"
  });
  const plan = createScoreInitializationPlan(request);

  assert.equal(plan.summary.clipCount, 24);
  assert.equal(plan.summary.noteCount, 24);
  assert.equal(plan.score.clips["f-player-4"].notes[0].pitch, 51);
});

test("score initialization wizard validates bounded counts and material modes", () => {
  assert.throws(
    () => createWizardScoreInitializationRequest({ playerCount: 0, blockCount: 1 }),
    /playerCount must be an integer from 1 through 32/
  );
  assert.throws(
    () => createWizardScoreInitializationRequest({ playerCount: 1, blockCount: 33 }),
    /blockCount must be an integer from 1 through 32/
  );
  assert.throws(
    () => createWizardScoreInitializationRequest({ playerCount: 1, blockCount: 1, material: "seeded defaults" }),
    /material must be/
  );
  assert.throws(
    () => createWizardScoreInitializationRequest({ playerCount: 1, blockCount: 1, clipDurationMultiplier: 0.75 }),
    /clipDurationMultiplier must be 1, 0.5, or 0.25/
  );
});

test("Admin exposes a preview-first New Score wizard with optional test material", () => {
  const page = adminPage();

  assert.match(page, /id="score-wizard"/);
  assert.match(page, /Use current playback clients/);
  assert.match(page, /value="empty" checked/);
  assert.match(page, /Test notes in the first block/);
  assert.match(page, /Test notes in every block/);
  assert.match(page, /0\.5× block duration/);
  assert.match(page, /0\.25× block duration/);
  assert.match(page, /\/admin\/scores\/initialize\/preview/);
  assert.match(page, /\/admin\/scores\/initialize/);
  assert.match(page, /\/playback\/updates\/update-now/);
});

test("score initialization routes preview and apply compact wizard requests", async () => {
  const initialScore = createInitialScore(defaultConfig);
  const context = {
    store: createScoreStore(initialScore, { defaultScore: initialScore }),
    config: defaultConfig,
    runtime: {}
  };
  const wizard = {
    name: "Route wizard",
    playerCount: 3,
    blockCount: 2,
    material: "first-block"
  };

  const preview = await routeJson(context, "/admin/scores/initialize/preview", { wizard });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.summary.playerCount, 3);
  assert.equal(preview.summary.clipCount, 6);
  assert.equal(preview.summary.noteCount, 3);

  const initialized = await routeJson(context, "/admin/scores/initialize", {
    wizard,
    expectedVersion: preview.base.version,
    expectedScoreRevision: preview.base.scoreRevision,
    expectedStructureRevision: preview.base.structureRevision
  });
  assert.equal(initialized.dryRun, false);
  assert.deepEqual(Object.keys(initialized.score.voices), ["player-1", "player-2", "player-3"]);
  assert.deepEqual(Object.keys(initialized.score.mesostructure), ["A", "B"]);
  assert.equal(initialized.score.clips["a-player-1"].notes.length, 1);
  assert.equal(initialized.score.clips["b-player-1"].notes.length, 0);
});

async function routeJson(context, url, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = "POST";
  request.url = url;
  request.headers = { host: "127.0.0.1" };
  request.socket = { remoteAddress: "127.0.0.1" };
  const headers = {};
  let status = 200;
  let responseBody = "";
  const response = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(nextStatus, nextHeaders = {}) { status = nextStatus; Object.assign(headers, nextHeaders); },
    write(chunk) { responseBody += chunk; },
    end(chunk = "") { responseBody += chunk; },
    on() {}
  };
  await routeRequest(request, response, context.store, context.config, context.runtime);
  assert.ok(status >= 200 && status < 300, responseBody);
  assert.equal(headers["Content-Type"], "application/json");
  return JSON.parse(responseBody);
}
