# RNBO OSC Snapshot Staging Protocol

Status: proposed version 1 client contract for Phase 7. The ShadowscoreServer
boundary-recall path remains best effort until supported sequencer exports
implement and advertise this protocol.

## Why This Lives In RNBO

Existing RNBO params and message inports mutate the running sequencer as soon as
OSC arrives. A server-side lead window therefore changes the outgoing block
early. Exact block transitions require the export to hold a complete pending
snapshot, validate it, and publish it immediately before the sequencer computes
the first step of the requested shared beat.

The direct editor interface remains unchanged. Normal param and list messages
still edit the active process immediately; only the transaction inport below
writes pending state.

## Export Surface

Each supported sequencer adds:

- message inport `shadowscore_snapshot`;
- message outport `shadowscore_snapshot_ack`;
- inport metadata `snapshot_protocol: 1` and `snapshot_staging: true`; and
- a stable positive `snapshot_id` in the metadata of every persistent param and
  list inport that can participate in a snapshot.

`snapshot_id` values are app-local and must remain stable when patch cords or
RNBO parameter order changes. Shadowscore discovers the ids from OSCQuery; it
does not store them in the score. Momentary controls such as RTZ, get/probe,
panic, and existing ACK ports do not receive ids.

All transaction messages are numeric lists. `txn` is a positive 31-bit integer.

| Opcode | Name | Message |
| --- | --- | --- |
| 10 | Begin | `10 txn expectedParams expectedLists` |
| 20 | Param | `20 txn snapshotId value` |
| 30 | List | `30 txn snapshotId length value...` |
| 40 | Commit next beat | `40 txn clockMode` |
| 50 | Abort | `50 txn` |

`clockMode` is `-1` to preserve the active clock, `0` to stop on the commit
beat, or `1` to arm/start on the commit beat. Clock is never a separate opcode
20 write; it remains the final transaction decision.

The ACK outport emits:

```text
90 txn status receivedParams receivedLists
```

Status values are:

- `1`: committed on the shared beat;
- `-1`: stale or unknown transaction;
- `-2`: expected/received control-count mismatch;
- `-3`: unknown snapshot id;
- `-4`: invalid value or list length.

The receiver counts unique control ids, not packets, so retrying one param or
list overwrites pending state without inflating the validation count. A new
Begin abandons any incomplete pending transaction. A rejected Commit leaves the
currently active state untouched.

## RNBO Commit Behavior

The patch maintains separate pending and active state:

1. Begin clears only pending transaction state.
2. Param and List messages write pending registers/buffers for the matching
   transaction. They must not feed active sequencer logic or visible params.
3. Commit validates the transaction and arms one pending publication.
4. On the next Link/JACK-derived shared beat, publish all pending controls
   before calculating that beat's first sequencer step, apply `clockMode`, then
   emit the committed ACK.
5. No partial transaction becomes audible. If validation fails, continue using
   the previous active state.

Internal application of pending parameter values should also update the RNBO
params on the commit beat so OSCQuery and browser hydration reflect the active
state. Pending list buffers become the lists returned by the existing `-999`
ACK/readback mechanism only after commit.

Direct `Clock` behavior remains compatible with the existing contract:

- a direct `Clock: 0` is an immediate manual suspension;
- a direct `Clock: 1` arms the next shared beat;
- a staged `clockMode` is applied only on the transaction's commit beat.

## Export-Specific Pending State

AnalogSequencer stages all persistent params: the 16 stage values, 16 stage
enable flags, GateTime, Swing, Mode, MaxCnt, SwingAmt, ClockRate, and any other
editor-visible persistent param. RTZ and current-stage readback remain outside
the protocol.

ListSequencer stages Root, Scale, transpose params, ClockRate, and the Steps,
PrimaryRotation, SecondaryRotation, Velocity, and Duration lists.

ListVelSequencer stages the eight pitch-map params, ClockRate, and all eight row
lists. The RNBO source should rename the current `4ow` inport to `4row`; the
server retains its compatibility alias for older exports. ListSequencer and
ListVelSequencer should also export the clock param directly as `Clock`; the
server retains its `Clock_1_` compatibility alias.

## Max Project And Export Workflow

The current source is the Max project:

```text
/Users/mdavidson/Documents/Max 9/Projects/Shadowbox Exports/Shadowbox Exports.maxproj
```

The three RNBO patchers are embedded `rnbo~` subpatchers in:

```text
/Users/mdavidson/Documents/Max 9/Projects/Shadowbox Exports/patchers/Shadowbox Exports.maxpat
```

After modifying and saving those subpatchers in Max, use the existing RNBO
export/transfer workflow. ShadowscoreServer does not need the generated export
files locally; it verifies the result from live OSCQuery metadata and the ACK
outport on wren.

## Live Acceptance Test

1. Confirm all three apps expose protocol metadata and stable control ids in
   OSCQuery.
2. Begin and stage visibly different snapshots on at least two sequencers;
   confirm active params, list ACKs, and sound remain unchanged.
3. Commit both before the same shared beat and confirm both ACK on that beat.
4. Confirm the first emitted steps use the new state and are audibly in phase.
5. Repeat with different payload sizes and a staged clock-off block.
6. Drop one transaction packet and confirm count validation rejects the commit
   without changing active state; resend the complete transaction and commit.

