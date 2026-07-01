#!/usr/bin/env node
import http from "node:http";
import { createRnboOscAdapter } from "./adapters/rnbo-osc.mjs";
import { attachWebSocketCollaboration } from "./collaboration/websocket.mjs";
import { loadConfig } from "./config.mjs";
import { routeRequest, writeTransportControlsToPlaybackTargets } from "./http/routes.mjs";
import { createMacroPlayback } from "./playback/macro-playback.mjs";
import { createPeerRegistry } from "./registration/peer-registry.mjs";
import { createScorePersistence, loadPersistedScore } from "./state/persistence.mjs";
import { createInitialScore, createScoreStore } from "./state/score-store.mjs";
import { createJackTransportController } from "./transport/jack-transport-control.mjs";
import { createJackTransportState } from "./transport/jack-transport-state.mjs";

const config = await loadConfig();
const defaultScore = createInitialScore(config);
const initialScore = await loadPersistedScore(config, defaultScore);
const store = createScoreStore(initialScore, { defaultScore });
const persistence = createScorePersistence(store, config);
const peerRegistry = createPeerRegistry(config);
const rnbo = createRnboOscAdapter(config, { peerRegistry });
const jackTransport = createJackTransportState(config);
const jackController = config.transport?.jack?.enabled
  ? createJackTransportController(config)
  : null;
const macroPlayback = createMacroPlayback(store, config, {
  jackTransport,
  afterAdvance: async () => ({
    action: "SetStage",
    value: 0,
    writes: await writeTransportControlsToPlaybackTargets(store.getScore(), config, { peerRegistry }, { SetStage: 0 })
  })
});
rnbo.attach(store);

const server = http.createServer((request, response) => {
  routeRequest(request, response, store, config, { jackTransport, jackController, macroPlayback, peerRegistry, rnboAdapter: rnbo }).catch((error) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  });
});
const collaboration = attachWebSocketCollaboration(server, store, config);

server.listen(config.http.port, config.http.host, () => {
  console.log(`[http] ShadowscoreServer listening on http://${config.http.host}:${config.http.port}`);
  console.log("[collab] websocket endpoint available at /collab");
  console.log("[hardware] registration endpoint available at /hardware/register");
  console.log(`[score] ensemble=${config.ensemble.id} voices=${config.ensemble.voices.join(",")}`);
  if (config.rnbo.enabled) {
    console.log(`[rnbo] adapter enabled for ${config.rnbo.host}:${config.rnbo.port}`);
  }
  if (persistence.enabled) {
    console.log(`[persistence] writing snapshots to ${config.persistence.path}`);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  server.close(async () => {
    try {
      await persistence.close();
      collaboration.close();
      macroPlayback.close();
      rnbo.close();
      process.exit(0);
    } catch (error) {
      console.error(`[persistence] shutdown flush failed: ${error.message}`);
      process.exit(1);
    }
  });
}
