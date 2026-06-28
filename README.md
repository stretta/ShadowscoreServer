# ShadowscoreServer

ShadowscoreServer is the ensemble score authority for ShadowScore clients running on Shadowbox hardware.

The server owns reusable clips, the mesostructural blocks that assign those clips to players, and the macrostructure that chains blocks into a larger form. Voices and mesostructural blocks are arbitrary score lanes, not fixed counts: a session can begin with six players and six default sections, then add or remove either as the piece requires. Matrix Edit and other ShadowScore clients connect to a selected block, edit their assigned clip, and watch how the rest of the ensemble interlocks on the same grid.

## Current Model

- Shared `context`: ensemble-wide scale, root, grid, clip, and seed defaults.
- `clips`: reusable ShadowScore note documents. Clip-owned metadata includes duration, time signature, playback type, and behavior flags.
- `mesostructure`: section-sized blocks with durations, optional scale context, and per-player clip assignments.
- `macrostructure`: the ordered chain of mesostructural blocks plus macro tempo.
- `structureState`: the active block and macro-chain index used for editing and playback.
- Per-voice `notes`: legacy ShadowScore note documents retained for compatibility and migration.
- Per-voice `assignments`: lab-facing player/device/client labels for each voice. Multiple browser or RNBO clients can refer to the same assignment when a performer manages more than one surface.
- Default seed data: six mesostructural blocks, `A` through `F`, and a macro chain containing those blocks.
- Versioned state updates so clients can detect stale edits.
- Realtime event stream for connected clients.
- Optional RNBO/OSC adapter, configured explicitly so it does not claim RNBO's usual ports by accident.

## Run

```sh
npm start
```

The default HTTP server listens on `0.0.0.0:8790`.

```sh
curl http://127.0.0.1:8790/healthz
curl http://127.0.0.1:8790/score
curl http://127.0.0.1:8790/session
open http://127.0.0.1:8790/
open http://127.0.0.1:8790/matrix-edit
open http://127.0.0.1:8790/event-list
open http://127.0.0.1:8790/structure-editor
open http://127.0.0.1:8790/admin
```

Use a config file to override defaults:

```sh
npm start -- --config config/example.json
```

For the first Shadowbox local-host prototype, use:

```sh
npm start -- --config config/shadowbox.local.json
```

For the hardware deployment path, start from:

```sh
npm start -- --config config/shadowbox.hardware-host.json
npm run smoke:hardware -- --config config/shadowbox.hardware-host.json
```

Host installs that should follow local JACK/Link transport can enable the bridge
service during install:

```sh
deploy/install-shadowscore.sh --role host --enable-jack-transport
```

The bridge posts JACK BBT snapshots to `/transport/jack/snapshot`; `/transport`
and `/transport/status` expose freshness, tempo authority, and macro playback
alignment state.

For a peer Shadowbox hardware unit that should register with the selected host,
set `registration.sessionHostUrl` in its config and run:

```sh
npm run agent -- --config config/shadowbox.peer.json
```

When the peer's local RNBO target is configured as `127.0.0.1`, the registration
agent advertises it to the host as `<server.hostIdentity>.local` so the session
host can send OSC to the peer over the LAN.

Use `--once` for a single registration without the heartbeat loop:

```sh
npm run agent -- --config config/shadowbox.peer.json --once
```

The root `/` route serves the dedicated Structure Editor by default. `/structure-editor`
is kept as an explicit alias for the same app.

The `/matrix-edit` route serves static Matrix Edit assets from `public/matrix-edit`.
The bundled Matrix Edit build loads `/session`, `/score`, and `/structure`,
selects a mesostructural block, renders the assigned clips for that block
together, and writes the selected player's edits to that slot's assigned clip.
If a clip-based block has an empty player slot, Matrix Edit can create a default
looped clip and assign it to the selected player/block before editing. Legacy
voice-note editing remains as compatibility behavior when the selected block has
no clip assignments.

The `/event-list` route serves a server-bundled event list editor from
`public/event-list`. It is the canonical clip editor: choose a server, choose a
clip, edit clip-owned attributes, then edit the clip's note event list. Clip
attributes include duration, time signature, playback type, behavior flags,
transpose mode, and note counts. Player assignment is intentionally outside
Event List because assignments belong to mesostructural blocks.

The `/structure-editor` route serves a dedicated meso/macro editor from
`public/structure-editor`. It edits score-owned mesostructural block parameters,
per-player clip assignments, macrostructure tempo, and the ordered macro chain
without changing the Matrix Edit or Event List surfaces.

By default, the active score persists to `data/score.json`, the previous
snapshot is kept at `data/score.previous.json`, and named saved scores are
stored as JSON files under `data/scores/`.

RNBO output is disabled by default. When enabled, committed score changes are
compiled into the numeric ShadowScore OSC transaction stream and sent to the
configured RNBO inport address. RNBO compilation follows the active
mesostructural block: each assignment-bound target receives that player's
resolved clip material for the current block. Looped clips repeat across the
containing block duration; one-shot clips play once.

