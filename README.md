# ShadowscoreServer

ShadowscoreServer is the ensemble score authority for ShadowScore clients running on Shadowbox hardware.

The server owns one shared musical context for the ensemble and one note document per voice. Matrix Edit and other ShadowScore clients connect to edit their assigned voice while watching the rest of the ensemble on the same grid.

## First Shape

- Shared `context`: scale, root, grid, clip, and seed.
- Per-voice `notes`: ShadowScore note documents owned by ensemble players.
- Per-voice `assignments`: lab-facing player/device/client labels for each voice.
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

For a peer Shadowbox hardware unit that should register with the selected host,
set `registration.sessionHostUrl` in its config and run:

```sh
npm run agent -- --config config/shadowbox.peer.json
```

Use `--once` for a single registration without the heartbeat loop:

```sh
npm run agent -- --config config/shadowbox.peer.json --once
```

The root route serves static app assets from `public/matrix-edit` by default.
The bundled page is a lightweight Phase 1 browser prototype that loads `/score`,
subscribes to `/events`, renders all voice layers, and writes the selected voice
through `POST /voices/:voiceId/notes`. A production Matrix Edit build can replace
the contents of that folder without changing server routes.

By default, score state persists to `data/score.json` and the previous snapshot
is kept at `data/score.previous.json`.

RNBO output is disabled by default. When enabled, committed score changes are
compiled into the numeric ShadowScore OSC transaction stream and sent to the
configured RNBO inport address.

## API Draft

- `GET /healthz`: service status.
- `GET /score`: current ensemble score snapshot.
- `GET /session`: host/session metadata, app URLs, voices, assignments, and local RNBO target config.
- `GET /hardware/units`: local and registered hardware units with online/offline state.
- `POST /hardware/register`: register a peer hardware unit and its RNBO targets.
- `POST /hardware/units/:unitId/heartbeat`: refresh a registered peer heartbeat.
- `GET /rnbo/targets`: local and registered RNBO targets with availability state.
- `GET /assignments`: current voice assignment map.
- `POST /context`: replace or merge shared ShadowScore context.
- `POST /voices/:voiceId/assignment`: assign a voice to a player, device, or client.
- `DELETE /voices/:voiceId/assignment`: clear one voice assignment.
- `POST /voices/:voiceId/notes`: replace a voice's ShadowScore notes document.
- `POST /admin/reset`: clear selected score sections with a JSON body containing `context`, `voices`, and/or `assignments` booleans.
- `GET /admin`: simple lab admin page for voice assignments and basic resets.
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
- `voice.notes.replace`: replace one voice with `voiceId`, `notes` or `document`, and optional `expectedVoiceVersion`.
- `voice.assignment.replace`: replace assignment metadata with `voiceId` and `assignment`.
- `voice.assignment.clear`: clear one assignment with `voiceId`.
- `admin.reset`: clear selected sections with `context`, `voices`, and/or `assignments`.

Successful write commands receive an `ack` with the updated score. Stale guarded
writes receive an `error`, so two clients editing the same voice can avoid
silently overwriting one another.

## Development

```sh
npm test
```

No runtime dependencies are required for the initial scaffold.

## Hardware Deployment

Phase 5 hardware deployment material lives in
[`docs/deployment/shadowbox-hardware.md`](docs/deployment/shadowbox-hardware.md).
It includes Pi install/update commands, systemd service templates, smoke-test
commands, and the pre-session hardware checklist.
