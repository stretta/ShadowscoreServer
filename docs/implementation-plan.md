# ShadowscoreServer Implementation Plan

## Intent

ShadowscoreServer is the shared score server for an ensemble. It replaces the older "ShadowscoreBridge" idea with a clearer responsibility: the server is the source of truth for ensemble score state, while bridges and adapters connect that state to RNBO, Matrix Edit, or other clients.

The first target environment is Shadowbox hardware in the Berklee B51 lab.

## Core Model

The canonical score state is:

```js
{
  ensembleId: "berklee-b51",
  version: 1,
  context: {
    clip: {},
    scale: {},
    grid: {},
    seed: 0
  },
  assignments: {
    "player-1": {
      assignee: "",
      deviceId: "",
      clientId: null,
      label: "",
      color: "",
      locked: false
    }
  },
  voices: {
    "player-1": {
      version: 1,
      notes: []
    }
  }
}
```

`context` is shared across the ensemble. Scale changes, grid changes, and clip-level changes are committed once and broadcast to all clients.

Each `voice` owns a ShadowScore `notes` document. The first performance model assumes a player edits their own voice while seeing everyone else's voice as read-only reference material on the same grid.

## Transport

The first implementation uses HTTP JSON plus server-sent events:

- HTTP is simple for Matrix Edit and command-line testing.
- Server-sent events are available in browsers without a dependency.
- WebSocket can be added later if clients need bidirectional low-latency collaboration.

Draft endpoints:

- `GET /healthz`
- `GET /score`
- `GET /assignments`
- `POST /context`
- `POST /voices/:voiceId/assignment`
- `DELETE /voices/:voiceId/assignment`
- `POST /voices/:voiceId/notes`
- `POST /admin/reset`
- `GET /admin`
- `GET /events`

## Port Policy

Do not default RNBO adapter traffic to UDP `1234`. That is likely to collide with RNBO runner expectations.

The server default HTTP port is `8790`. RNBO/OSC output is disabled by default and must be enabled with an explicit host and port. The example config uses UDP `9000` only as a placeholder.

## Adapter Boundary

The Matrix Edit file `apps/rnbo-matrix-editor/bridge/rnbo-osc-bridge.mjs` is a useful prototype for HTTP-to-OSC writing, but ShadowscoreServer should keep adapters behind a boundary:

- score state logic does not import RNBO or OSC details.
- adapters subscribe to score updates.
- adapters can be enabled, disabled, or replaced per deployment.

## Milestones

1. Repository scaffold with documented data model, config, health check, score snapshot, context updates, voice note updates, and event streaming. Done.
2. Matrix Edit client wiring against the new HTTP/SSE API. Done in `/Users/mdavidson/Documents/matrixedit/apps/rnbo-matrix-editor`: the client now defaults to ShadowScore Server mode, loads `/score`, subscribes to `/events`, edits a selected voice, and syncs to `/voices/:voiceId/notes`.
3. Persistence for last-known score state on Shadowbox hardware. Done: the server loads a saved score on boot, reconciles it with configured voices, writes atomic JSON snapshots, and keeps a previous-snapshot backup.
4. RNBO/OSC adapter that transmits committed score updates to the running patch. Done: committed score changes are flattened across voices, compiled to v1 ShadowScore numeric transaction messages, and sent over UDP OSC to the configured RNBO inport.
5. Voice assignment and simple lab admin controls. Done: the score now carries per-voice assignment metadata, exposes assignment/update/clear/reset endpoints, persists assignment state, streams assignment events, and serves a dependency-free `/admin` lab page for voice assignment and basic resets.
6. Optional WebSocket/collaboration layer if multiple clients must edit the same voice concurrently.