## Editing Model

- **Structure Editor** owns mesostructure, macrostructure, active block
  selection, timed macro playback, and player-to-clip assignment.
- **Event List** owns canonical clip editing: clip selection, clip attributes,
  clip time signature, playback type, behavior flags, and note events.
- **Matrix Edit** owns block-context interlock editing: select a block, edit one
  assigned player's clip on the grid, and see other assigned clips as read-only
  reference layers.
- **Admin** owns lab operations: assignments, saved scores, backup/restore,
  migration from legacy voice notes, and reset tools.

## API Draft

- `GET /healthz`: service status.
- `GET /score`: current ensemble score snapshot.
- `GET /session`: host/session metadata, app URLs, voices, assignments, and local RNBO target config.
- `GET /hardware/units`: local and registered hardware units with online/offline state.
- `POST /hardware/register`: register a peer hardware unit and its RNBO targets. Targets may include `capabilities` such as `maxStages`, `maxNoteRows`, `noteDataFloatCount`, `noteRowWidth`, `contextDataFloatCount`, and `supportedClockIntervals`; registered peer targets that omit `capabilities` are treated as legacy `1024` stage / `512` note-row clients until their agent advertises expanded support.
- `POST /hardware/units/:unitId/heartbeat`: refresh a registered peer heartbeat.
- `GET /rnbo/targets`: local and registered RNBO targets with availability state.
- `GET /playback/timing-contracts`: target-specific compiled playback timing contracts for the active block, including selected stage resolution, `ClockInterval`/ticks-per-stage, `MaxSteps`/pattern length, target capacities, and quantization diagnostics when adaptive fidelity modes are enabled.
- `POST /transport/jack/snapshot`: accept a host-local JACK BBT snapshot from the bridge helper.
- `GET /transport`: current JACK bridge freshness, latest BBT snapshot, and tempo authority.
- `GET /transport/events`: SSE stream for transport updates.
- `GET /transport/status`: host transport status and macro playback control page.
- `POST /rnbo/targets/:targetId/transport-controls`: set playback transport RNBO controls for a target. `Clock` is written to the RNBO param path, while `Tempo`, `MaxSteps`, `ClockInterval`, `SetStage`, and `Stage` are written to message inports, for example `{ "controls": { "Tempo": 120, "MaxSteps": 64, "ClockInterval": 240 } }`. Editor transport start/stop uses this route with `{ "controls": { "Clock": 1 } }` or `{ "controls": { "Clock": 0 } }`; sending the off/on message to one target is sufficient for the linked transport. Routine score-data resends reassert `ClockInterval` and score-derived `MaxSteps`; they only send `Tempo` when `transport.tempoAuthority` is set to `"server"`. Stage/step reset or direct advancement controls should be sent only by explicit sync/direct-drive operations. The older `/rnbo/targets/:targetId/params` route remains available as a compatibility alias.
- `GET /assignments`: current voice assignment map.
- `GET /clips`: current reusable clip map.
- `GET /structure`: current `{ clips, mesostructure, macrostructure, structureState }` structure document.
- `GET /structure/playhead`: current active mesostructural block and macro index.
- `GET /macrostructure/playback`: current macro chain playback runner state.
- `POST /context`: replace or merge shared ShadowScore context.
- `POST /clips`: add one reusable clip with `{ "clipId": "...", "clip": { ... } }`.
- `POST /clips/:clipId`: add or replace one reusable clip.
- `POST /clips/:clipId/rename`: rename one reusable clip and update mesostructural references.
- `DELETE /clips/:clipId`: remove one reusable clip. The server rejects removal while a clip is assigned in a mesostructural block.

