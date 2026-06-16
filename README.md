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
open http://127.0.0.1:8790/admin
```

Use a config file to override defaults:

```sh
npm start -- --config config/example.json
```

By default, score state persists to `data/score.json` and the previous snapshot
is kept at `data/score.previous.json`.

RNBO output is disabled by default. When enabled, committed score changes are
compiled into the numeric ShadowScore OSC transaction stream and sent to the
configured RNBO inport address.

## API Draft

- `GET /healthz`: service status.
- `GET /score`: current ensemble score snapshot.
- `GET /assignments`: current voice assignment map.
- `POST /context`: replace or merge shared ShadowScore context.
- `POST /voices/:voiceId/assignment`: assign a voice to a player, device, or client.
- `DELETE /voices/:voiceId/assignment`: clear one voice assignment.
- `POST /voices/:voiceId/notes`: replace a voice's ShadowScore notes document.
- `POST /admin/reset`: clear selected score sections with a JSON body containing `context`, `voices`, and/or `assignments` booleans.
- `GET /admin`: simple lab admin page for voice assignments and basic resets.
- `GET /events`: server-sent event stream of score changes.

## Development

```sh
npm test
```

No runtime dependencies are required for the initial scaffold.
