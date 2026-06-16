import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { defaultConfig } from "../src/config.mjs";
import { routeRequest } from "../src/http/routes.mjs";
import { createInitialScore, createScoreStore } from "../src/state/score-store.mjs";

test("assignment routes expose, replace, and clear voice assignments", async () => {
  const context = createRouteContext();

  const saved = await requestJson(context, "POST", "/voices/player-1/assignment", {
    assignee: "Ari",
    deviceId: "shadowbox-05"
  });
  assert.equal(saved.assignments["player-1"].assignee, "Ari");

  const assignments = await requestJson(context, "GET", "/assignments");
  assert.equal(assignments["player-1"].deviceId, "shadowbox-05");

  const cleared = await requestJson(context, "DELETE", "/voices/player-1/assignment");
  assert.equal(cleared.assignments["player-1"].assignee, "");
});

test("admin reset route clears requested score sections", async () => {
  const context = createRouteContext();

  await requestJson(context, "POST", "/voices/player-1/notes", [{ pitch: 60 }]);
  await requestJson(context, "POST", "/voices/player-1/assignment", { assignee: "Ari" });

  const reset = await requestJson(context, "POST", "/admin/reset", {
    voices: true,
    assignments: true
  });

  assert.deepEqual(reset.voices["player-1"].notes, []);
  assert.equal(reset.assignments["player-1"].assignee, "");
});

test("admin page is served as html", async () => {
  const context = createRouteContext();
  const response = await request(context, "GET", "/admin");

  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.body, /Shadowscore Lab Admin/);
});

function createRouteContext() {
  return {
    store: createScoreStore(createInitialScore(defaultConfig)),
    config: defaultConfig
  };
}

async function requestJson(context, method, url, body) {
  const response = await request(context, method, url, body);
  assert.equal(response.headers["Content-Type"], "application/json");
  assert.ok(response.status >= 200 && response.status < 300, `${response.status} ${response.body}`);
  return JSON.parse(response.body);
}

async function request(context, method, url, body) {
  const request = createRequest(method, url, body);
  const response = createResponse();
  await routeRequest(request, response, context.store, context.config);
  return response.snapshot();
}

function createRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = { host: "127.0.0.1" };
  return request;
}

function createResponse() {
  const headers = {};
  let status = 200;
  let body = "";

  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      Object.assign(headers, nextHeaders);
    },
    write(chunk) {
      body += chunk;
    },
    end(chunk = "") {
      body += chunk;
    },
    snapshot() {
      return { status, headers, body };
    }
  };
}
