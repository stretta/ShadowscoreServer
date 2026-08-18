# Authoritative Transport Object Model Development Plan

## Goal

Provide one musician-facing transport truth owned by the Wren ShadowScore
server. Browser pages, Shadowboxes, Max patches, and future remote interfaces
act as equal clients: they submit intent and render acknowledged authoritative
state.

The first UI consumer is a compact shared transport bar with Play, Stop,
overall position, elapsed time, bars/beats, tempo, active section, and sync
health.

## Non-goals

- Replacing JACK as the musical timing authority.
- Replacing RNBO READY/ACTIVE transactions.
- Making a browser, Max patch, or Shadowbox an independent transport owner.
- Continuously disciplining the freewheeling RNBO metros after a verified start.

## Invariants

1. Wren publishes one revisioned transport state.
2. Commands are idempotent, carry request IDs, and return acknowledged state.
3. User interfaces update from acknowledged state, never local command
   assumptions.
4. Position is a timestamped anchor that clients may interpolate visually.
5. Desired transport state, authoritative musical position, observed RNBO
   execution, and an in-progress operation remain distinct.
6. Score preparation never determines phase, and phase judgment is suppressed
   while preparation is unsettled.
7. Wren's local RNBO clients participate in ensemble consensus but are not
   privileged as the phase reference.
8. `clock_start_ack` is a start barrier, not a phase witness. After the whole
   cohort acknowledges Clock On, Wren sends one concurrent running `SetStage`
   correction followed by `clock_phase_reset`. The latter immediately restarts
   each freewheeling metro without the beat-quantizing onebang; its
   `clock_phase_ack` is emitted by the first resulting metro bang.
9. Continuing activation preserves a numeric stage. Every section and client
   in one uninterrupted arrangement must therefore use the same
   `ClockInterval`; unstable adaptive contracts are rejected before playback.
10. Timing-critical UDP and OSCQuery traffic to registered peers uses the
    observed registration source IP while preserving advertised hostnames for
    display and ordinary discovery.

## Object Model V1

Root path:

```text
shadow_score
└── transport
    ├── arrangement
    ├── position
    ├── tempo
    ├── players
    └── sync
```

The initial stable object is `transport`. It exposes:

- `is_playing`
- `position_beats`
- `position_seconds`
- `position_bars_beats_ticks`
- `duration_beats`
- `duration_seconds`
- `tempo`
- `time_signature`
- `active_section`
- `authority`
- `operation`
- `sync_health`

Methods:

- `play`
- `stop`
- `locate_beats`
- `locate_fraction`
- `return_to_start`
- `previous_section`
- `next_section`
- `re_sync`

## Protocol V1

HTTP and SSE form the canonical protocol. Max-facing `ss.path`, `ss.object`,
and `ss.observer` wrappers adapt to the same endpoints.

```text
GET  /api/v1/objects/resolve?path=transport
GET  /api/v1/objects/transport
POST /api/v1/objects/transport
GET  /api/v1/objects/transport/events
```

Object operations use one envelope:

```json
{
  "requestId": "caller-generated-id",
  "operation": "call",
  "name": "play",
  "arguments": []
}
```

Observers receive an immediate snapshot followed by revisioned snapshots. A
property filter may reduce the event payload, but every event retains object
ID, revision, observation time, and source request ID.

## Compact Test Score

`config/score-initialization.transport-test.json` is the fleet canary:

- seven players matching the live Wren/Finch/Raven/Heron rig;
- four two-bar sections;
- varying section tempos;
- two notes per player per section;
- no persisted runtime mappings;
- mappings applied from live target identity after initialization.

This score may replace Wren's current score. No current score backup is
required for this development run.

## Delivery Checkpoints

### Checkpoint 1: Contract and compact score

- Land the object schema and regression tests.
- Preview and initialize the compact score on Wren.
- Reapply seven live player routes by stable target identity.
- Prove short preparation and transaction-matched ACTIVE state.

### Checkpoint 2: Authoritative state and observation

- Add the V1 resolve, object, operation, and SSE routes.
- Derive state from the coherent playback snapshot and score structure.
- Publish revisioned timestamped position anchors.
- Preserve request IDs through acknowledgements and observer events.

### Checkpoint 3: Shared transport bar

- Add one reusable web component to shared navigation.
- Render Play/Stop, section, slider, elapsed/total time, bars/beats, BPM, and
  sync health.
- Interpolate position locally between authoritative anchors.
- Commit seeks only on slider release.

### Checkpoint 4: Max adapters

- Provide `ss.path`, `ss.object`, and `ss.observer` Max abstractions or
  JavaScript wrappers.
- Demonstrate resolve, get, set/call, and property observation.
- Ensure notification-driven commands defer out of observer callbacks.

### Checkpoint 5: Live acceptance

- Deploy source-copy changes to identity-verified Wren.
- Verify checksums, service freshness, routes, SSE, and hardware smoke.
- Exercise commands from two browser pages and confirm convergent state.
- Verify all seven RNBO clients remain ACTIVE and phase-aligned.
- Verify the ACK cohort, running phase correction, and direct phase witness on
  both a held start and across A to B and B to C continuing activations.
- Request musician verification of density, readability, seek behavior, and
  physical audibility.

## Migration Rule

Existing `/transport/*` routes remain as compatibility entry points during the
first delivery. The V1 object operation handler delegates to those same
services. Once all user-facing clients consume the object model, direct UI
state ownership and duplicated polling paths can be removed.
