# ShadowscoreServer

ShadowscoreServer is the ensemble score authority for ShadowScore clients running on Shadowbox hardware.

The server owns reusable clips, the mesostructural blocks that assign those clips to players, and the macrostructure that chains blocks into a larger form. Voices and mesostructural blocks are arbitrary score lanes, not fixed counts: a session can begin with six players and six default sections, then add or remove either as the piece requires. Matrix Edit and other ShadowScore clients connect to a selected block, edit their assigned clip, and watch how the rest of the ensemble interlocks on the same grid.

## Current Model

- Shared `context`: ensemble-wide scale, root, grid, clip, and seed defaults.
- `clips`: reusable ShadowScore note documents. Clip-owned metadata includes duration, time signature, playback type, and behavior flags.
- `mesostructure`: section-sized blocks with durations, required rooted scale
  context, required block-owned TTID, and per-player clip assignments.
- `macrostructure`: the ordered chain of mesostructural block occurrences.
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
open http://127.0.0.1:8790/piano-roll
open http://127.0.0.1:8790/event-list
open http://127.0.0.1:8790/structure-editor
open http://127.0.0.1:8790/admin
open http://127.0.0.1:8790/editors/plate
```

Use a config file to override defaults:

```sh
npm start -- --config config/example.json
```

Automatic OSC instance onboarding is disabled by default. A host may opt in
with stable role templates; each template requires a role, app, and device, and
mutates the score only when exactly one online target matches:

```json
{
  "osc": {
    "onboarding": {
      "automatic": {
        "enabled": true,
        "roles": [
          {
            "roleId": "analogsequencer-a",
            "label": "Analog Sequencer A",
            "app": "analogsequencer",
            "deviceId": "wren"
          }
        ]
      }
    }
  }
}
```

Hardware registration and manual OSCQuery device save/update/refresh events run
the enabled policy. Ambiguous, unavailable, invalid, and failed captures are
reported without creating partial score resources.

For a Shadowbox host with a machine-local config, create a local copy first:

```sh
cp config/shadowbox.hardware-host.json config/shadowbox.local.json
```

Then edit `config/shadowbox.local.json` for the hardware unit's hostname,
public URL, RNBO ports, and RNBOOSCQuery URL. Start the server with:

```sh
npm start -- --config config/shadowbox.local.json
```

For a checked-in hardware host template, start from:

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

The root `/` route serves a ShadowScore view index with links to the bundled
editor pages and live RNBO graph editors discovered through `/rnbo/devices`.
RNBO devices are separate from ShadowScore playback targets: a unit can appear
as a graph-editor link before a ShadowScoreClient instance is loaded there.

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

The `/structure-editor` route serves the Arrange workspace from
`public/structure-editor`. It edits score-owned mesostructural block parameters,
per-player clip assignments, block-owned written tempos, and the ordered
arrangement without changing the Matrix Edit or Event List surfaces. The
arrangement strip supports drag reorder and Alt+Left/Right keyboard reorder.
Its visible left/right occurrence controls provide the same operation on touch
screens, and block selection remains visually separate from playback position.
Occurrence widths follow musical duration, and its playhead uses the shared
display-rate estimator over the normal 250 ms playback snapshot cadence.
Arrange also exposes the shared Players Play/Stop, Arrangement Run/Hold, live
tempo, Follow Block Tempo, and Use Block Tempo Now controls.

The `/editors` route serves the registered OSC-generator index from
`public/editors`, and `/editors/manifest` exposes the generator manifest JSON.
The bundled ListSequencer, ListVelSequencer, AnalogSequencer, Plate, Poland,
SoftPiano, and TTID editors share the mesostructural OSC state workflow. Their
focused instance determines the score role, PLAYING and EDITING identify the
transport and write destinations, and CHASE optionally keeps them together.
Every structural block is shown as Written or Unspecified; unspecified state
is a no-op during recall, distinct from explicitly written silence or empty
lists. While playback runs, CHASE disables writing; turning CHASE off permits
writing to any block other than PLAYING, so upcoming state can be prepared
without colliding with automatic recall. Checked immediate-send targets remain
independent from focused-instance state capture. Utility tools for live OSC
target volume trims and macro building are served at `/tools/osc-volume` and
`/tools/osc-macros`.

By default, the active score persists to `data/score.json`, the previous
snapshot is kept at `data/score.previous.json`, and named saved scores are
stored as JSON files under `data/scores/`.

RNBO output is disabled by default. When enabled, committed score changes are
compiled into the numeric ShadowScore OSC transaction stream and sent to the
configured RNBO inport address. RNBO compilation follows the active
mesostructural block: each assignment-bound target receives that player's
resolved clip material for the current block. Looped clips repeat across the
containing block duration; one-shot clips play once.

Active macro entry changes also enqueue composition-owned OSC snapshot recall.
The entry key includes macro index and block id, so repeated observations do
not resend while separate occurrences of the same block still recall. Playback
status reports this queue separately from ShadowScore note delivery and
`SetStage` phase alignment. AnalogSequencer block states can opt into
`recall.rtzBeforePlay`; when their saved `Clock` value starts playback, recall
orders the state writes, `rtz`, and `Clock` so reset occurs immediately before
play.

## Editing Model

- **Arrange** owns mesostructure, macrostructure, active block selection,
  Players/Arrangement performance controls, live and written tempo policy, and
  player-to-clip assignment.
- **Event List** owns canonical clip editing: clip selection, clip attributes,
  clip time signature, playback type, behavior flags, and note events.
- **Matrix Edit** owns block-context interlock editing: select a block, edit one
  assigned player's clip on the grid, and see other assigned clips as read-only
  reference layers.
- **Piano Roll** owns duration, onset, pitch, and note-specific velocity edits
  for an assigned clip. It preserves per-clip drafts until explicit Save and
  shows projected loop aliases, reference clips, and live playback position.
- **Admin** owns lab operations: assignments, saved scores, backup/restore,
  migration from legacy voice notes, and reset tools.

For the session-day operator flow, see
[`docs/operator-guide.md`](docs/operator-guide.md).

## HTTP API

- `GET /healthz`: service status.
- `GET /score`: current ensemble score snapshot.
- `GET /session`: host/session metadata, app URLs, voices, assignments, and local RNBO target config.
- `GET /hardware/units`: local and registered hardware units with online/offline state.
- `POST /hardware/register`: register a peer hardware unit and its RNBO targets. When a score assignment has a matching stable `deviceId`, registration safely refreshes stale `rnboTargetId`, host, port, and address fields if the peer advertises exactly one ShadowScore RNBO target; locked assignments, assignments without `deviceId`, and peers with multiple ShadowScore targets are left for manual selection. ShadowScore playback now has one mandatory client contract: compact double-buffer replacement, 819 rows per bank, 16384 note floats total, and staged activation. Registered targets are normalized to that contract; legacy single-bank clients are unsupported.
- `POST /hardware/units/:unitId/heartbeat`: refresh a registered peer heartbeat.
- `POST /hardware/units/:unitId/targets/:targetId/use-observed-host`: replace a peer target's advertised host with the remote address observed by the session host. This is an admin repair path for peers that register with an unreachable address.
- `GET /rnbo/targets`: local and registered RNBO targets with availability state and latest RNBO score send status when available.
- `GET /rnbo/devices`: RNBO runner/graph-editor devices, including units that do not currently expose ShadowScore playback targets.
- `GET /osc/targets`: normalized OSC-capable targets. Optional query filters include `app`, `capability`, and `status`.
- `GET /osc/assignments`: current logical OSC control-role assignment map. Add `?resolved=1` for current normalized target resolutions and compatible targets without mutating the score.
- `GET /osc/resources`: classify score roles and discovered OSC instances as mapped, compatible, offline, ambiguous, or unmapped.
- `POST /osc/onboard`: capture one online target and atomically create or reuse its logical role, OSC clip, and block layer.
- `POST /osc/onboard/automatic`: run the configured default-off automatic onboarding policy and return onboarded and skipped diagnostics.
- `POST /osc/assignments/reconcile`: refresh unlocked role target IDs and routing diagnostics from normalized live targets by stable device identity plus app/editor capability.
- `GET /osc/recalls`: bounded recent OSC snapshot recall diagnostics across blocks, including encoded payload bytes and monotonic per-write/dispatch timing.
- `PUT /osc/assignments/:roleId`: create or replace one logical OSC control-role assignment.
- `DELETE /osc/assignments/:roleId`: remove one logical OSC control-role assignment without changing any saved block snapshots.
- `POST /osc/send`: send one OSC message or named parameter write to selected target IDs.
- `POST /osc/broadcast`: expand filtered OSC targets at request time and send one OSC message or named parameter write to each resolved target.
- `GET /osc/macros`: list saved OSC macros from the host macro library.
- `POST /osc/macros`: save or replace an OSC macro.
- `POST /osc/macros/:macroId/run`: validate, dry-run, or execute one saved OSC macro.
- `GET /editors/manifest`: registered instrument-editor manifest.
- `GET /playback/timing-contracts`: target-specific compiled playback timing contracts for the active block, including selected stage resolution, `ClockInterval`/ticks-per-stage, `MaxSteps`/pattern length, target capacities, compact/full-clear replacement mode, and quantization diagnostics when adaptive fidelity modes are enabled.
- `GET /playback/snapshot`: monotonically versioned, server-owned playback observation combining the authoritative JACK playhead, macro/block state, cached local and peer RNBO execution witnesses, per-target phase error and readback freshness, timing contracts, score-send preparation metrics, ACK state, and recent RNBO playback lifecycle events. The host polls advertised peer `currentStagePath` OSCQuery endpoints; browsers do not contact peers directly.
- RNBO clients must implement separate active and staging tables. The server sets prepare-only flag bit `1`, requires opcode `92` READY, and reports the result as `preparedTransaction` without changing `activeTransaction`. At a boundary it sends `SetStage 0`, then `Clock 1`, and promotes the transaction only after matching opcode `93` ACTIVE readback. Opcode `90` single-bank commit clients are unsupported.
- Automatic updates reuse an identical active or prepared staged payload by hash and block identity. Manual, target-discovery, and forced full-clear sends always retransmit.
- During JACK-derived playback, the server prepares the next macro block inside the configured `rnbo.lookAheadBeats` window on staged-capable targets only; legacy clients are not sent future-block payloads.
- `POST /admin/rnbo/resend`: manually resend the current score to RNBO playback targets. Add `?mode=full-clear` or `{ "mode": "full-clear" }` to force capacity-sized clear rows even for compact-capable targets.
- Score replacement queues ordered UDP bursts controlled by `rnbo.sendBatchSize` (default `4`) and retains `rnbo.sendDelayMs` pacing between bursts. `BEGIN_REPLACE`, indexed note rows, `COMMIT`, and transport inports keep their original order; READY row-count validation and retry remain the delivery gate.
- `POST /transport/jack/snapshot`: accept a host-local JACK BBT snapshot from the bridge helper.
- `POST /transport/jack/start`: start JACK transport through a configured JACK controller.
- `POST /transport/jack/stop`: stop JACK transport through a configured JACK controller.
- `POST /transport/jack/locate`: locate JACK transport to a frame with `{ "frame": 0 }`; this does not write RNBO `Clock`.
- `POST /transport/jack/tempo`: set JACK transport tempo through a configured JACK controller with `{ "bpm": 120 }`.
- `POST /transport/tempo`: set runtime live tempo immediately with `{ "bpm": 108 }` without rewriting the active block.
- `POST /transport/tempo/follow-block`: enable or disable written-tempo recall at the next block boundary with `{ "follow": true }`. Enabling it does not jump tempo mid-block.
- `POST /transport/tempo/use-block`: explicitly recall the active block's written tempo now.
- `POST /transport/players/play`: start assigned players while preserving the requested Arrangement Run/Hold mode. Waits for queued RNBO score preparation and rejects explicit ACK failures; reasserts runtime live tempo to the configured authority; starts JACK; writes `SetStage 0` to assigned clients by default; then sends `Clock 1` so each client starts on its next synchronized beat. Playhead-only updates do not retransmit an already committed active block.
- `POST /transport/players/stop`: silence assigned players and stop JACK while preserving the current arrangement location and requested Run/Hold mode.
- `POST /transport/arrangement/run`: start or resume arrangement movement while Players are playing. Returns `409` if Players are stopped.
- `POST /transport/arrangement/hold`: hold arrangement movement on the current block without stopping JACK or assigned players.
- `POST /transport/play`: compatibility facade for Players Play plus Arrangement Run.
- `POST /transport/stop`: compatibility facade for Players Stop.
- `POST /transport/return-to-start`: reset the macro playhead to the first section, write `SetStage: 0` to playback targets, and return aggregate transport readiness.
- `GET /transport`: current JACK bridge freshness, latest BBT snapshot, tempo authority, and runtime live/written/follow policy.
- `GET /transport/events`: SSE stream for transport updates.
- `GET /transport/status`: host transport status and macro playback control page.
- `POST /rnbo/targets/:targetId/transport-controls`: set playback transport RNBO controls for a target. `Clock` is written to the RNBO param path, while `Tempo`, `MaxSteps`, `ClockInterval`, `SetStage`, and `Stage` are written to message inports, for example `{ "controls": { "Tempo": 120, "MaxSteps": 64, "ClockInterval": 240 } }`. Editor transport start/stop uses this route with `{ "controls": { "Clock": 1 } }` or `{ "controls": { "Clock": 0 } }`; sending the off/on message to one target is sufficient for the linked transport. Routine score-data resends reassert `ClockInterval` and score-derived `MaxSteps`; they only send `Tempo` when `transport.tempoAuthority` is set to `"server"`. Stage/step reset or direct advancement controls should be sent only by explicit sync/direct-drive operations. The older `/rnbo/targets/:targetId/params` route remains available as a compatibility alias.
- `GET /assignments`: current voice assignment map.
- `POST /assignments/reconcile`: refresh assignment endpoint fields from currently registered hardware units by stable `deviceId`; this is the manual version of the safe registration reconciliation path.
- `GET /clips`: current reusable clip map.
- `GET /structure`: current `{ clips, mesostructure, macrostructure, structureState }` structure document.
- `GET /structure/playhead`: current active mesostructural block and macro index.
- `GET /macrostructure/playback`: current macro playback runner state, including mode, beat witness, composition beat, beat-in-block, macro anchor, active block, and remaining beats.
- `POST /context`: replace or merge shared ShadowScore context.
- `POST /clips`: add one reusable clip with `{ "clipId": "...", "clip": { ... } }`.
- `POST /clips/:clipId`: add or replace one reusable clip.
- `POST /clips/:clipId/rename`: rename one reusable clip and update mesostructural references.
- `DELETE /clips/:clipId`: remove one reusable clip. The server rejects removal while a clip is assigned in a mesostructural block.

Clip documents contain `notes`, `context`, `playbackType`, and `behavior`.
`playbackType` is either `looped` or `one-shot`, and defaults to `looped`.
- `POST /mesostructure`: add or replace a mesostructural block with `{ "blockId": "...", "block": { "duration": { "bars": 8 }, "players": {} } }`.
- `POST /mesostructure/:blockId`: add or replace one mesostructural block.
- `POST /mesostructure/:blockId/duplicate`: duplicate one mesostructural block, using `blockId` or `id` in the request body for the new block ID.
- `PUT /mesostructure/:blockId/ttid`: non-destructively update block TTID with the normal revision guard; active-block edits distribute immediately to eligible online targets.
- `POST /mesostructure/:blockId/ttid`: manually resend the stored block TTID without changing the score.
- `POST /mesostructure/:blockId/scale-transform`: atomically reinterpret scale-following clip and legacy voice pitches, update clip scale metadata, and synchronize the block scale and TTID.
- `DELETE /mesostructure/:blockId`: remove one mesostructural block and delete its appearances from the macro chain.
- `GET /osc/clips`: list reusable, composition-owned OSC clips.
- `POST /osc/clips`: create an OSC clip with a stable `clipId` and semantic state.
- `POST /osc/clips/capture`: capture exactly one live target into a new OSC clip, optionally assigning it to one block/role atomically.
- `GET|PUT|DELETE /osc/clips/:clipId`: read, replace, or remove one OSC clip. Referenced clips cannot be removed.
- `GET /osc/clips/references`: report every block/role reference and all orphan clip ids.
- `GET /osc/clips/:clipId/references`: report references and orphan status for one clip.
- `GET /mesostructure/:blockId/osc-layers`: list the block's logical-role to OSC-clip assignments.
- `PUT /mesostructure/:blockId/osc-layers/:roleId`: assign an existing compatible `clipId` to a role in the block.
- `DELETE /mesostructure/:blockId/osc-layers/:roleId`: remove one block layer without deleting its OSC clip.
- `POST /mesostructure/:blockId/osc-layers/recall`: compile and best-effort dispatch the clips assigned to a block. Optional `roles` scopes logical roles and `dryRun` returns the complete plan without sending.
- `GET /mesostructure/:blockId/osc-layers/recall`: bounded recall diagnostics for one block.
- `POST /macrostructure`: set ordered block occurrences such as `{ "blocks": ["A", "B"] }`; use `?replace=1` to replace the macrostructure document. Written tempo is stored on each mesostructural block.
- `POST /structure/playhead`: select the active mesostructural block.
- `POST /macrostructure/advance`: advance the active block to the next macro chain entry.
- `POST /macrostructure/reset`: reset the active block to the beginning of the macro chain.
- `POST /macrostructure/phase-reset`: write `SetStage: 0` to assignment-bound RNBO targets, optionally scoped with `{ "targetId": "..." }`.
- `POST /macrostructure/playback/start`: start playback from the current active block and send `Clock: 1` to available RNBO targets. The default/`auto` mode chooses beat-derived playback when JACK or RNBO client readback is usable, otherwise it falls back to the internal timer. Diagnostic callers can still pass `{ "mode": "jack" }` or `{ "mode": "timer" }` explicitly.
- `POST /macrostructure/playback/stop`: stop macro playback and send `Clock: 0` to available RNBO targets.
- `POST /voices`: add a voice with `{ "voiceId": "...", "assignment": { ... } }`.
- `DELETE /voices/:voiceId`: remove a voice and its assignment.
- `POST /voices/:voiceId/assignment`: assign a voice to a player, device, or client.
- `DELETE /voices/:voiceId/assignment`: clear one voice assignment.
- `POST /voices/:voiceId/notes`: replace a voice's ShadowScore notes document.
- `POST /admin/reset`: clear selected score sections with a JSON body containing `context`, `notes`, `voices`, `assignments`, `oscAssignments`, and/or `structure` booleans.
- `GET /admin/backup`: download the current score snapshot as JSON.
- `POST /admin/restore`: restore a score snapshot JSON body through the normal score normalization path.
- `GET /admin/scores`: list named score JSON files saved on the host.
- `POST /admin/scores`: save the current score to the host score library with an optional `{ "name": "..." }`.
- `POST /admin/scores/new`: replace the current score with a fresh score from the configured ensemble defaults.
- `POST /admin/scores/initialize/preview`: validate a declarative score-initialization request without mutation and return its exact score skeleton, summary, and current revision base.
- `POST /admin/scores/initialize`: atomically create the previewed player, clip, block, macro, and OSC-role skeleton. Include the preview's `expectedVersion`, `expectedScoreRevision`, and `expectedStructureRevision` to reject a stale apply. Live device mappings and OSC clips remain separate onboarding operations.
- `POST /admin/scores/:scoreId/load`: restore a saved score from the host score library.
- `DELETE /admin/scores/:scoreId`: delete a saved score JSON file from the host score library.
- `POST /admin/assignment-preset`: apply a configured assignment preset by `{ "presetId": "..." }`.
- `POST /admin/import-legacy-voice-notes`: copy non-empty `voices[player].notes` into looped clips such as `player-1-main` and assign them to block `A` by default. This leaves voice notes intact and does not overwrite existing clips unless `overwriteClips` is true.
- `GET /admin`: lab administration for player assignments, logical OSC control roles, OSCQuery devices, saved scores, and resets.
- `GET /`: ShadowScore view index with editor and RNBO graph-editor links.
- `GET /editors`: registered instrument-editor browser.
- `GET /editors/listsequencer`: bundled ListSequencer OSC editor with block snapshot save, load, routing-policy, and recall controls.
- `GET /editors/listvelsequencer`: bundled eight-row velocity sequencer OSC editor with the shared snapshot workflow.
- `GET /editors/analogsequencer`: bundled 16-stage analog sequencer OSC editor with the shared snapshot workflow.
- `GET /editors/plate`: bundled Plate reverb OSC editor with the shared snapshot workflow.
- `GET /editors/poland`: bundled Poland OSC editor with the shared snapshot workflow.
- `GET /editors/softpiano`: bundled SoftPiano OSC editor with the shared snapshot workflow.
- `GET /editors/ttid`: bundled TTID mask and transpose OSC editor with the shared snapshot workflow.
- `GET /tools/osc-volume`: OSC target volume trim tool.
- `GET /tools/osc-macros`: OSC macro builder and validator.
- `GET /event-list`: canonical clip attribute and note-event editor.
- `GET /piano-roll`: assigned-clip piano-roll editor with explicit per-clip drafts and Save.
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
- `mesostructure.ttid.update`: update block-owned TTID without changing notes.
- `mesostructure.scale.transform`: atomically transform notes and synchronize block scale plus TTID.
- `osc.clip.add`, `osc.clip.replace`, `osc.clip.remove`: manage reusable OSC clips.
- `mesostructure.oscLayer.assign`, `mesostructure.oscLayer.remove`: manage block role-to-clip layers.
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
- `osc.assignment.replace`: create or replace a logical OSC control-role assignment with `roleId` and `assignment`.
- `osc.assignment.remove`: remove a logical OSC control-role assignment with `roleId`.
- `admin.reset`: clear selected sections with `context`, `notes`, `voices`, `assignments`, `oscAssignments`, and/or `structure`.
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

Hardware deployment material lives in
[`docs/deployment/shadowbox-hardware.md`](docs/deployment/shadowbox-hardware.md).
It includes Pi install/update commands, systemd service templates, smoke-test
commands, and the pre-session hardware checklist.

For source-copy development deploys to a Pi that is already installed, use:

```sh
npm run deploy:pi -- --host wren.local
```

The deploy helper syncs this checkout to `/home/pi/ShadowscoreServer`, preserves
remote `config/*.local.json` files and `data/`, checks non-interactive sudo,
restarts the matching systemd service, verifies the service state and host
routes, and runs the hardware smoke test. Use `--role peer` for registration
agent units, `--sync-only` for a file-only update, `--force-restart` for the
kill/reset/start recovery path, `--verify-route <path>` for rollout-specific
host checks, or `--dry-run` to preview the rsync. If the Pi does not allow
passwordless sudo, set `SHADOWSCORE_SUDO_PASSWORD` for that deploy.
- **Piano Roll** owns duration, onset, pitch, and note-specific velocity edits
  for an assigned clip. It keeps per-clip drafts until explicit Save and shows
  projected loop aliases and the live playback position.
