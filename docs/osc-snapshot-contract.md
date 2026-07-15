# OSC Snapshot Contract

Status: OSC clip payload contract, schema version 1.

## Durable Names And Identity

- The top-level logical-role assignment collection is `oscAssignments`.
- Reusable OSC state lives in the top-level `oscClips` collection.
- Each mesostructural block maps roles to clip ids in `oscLayers`.
- An OSC clip uses `schemaVersion: 1` and an `app` semantic identifier.
- Snapshot keys are semantic RNBO parameter or message-inport names. OSC paths,
  hosts, ports, RNBO instance numbers, and `oscTargetId` values are never stored
  in a snapshot.
- A logical role may remain unassigned, offline, ambiguous, or ignored while
  its block snapshots remain valid and editable.

Runtime resolution uses the normalized OSC target catalog. An unlocked role is
matched by stable `deviceId` plus exact `app` or the corresponding editor
capability. One compatible online target refreshes `oscTargetId`; multiple
compatible online targets are ambiguous and never chosen silently. A locked
role never retargets. `ignoreRecall` does not prevent safe routing refresh, but
the resolved role remains non-sendable for snapshot recall.

The version 1 OSC clip shape is deliberately small:

```json
{
  "name": "List opening",
  "schemaVersion": 1,
  "app": "listsequencer",
  "params": { "ClockRate": 2, "Clock": 1 },
  "inputPorts": { "Steps": [1, 0, 1, 0] },
  "capture": {}
}
```

A block layer contains only `{ "clipId": "list-opening" }`. Live routing
continues to come from the corresponding logical role in `oscAssignments`.

Parameter values are finite numbers. RNBO enum parameters are stored as their
zero-based option index; at recall time the compiler resolves that index
against the live OSCQuery `values` array and sends the export's string value.
This keeps the score numeric while honoring exports that reject numeric enum
writes. An unavailable index is reported as `invalid-enum-index` and is not
sent. Input-port values are numeric lists;
empty lists are retained so an export that supports clearing a list can do so.
Unknown semantic names are accepted at save time because scores must remain
authorable without the rig. The recall compiler reports names absent from the
resolved live export.

## Persistent-Control Contract

The editor owns the allowlist. A version 1 editor snapshot may contain:

- RNBO parameters presented as persistent editor state;
- OSC message-inport lists held in the editor draft; and
- controls explicitly opted in with `meta.snapshot: true` or
  `meta.snapshot_state: true`.

The following are excluded unless a future export explicitly opts them in:

- `RTZ`, reset, panic, probe, and `SetStage` commands;
- ACK/get/readback ports and values;
- current-stage, playback-debug, scope, meter, and other observed state; and
- browser-only selection, routing, dirty-state, and status fields.

`meta.snapshot: false` or `meta.snapshot_state: false` always excludes a
control. `meta.snapshot_order: "late"` places an otherwise persistent control
in the late group. `Clock` is recognized by semantic parameter name and always
forms the final group. The saved document still contains only `params` and
`inputPorts`; ordering metadata belongs to the editor/export contract and is
applied when the semantic names resolve against a live target.

## Dispatch Order

For each resolved role, the compiler produces:

1. persistent non-clock parameters;
2. persistent input-port lists;
3. controls marked late by editor/export metadata;
4. `Clock`, when saved.

Roles may dispatch concurrently, but writes for one resolved instance remain
ordered. A missing or excluded control is reported for that role and does not
prevent other roles from dispatching.

Best-effort recall attempts every compiled write even when an earlier send to
the same instance fails. Results distinguish planned, attempted, successful,
failed, missing, excluded, and skipped controls. They prove only the immediate
server send attempt; version 1 does not require per-field ACK verification.

Recall diagnostics also expose measurement fields used for boundary-burst
evaluation:

- `plannedPacketBytes`, `attemptedPacketBytes`, `succeededPacketBytes`, and
  `failedPacketBytes` count encoded OSC datagram bytes, not IP/UDP overhead;
- each write includes `packetBytes`, monotonic `startedOffsetMs` and
  `completedOffsetMs`, and its send-call `durationMs`;
- `dispatchDurationMs` spans the first attempted write through the last
  completed write across concurrently dispatched targets;
- dry runs report planned packet bytes while attempted bytes and dispatch
  duration remain zero.

These are send-side measurements. They do not prove receipt, RNBO application
time, or audible activation time.

The normalized target catalog also absorbs verified legacy export spellings
without storing them in scores: `Clock_1_` resolves as semantic `Clock`, and
ListVelSequencer's `4ow` input resolves as semantic `4row`. Dispatch still uses
the actual advertised OSC address.

## Common Sequencer Clock Contract

Supported sequencer exports use these semantics:

- `Clock: 1` arms the sequencer and starts it on the next observed shared beat.
- `Clock: 0` suspends the sequencer immediately and preserves its authored
  state for later re-entry.
- `Clock` is compositional snapshot state, is never inferred from a zero-step
  pattern, and is always sent after the rest of the snapshot.
- `RTZ` remains a momentary performance command and is not snapshot state.

Because `Clock: 0` is immediate, lookahead recall must not send it before the
block boundary. Initial recall sends the ordered burst at block entry and
records encoded size plus high-resolution dispatch duration. Live dense-burst
measurement on wren selected a future staging/commit contract for exact
phase-aligned transitions; until supported exports implement that contract,
ordered boundary recall remains best effort and does not claim atomic
activation.

## Fixtures

[`test/fixtures/osc-snapshot-contract.json`](../test/fixtures/osc-snapshot-contract.json)
covers parameter-only, list-based, clock-off, offline, unassigned, ignored, and
unknown-control cases across ListSequencer, ListVelSequencer, AnalogSequencer,
Plate, Poland, SoftPiano, and TTID. These are contract fixtures; score storage
and mutation fixtures arrive with Phase 2.
