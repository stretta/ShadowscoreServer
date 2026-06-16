#!/usr/bin/env node
import http from "node:http";
import { createRnboOscAdapter } from "./adapters/rnbo-osc.mjs";
import { loadConfig } from "./config.mjs";
import { routeRequest } from "./http/routes.mjs";
import { createInitialScore, createScoreStore } from "./state/score-store.mjs";

const config = await loadConfig();
const store = createScoreStore(createInitialScore(config));
const rnbo = createRnboOscAdapter(config);
rnbo.attach(store);

const server = http.createServer((request, response) => {
  routeRequest(request, response, store, config).catch((error) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  });
});

server.listen(config.http.port, config.http.host, () => {
  console.log(`[http] ShadowscoreServer listening on http://${config.http.host}:${config.http.port}`);
  console.log(`[score] ensemble=${config.ensemble.id} voices=${config.ensemble.voices.join(",")}`);
  if (config.rnbo.enabled) {
    console.log(`[rnbo] adapter enabled for ${config.rnbo.host}:${config.rnbo.port}`);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}
