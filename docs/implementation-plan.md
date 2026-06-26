# ShadowscoreServer Implementation Plan

## Intent

ShadowscoreServer is the shared score server for an ensemble. It replaces the older "ShadowscoreBridge" idea with a clearer responsibility: the server is the source of truth for ensemble score state, while bridges and adapters connect that state to RNBO, Matrix Edit, or other clients.

The first target environment is Shadowbox hardware in the Berklee B51 lab. Early testing used a six-player setup, but the data model and protocol treat voices as an arbitrary session-sized collection rather than a fixed ensemble size.

## Core Model

The score began as a voice-note server, but the current canonical model is
clip-and-structure first. Legacy voice note documents remain in the score for
compatibility and migration, while new composition work should flow through
`clips`, `mesostructure`, `macrostructure`, and `structureState`.

The core score state is:

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
  },
  clips: {
    "clip-a": {
      notes: [],
      duration: { bars: 1 },
      playbackType: "looped",
      context: { clip: {}, scale: {}, grid: {}, seed: 0 },
      behavior: {}
    }
  },
  mesostructure: {
    A: {
      duration: { bars: 8 },
      players: {
        "player-1": { clipId: "clip-a" }
      }
    }
  },
  macrostructure: {
    tempo: 120,
    blocks: ["A"]
  },
  structureState: {
    activeBlockId: "A",
    macroIndex: 0
  }
}
```

`context` is shared across the ensemble. Score-wide scale and grid defaults are
committed once and broadcast to all clients. Clip-local context lives on each
clip, including the clip time signature used by Matrix Edit for time
delineation.

Each `clip` owns a ShadowScore `notes` document plus clip attributes such as
duration, playback type, and behavior flags. A mesostructural block assigns
clips to players. A looped clip repeats across the containing block duration; a
one-shot clip plays once.

Each `voice` still owns a ShadowScore `notes` document, but this is now legacy
compatibility data. The first performance model assumes a player edits their
assigned clip while seeing everyone else's block-assigned clips as read-only
reference material on the same grid.

A voice is not the same thing as a browser client, hardware unit, or human performer. One performer may manage multiple clients, multiple clients may observe or edit the same voice, and the active voice set can be configured, restored from a score backup, or changed at runtime.

## Transport

The first implementation uses HTTP JSON plus server-sent events:

- HTTP is simple for Matrix Edit and command-line testing.
- Server-sent events are available in browsers without a dependency.
- WebSocket collaboration is available at `/collab` for bidirectional client commands, presence, and guarded writes.

Implemented endpoint groups include:

- `GET /healthz`
- `GET /score`
- `GET /session`
- `GET /assignments`
- `GET /clips`
- `GET /structure`
- `GET /structure/playhead`
- `GET /macrostructure/playback`
- `POST /voices`
- `DELETE /voices/:voiceId`
- `POST /context`
- `POST /clips`
- `POST /clips/:clipId`
- `POST /clips/:clipId/rename`
- `DELETE /clips/:clipId`
- `POST /mesostructure/:blockId`
- `DELETE /mesostructure/:blockId`
- `POST /macrostructure`
- `POST /structure/playhead`
- `POST /macrostructure/advance`
- `POST /macrostructure/reset`
- `POST /macrostructure/playback/start`
- `POST /macrostructure/playback/stop`
- `POST /voices/:voiceId/assignment`
- `DELETE /voices/:voiceId/assignment`
- `POST /voices/:voiceId/notes`
- `POST /admin/reset`
- `GET /admin/scores`
- `POST /admin/scores`
- `POST /admin/scores/:scoreId/load`
- `DELETE /admin/scores/:scoreId`
- `POST /admin/import-legacy-voice-notes`
- `GET /admin`
- `GET /events`
- `GET /collab` WebSocket upgrade for realtime collaboration commands.

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
2. Matrix Edit client wiring against the new HTTP/SSE API. Done in `/Users/mdavidson/Documents/matrixedit/apps/rnbo-matrix-editor`: the client now defaults to ShadowScore Server mode, loads `/session`, `/score`, and `/structure`, selects a mesostructural block, edits the selected player's assigned clip, renders other assigned clips as reference layers, and can create a default looped clip for an empty player/block slot.
3. Persistence for last-known score state on Shadowbox hardware. Done: the server loads a saved score on boot, reconciles it with configured voices, writes atomic JSON snapshots, keeps a previous-snapshot backup, and stores named saved scores as JSON under `data/scores/`.
4. RNBO/OSC adapter that transmits committed score updates to the running patch. Done: committed score changes are resolved from the active mesostructural block when clip assignments exist, compiled to v1 ShadowScore numeric transaction messages, and sent over UDP OSC to assignment-bound RNBO inports.
5. Voice assignment and simple lab admin controls. Done: the score now carries per-voice assignment metadata, exposes assignment/update/clear/reset endpoints, persists assignment state, streams assignment events, and serves a dependency-free `/admin` lab page for voice assignment, saved-score library operations, migration, and basic resets.
6. Optional WebSocket/collaboration layer if multiple clients must edit the same voice concurrently. Done: `/collab` accepts dependency-free WebSocket clients, sends welcome/snapshot/presence messages, mirrors score updates as JSON broadcasts, accepts context/voice/assignment/reset commands, and supports optional expected-version guards for stale same-voice edit detection.
7. Dedicated structure and clip editing surfaces. Done: `/` and `/structure-editor` serve Structure Editor for meso/macro organization, `/event-list` serves the canonical clip attribute and note-event editor, and `/matrix-edit` serves block-context grid editing.
