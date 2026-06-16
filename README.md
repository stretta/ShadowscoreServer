# ShadowscoreServer

ShadowscoreServer is the ensemble score authority for ShadowScore clients running on Shadowbox hardware.

The server owns one shared musical context for the ensemble and one note document per voice. Matrix Edit and other ShadowScore clients connect to edit their assigned voice while watching the rest of the ensemble on the same grid.

## First Shape

- Shared `context`: scale, root, grid, clip, and seed.
- Per-voice `notes`: ShadowScore note documents owned by ensemble players.
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
- `POST /context`: replace or merge shared ShadowScore context.
- `POST /voices/:voiceId/notes`: replace a voice's ShadowScore notes document.
- `GET /events`: server-sent event stream of score changes.

## Development

```sh
npm test
```

No runtime dependencies are required for the initial scaffold.
