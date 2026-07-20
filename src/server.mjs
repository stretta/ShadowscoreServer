#!/usr/bin/env node
import http from "node:http";
import { createRnboOscAdapter } from "./adapters/rnbo-osc.mjs";
import { attachWebSocketCollaboration } from "./collaboration/websocket.mjs";
import { loadConfig } from "./config.mjs";
import { distributeTtidForBlock, recallOscSnapshotsForBlock, routeRequest, writeTransportControlsToPlaybackTargets } from "./http/routes.mjs";
import { createMacroPlayback } from "./playback/macro-playback.mjs";
import { createRnboStageCollector } from "./playback/rnbo-stage-collector.mjs";
import { createOscSnapshotAutoRecall } from "./osc/snapshot-auto-recall.mjs";
import { createManualOscQueryDeviceRegistry } from "./oscquery/manual-device-registry.mjs";
import { createOscSnapshotRecallService } from "./osc/snapshot-recall.mjs";
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
const manualOscQueryDevices = createManualOscQueryDeviceRegistry(config);
const oscSnapshotRecall = createOscSnapshotRecallService();
const rnbo = createRnboOscAdapter(config, { peerRegistry });
const jackTransport = createJackTransportState(config);
const rnboStageCollector = createRnboStageCollector(config);
const jackController = config.transport?.jack?.enabled
  ? createJackTransportController(config)
  : null;
const runtime = {
  jackTransport,
  jackController,
  peerRegistry,
  manualOscQueryDevices,
  oscSnapshotRecall,
  rnboAdapter: rnbo,
  rnboStageCollector
};
const macroPlayback = createMacroPlayback(store, config, {
  jackTransport,
  beforeAdvance: ({ nextBlockId }) => rnbo.prepareBlock(nextBlockId),
  armAdvance: async () => {
    const activationSchedule = rnbo.schedulePreparedActivations?.({ initialStage: 0 }) ?? [];
    const phaseWrites = (await Promise.all(activationSchedule.map((activation) =>
      writeTransportControlsToPlaybackTargets(
        store.getScore(), config, runtime, { SetStage: activation.initialStage }, { targetId: activation.targetId }
      )
    ))).flat();
    const clockWrites = (await Promise.all(activationSchedule.map((activation) =>
      writeTransportControlsToPlaybackTargets(
        store.getScore(), config, runtime, { Clock: 1 }, { targetId: activation.targetId }
      )
    ))).flat();
    const activations = activationSchedule.length
      ? await rnbo.confirmPreparedActivations(activationSchedule, {
        tempo: store.getScore().macrostructure?.tempo
      })
      : [];
    return {
      action: "SetStage",
      value: 0,
      writes: phaseWrites,
      phaseWrites,
      clockWrites,
      activations
    };
  }
});
runtime.macroPlayback = macroPlayback;
const oscSnapshotAutoRecall = createOscSnapshotAutoRecall(store, {
  recall: async ({ blockId }) => {
    await distributeTtidForBlock(store.getScore(), config, runtime, blockId, { preferCachedTargets: true });
    return recallOscSnapshotsForBlock(store, config, runtime, blockId, { preferCachedTargets: true });
  },
  onError: (error, request) => console.error(`[osc-snapshot] automatic recall failed for ${request.blockId}: ${error.message}`)
});
runtime.oscSnapshotAutoRecall = oscSnapshotAutoRecall;
rnbo.attach(store);

const server = http.createServer((request, response) => {
  routeRequest(request, response, store, config, runtime).catch((error) => {
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

let shutdownPending = false;

async function shutdown() {
  if (shutdownPending) return;
  shutdownPending = true;
  collaboration.close();
  oscSnapshotAutoRecall.close();
  macroPlayback.close();
  rnbo.close();
  rnboStageCollector.close();
  server.close();
  server.closeAllConnections?.();
  try {
    await persistence.close();
    process.exit(0);
  } catch (error) {
    console.error(`[persistence] shutdown flush failed: ${error.message}`);
    process.exit(1);
  }
}