Clip documents contain `notes`, `context`, `playbackType`, and `behavior`.
`playbackType` is either `looped` or `one-shot`, and defaults to `looped`.
- `POST /mesostructure`: add or replace a mesostructural block with `{ "blockId": "...", "block": { "duration": { "bars": 8 }, "players": {} } }`.
- `POST /mesostructure/:blockId`: add or replace one mesostructural block.
- `DELETE /mesostructure/:blockId`: remove one mesostructural block and delete its appearances from the macro chain.
- `POST /macrostructure`: merge macrostructure fields such as `{ "tempo": 120, "blocks": ["A", "B"] }`; use `?replace=1` to replace the macrostructure document.
- `POST /structure/playhead`: select the active mesostructural block.
- `POST /macrostructure/advance`: advance the active block to the next macro chain entry.
- `POST /macrostructure/reset`: reset the active block to the beginning of the macro chain.
- `POST /macrostructure/playback/start`: start timed macro chain playback from the current active block and send `Clock: 1` to available RNBO targets.
- `POST /macrostructure/playback/stop`: stop timed macro chain playback and send `Clock: 0` to available RNBO targets.
- `POST /voices`: add a voice with `{ "voiceId": "...", "assignment": { ... } }`.
- `DELETE /voices/:voiceId`: remove a voice and its assignment.
- `POST /voices/:voiceId/assignment`: assign a voice to a player, device, or client.
- `DELETE /voices/:voiceId/assignment`: clear one voice assignment.
- `POST /voices/:voiceId/notes`: replace a voice's ShadowScore notes document.
- `POST /admin/reset`: clear selected score sections with a JSON body containing `context`, `voices`, `assignments`, and/or `structure` booleans.
- `GET /admin/scores`: list named score JSON files saved on the host.
- `POST /admin/scores`: save the current score to the host score library with an optional `{ "name": "..." }`.
- `POST /admin/scores/new`: replace the current score with a fresh score from the configured ensemble defaults.
- `POST /admin/scores/:scoreId/load`: restore a saved score from the host score library.
- `DELETE /admin/scores/:scoreId`: delete a saved score JSON file from the host score library.
- `POST /admin/import-legacy-voice-notes`: copy non-empty `voices[player].notes` into looped clips such as `player-1-main` and assign them to block `A` by default. This leaves voice notes intact and does not overwrite existing clips unless `overwriteClips` is true.
- `GET /admin`: simple lab admin page for voice assignments and basic resets.
- `GET /`: default structure editor.
- `GET /event-list`: canonical clip attribute and note-event editor.
- `GET /structure-editor`: meso/macro structure editor.
- `GET /events`: server-sent event stream of score changes.
- `GET /collab`: WebSocket collaboration endpoint for realtime JSON commands.

## WebSocket Collaboration

Connect WebSocket clients to `/collab`. The server sends a `welcome`, `snapshot`,
and `presence.list` message on connect. Score mutations are broadcast as
`score.changed` messages with the same event shape used by `/events`.

Client command messages are JSON objects:

- `get.score`: request a fresh `snapshot`.
- `presence.update`: broadcast editing presence with `voiceId`, `name` or `assignee`, `deviceId`, and `editing`.
- `context.update`: update shared context with `context`, optional `replace`, and optional `expectedVersion`.
- `mesostructure.block.replace`: add or replace one mesostructural block with `blockId` and `block`.
- `mesostructure.block.remove`: remove one mesostructural block with `blockId`.
- `macrostructure.update`: update macrostructure with `macrostructure`, optional `replace`, and optional `expectedVersion`.
- `structure.playhead.update`: select the active mesostructural block with `structureState` or `playhead`.
- `macrostructure.advance`: advance the active block to the next macro chain entry.
- `macrostructure.reset`: reset the active block to the beginning of the macro chain.
- `clip.add`: add one reusable clip with `clipId` and `clip`.
- `clip.replace`: replace one reusable clip with `clipId` and `clip`.
- `clip.rename`: rename one reusable clip with `clipId` and `newClipId`.
- `clip.remove`: remove one reusable clip with `clipId`.
- `voice.add`: add one voice with `voiceId` and optional `assignment`.
- `voice.remove`: remove one voice with `voiceId`.
- `voice.notes.replace`: replace one voice with `voiceId`, `notes` or `document`, and optional `expectedVoiceVersion`.
- `voice.assignment.replace`: replace assignment metadata with `voiceId` and `assignment`.
- `voice.assignment.clear`: clear one assignment with `voiceId`.
- `admin.reset`: clear selected sections with `context`, `voices`, `assignments`, and/or `structure`.
- `admin.importLegacyVoiceNotes`: copy legacy voice notes into clips and assign them into a mesostructural block.

Successful write commands receive an `ack` with the updated score. Stale guarded
writes receive an `error`, so two clients editing the same voice can avoid
silently overwriting one another.

## Development

```sh
npm test
```

The server bundle contains generated Matrix Edit assets under
`public/matrix-edit`. Source edits for that app happen in the sibling
`/Users/mdavidson/Documents/matrixedit` workspace. After editing Matrix Edit
source, run this from the Matrix Edit workspace:

```sh
npm run export:shadowscore
```

That builds `@matrixedit/rnbo-matrix-editor` with the `/matrix-edit/` base path
and syncs the generated artifact into this server repo.

## Hardware Deployment

Phase 5 hardware deployment material lives in
[`docs/deployment/shadowbox-hardware.md`](docs/deployment/shadowbox-hardware.md).
It includes Pi install/update commands, systemd service templates, smoke-test
commands, and the pre-session hardware checklist.

For source-copy development deploys to a Pi that is already installed, use:

```sh
npm run deploy:pi -- --host wren.local
```

The deploy helper syncs this checkout to `/home/pi/ShadowscoreServer`, preserves
remote `config/*.local.json` files and `data/`, restarts the matching systemd
service, and runs the hardware smoke test. Use `--role peer` for registration
agent units, `--sync-only` for a file-only update, or `--dry-run` to preview the
rsync.
