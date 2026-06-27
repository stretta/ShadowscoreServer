# Wren JACK Transport Macro Playback Plan

## Goal

Replace ShadowscoreServer's macro playback wall-clock timer with a JACK-driven
musical-position follower on `wren`, while keeping ShadowscoreServer as the
authority for macrostructure, mesostructure, score compilation, and RNBO block
handoff.

The immediate scope is host-only: `wren` reads its local JACK transport and uses
that as the macro boundary clock. Bird-side JACK/RNBO probes can be added later
for diagnostics, but they are not required for the first implementation.

## Current Findings

On `wren`, RNBO's JACK surface reports:

- JACK is active.
- JACK transport is rolling.
- Link sync is enabled.
- JACK transport sync is enabled.
- Link sees 4 peers.
- BPM is 120.

The RNBO HTTP field `/rnbo/jack/transport/position` stayed at `0.0` while RNBO
`current_stage` advanced, so it should not be used as the live macro boundary
witness.

A direct `jack_transport_query()` probe against `libjack.so.0` on `wren` reported
valid BBT:

```text
state=rolling
frame_rate=48000
valid=0x10
bbt=True
bpm=120.000000
ticks_per_beat=1920
```

Bar, beat, and tick advanced steadily. This means a small JACK helper can expose
real musical position to the server.

## Architecture

```text
JACK/Link on wren
  -> JACK transport helper
  -> ShadowscoreServer transport state
  -> JACK-driven macro playback follower
  -> structureState advance
  -> RNBO score transaction for the newly active block
  -> optional SetStage phase alignment
```

Link/JACK provides the shared beat reference. ShadowscoreServer decides the form:
which meso block is active, how long it is in beats, and which block comes next.

## Phase 1: JACK Transport Helper

Add a small host-side helper process for `wren`. It can be implemented as either:

- `bin/jack-transport-bridge.py`, using Python `ctypes` against `libjack.so.0`.
- A tiny C helper, if JACK development headers are installed or vendored later.

Given the current `wren` state, Python `ctypes` is the lower-friction first path:
`libjack.so.0` exists, but JACK headers and `jack.pc` are not installed.

The helper should call `jack_transport_query()` every 50-100 ms and POST a
snapshot to ShadowscoreServer:

```json
{
  "source": "jack",
  "host": "wren",
  "state": "rolling",
  "frame": 767223806,
  "frameRate": 48000,
  "bbtValid": true,
  "bar": 7991,
  "beat": 4,
  "tick": 730,
  "ticksPerBeat": 1920,
  "beatsPerMinute": 120,
  "absoluteBeat": 31963.380208,
  "observedAt": 1782580000000
}
```

`absoluteBeat` should be computed from JACK BBT as:

```text
((bar - 1) * beatsPerBar) + (beat - 1) + (tick / ticksPerBeat)
```

If BBT is not valid, the helper should still report frame/state but mark
`bbtValid: false`; the server must not use that snapshot for macro advancement.

## Phase 2: Server Transport State

Add transport state separate from score state:

- `POST /transport/jack/snapshot`
- `GET /transport`
- `GET /transport/events`

The server stores the latest JACK snapshot and calculates freshness:

- `fresh`: last snapshot arrived within a configured threshold.
- `stale`: no recent snapshot.
- `unusable`: no snapshot or `bbtValid` is false.

`GET /transport/events` should use Server-Sent Events so browser displays can
update without refresh. The codebase already uses SSE for `/events`, so this can
follow the existing pattern.

## Phase 3: JACK-Driven Macro Playback

Extend macro playback with a JACK follower mode. The existing timer mode can
remain as a fallback while the JACK path is proven.

On start:

```text
activeBlockStartBeat = currentJack.absoluteBeat
activeBlockDurationBeats = duration(active meso block)
activeBlockEndBeat = activeBlockStartBeat + activeBlockDurationBeats
```

On each fresh JACK snapshot:

```text
if jack.absoluteBeat >= activeBlockEndBeat:
  advanceStructurePlayhead()
  anchor next block at activeBlockEndBeat
```

Anchoring the next block at the previous `activeBlockEndBeat` preserves musical
form if the server wakes a little late. If the server is very late, it can
advance through multiple blocks until the end beat is ahead of the current JACK
beat, but that behavior should be guarded and logged.

The follower should only advance while JACK state is `rolling` and the snapshot
is fresh and BBT-valid.

## Phase 4: Transport Write Policy

Separate timing-contract writes from tempo authority.

Keep these server-owned during normal score and block handoff:

- `MaxSteps`
- `ClockInterval`

Make tempo authority explicit:

```json
{
  "transport": {
    "tempoAuthority": "link"
  }
}
```

Modes:

- `link`: do not send `Tempo` on routine score/block changes. The server follows
  JACK/Link tempo.
- `server`: server tempo writes intentionally steer ensemble tempo through the
  ShadowScoreClient/RNBO tempo parameter.

This avoids duplicating tempo control when the ShadowScoreClient's tempo
parameter already drives Link.

## Phase 5: Host Transport UI

Add a host-focused live status page or panel, initially for `wren`:

- JACK state.
- Link peers.
- BPM.
- Absolute beat.
- Active block.
- Macro index.
- Block start beat.
- Next block beat.
- Beats remaining.
- Bridge freshness.
- Macro playback mode: stopped, timer, or JACK follower.

Controls can be minimal:

- Start JACK follower.
- Stop macro playback.
- Re-anchor current block at current JACK beat.
- Advance now.
- Reset to block A.
- Optional direct `SetStage 0` action.

Use SSE for no-refresh updates.

## Phase 6: Phase Alignment

Keep block advancement separate from phase alignment.

JACK tells the server when the musical boundary has been crossed. It does not
guarantee every RNBO client receives stage `0` at the exact block-local boundary.
That remains a `SetStage`/counter-reset problem.

First pass:

- Advance the macro playhead from JACK beat boundaries.
- Send the newly active block transaction.
- Send or arm `SetStage 0` through the existing RNBO transport route.

Later refinement:

- Schedule `SetStage 0` against an upcoming JACK beat/downbeat rather than
  sending it immediately after the server observes the boundary.

## Verification Plan

1. Run the JACK helper on `wren` and verify it posts fresh BBT snapshots.
2. Confirm `GET /transport` reports `fresh`, `bbtValid: true`, and increasing
   `absoluteBeat`.
3. Confirm `/transport/events` updates a browser page without refresh.
4. Start macro playback in JACK follower mode.
5. Confirm the active block advances at the expected beat boundary.
6. Compare active block duration against `/playback/timing-contracts`.
7. Confirm RNBO receives the new block transaction after `structureState`
   advances.
8. Confirm no routine score resend writes `Tempo` when `tempoAuthority` is
   `link`.
9. Confirm fallback timer mode still works if the JACK bridge is unavailable.

## Open Decisions

- Whether the JACK helper should be managed by a new systemd service or by
  ShadowscoreServer spawning it on `wren`.
- Whether `tempoAuthority` belongs under `rnbo.transport` or a new top-level
  `transport` config section.
- Whether the first `SetStage 0` behavior should be immediate on advance or
  manually triggered from the host UI until the scheduling model is proven.
