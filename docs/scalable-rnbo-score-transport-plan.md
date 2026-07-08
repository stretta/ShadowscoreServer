# Scalable RNBO Score Transport Plan

## Goal

Make ShadowScore-to-RNBO score replacement scale to the normal ensemble shape:
six players with two RNBO playback instances each.

The current safe resend path can transmit up to every target's full note-row
capacity on every score update. With expanded clients that is `819` note rows
per target. For twelve targets, a normal resend can therefore become thousands
of OSC messages before ACK validation and retry. That is stable, but it is not
performance-scale.

The desired steady-state transport is still a full replacement transaction, not
a fragile edit-delta stream:

```text
BEGIN_REPLACE
actual NOTE rows only
COMMIT
ACK validation
```

The client must make `BEGIN_REPLACE` authoritative enough that the server no
longer needs to pad every transaction with capacity-sized clear rows.

## Current State

The server currently compiles one active-block transaction per assigned RNBO
target. `compileScoreTransaction()` pads transactions when `clearRowCount` is
enabled:

```text
transmittedRowCount = max(actualNoteCount, clearRowCount, target.maxNoteRows)
```

That full-row clear behavior fixed stale notes when clients kept scanning rows
above the new note count. It is intentionally conservative.

The server now also validates RNBO `shadowscore_ack` after score sends and
retries once on bad ACKs. That makes client commit state observable, but it also
reveals how expensive full-capacity sends are when an ACK read fails or a target
needs a retry.

Current live example:

```text
target count: 4
transmitted rows per target: 819
normal rig target count: 12
```

At `sendDelayMs: 5`, twelve full-capacity targets imply roughly 49 seconds of
row pacing before ACK reads and retries. The design must remove that multiplier.

## Design Principle

Keep score delivery boring and deterministic.

Use whole-target replacement transactions, but make replacement cheap. RNBO
should not need every stale row overwritten by an OSC `NOTE` message. It should
reset local receiver/playback state at transaction start, then mark only the
committed row range active.

This keeps failure behavior simple:

- A transaction either commits and becomes active, or it does not.
- Old committed data remains active until a new transaction commits.
- A failed transaction cannot leave half-replaced note rows visible to playback.
- Server-side ACK validation can distinguish committed, rejected, stale, and
  unreachable targets.

## Target Protocol

### BEGIN_REPLACE

`BEGIN_REPLACE` must become a real staging reset:

```text
client opcode txn protocol_version note_count pattern_length stages_per_beat flags
```

Required receiver behavior:

- Abandon any previous active transaction.
- Clear staged row count and staged metadata.
- Reset `receivedNotes` to `0`.
- Record `expectedNotes`, `patternLength`, and `stagesPerBeat`.
- Do not mutate the currently committed playback table yet, unless the client
  uses separate active/staging buffers or can complete the clear atomically.

The safer client model is double-buffered:

```text
active table: used by playback
staging table: written by incoming transaction
COMMIT swaps staging into active
```

If RNBO memory constraints make full double buffering impractical, use a single
data buffer plus an active row-count commit guard:

```text
BEGIN_REPLACE clears only receiver counters
NOTE writes rows 0..N-1
COMMIT sets activeRowCount = expectedNotes
playback scans rows 0..activeRowCount-1 only
```

That single-buffer model is acceptable only if playback never scans beyond
`activeRowCount`.

### NOTE

The server sends only actual active notes for the target:

```text
NOTE opcode txn index note_id pitch start_stage duration_stages velocity mute probability_i velocity_deviation_i release_velocity
```

No synthetic clear rows are sent in the compact path.

Indexes must be dense from `0` through `noteCount - 1`.

### COMMIT

`COMMIT` should validate and publish the staged transaction:

```text
COMMIT opcode txn expected_note_count checksum
```

Required receiver behavior:

- Reject if no transaction is active.
- Reject if `txn` does not match `activeTxn`.
- Reject if `receivedNotes` does not match `expectedNotes`.
- Reject if `expected_note_count` does not match `expectedNotes`.
- On success, set `activeRowCount = expectedNotes`.
- On success, publish `patternLength` and `stagesPerBeat` for playback.
- Emit commit ACK with `opcode 90` and `ok 1`.

Checksum can remain `0` during rollout. Add a checksum after the compact path is
stable.

### Playback Lookup

Playback must scan only committed active rows:

```text
for row in 0 .. activeRowCount - 1
```

It must not scan `maxNoteRows`, data-object capacity, or stale receiver
metadata. This is the core requirement that makes compact sends safe.

On a no-note stage, `playback_debug` should emit a miss such as:

```text
30 current_stage 0
```

`midi_debug` can remain latched as a last-note convenience, but it must not be
used as the authoritative sync proof.

## Capability Gate

Do not simply turn off full-row clearing globally. Older or stale RNBO clients
may still require the defensive clear path.

Add a target capability:

```js
{
  supportsBeginReplaceClear: true,
  activeRowCountCommit: true,
  compactScoreReplace: true
}
```

Suggested interpretation:

- `compactScoreReplace: true`: server may send actual notes only.
- `supportsBeginReplaceClear: true`: `BEGIN_REPLACE` resets stale transaction
  receiver state.
- `activeRowCountCommit: true`: playback scans only committed active rows.

All three should be true before the server skips full-capacity clear rows.

Legacy targets keep the current behavior:

```text
transmittedRowCount = max(actualNoteCount, target.maxNoteRows)
```

Compact targets use:

```text
transmittedRowCount = actualNoteCount
```

Keep an explicit admin/debug path for full-capacity resend, even after compact
mode becomes default.

## Server Implementation Plan

### Phase 1: Capability Plumbing

- Extend `rnboPlaybackCapabilities()` with:
  - `compactScoreReplace`
  - `supportsBeginReplaceClear`
  - `activeRowCountCommit`
- Preserve those fields through:
  - configured targets
  - OSCQuery-discovered targets
  - peer registration
  - `/rnbo/targets`
  - `/playback/timing-contracts`
- Default these capabilities to `false` for safety.
- Add tests proving old targets still get full-capacity clear rows.

### Phase 2: Server Compact Send Mode

- Add `compileScoreTransaction()` logic:

```text
if target.capabilities.compactScoreReplace:
  transmittedRowCount = notes.length
else:
  transmittedRowCount = max(notes.length, clearRowCount, target.maxNoteRows)
```

- Keep `noteCount` and `transmittedRowCount` distinct in results and ACK
  summaries.
- Add config override for forced legacy clearing:

```json
{
  "rnbo": {
    "forceFullClearRows": false
  }
}
```

- Add a manual admin route or query option for emergency full clear:

```text
POST /admin/rnbo/resend?mode=full-clear
```

The exact route shape can vary, but the operator needs a way to recover old
clients without editing config.

### Phase 3: RNBO Receiver Update

In `ShadowScoreRNBOClient`:

- Update the receiver script so `BEGIN_REPLACE` is authoritative.
- Reset stale transaction state on every `BEGIN_REPLACE`.
- Track `expectedNotes`, `receivedNotes`, `activeTxn`, and `activeClient`.
- On `COMMIT`, set committed `activeRowCount`.
- Emit ACKs that clearly distinguish:
  - committed
  - stale transaction
  - note count mismatch
  - unsupported protocol/capability
- Expose capability metadata through the ShadowScore input node or OSCQuery
  metadata so registration can advertise compact support.

### Phase 4: RNBO Playback Lookup Update

In `ShadowScoreRNBOClient`:

- Change playback lookup to scan only `activeRowCount`.
- Keep `maxNoteRows` as a hard safety ceiling, not the normal scan count.
- Ensure `activeRowCount = 0` is valid and produces no notes.
- Keep `playback_debug` as the authoritative current-stage witness.
- Verify dense same-stage chords still emit the full chord list.

### Phase 5: Mixed-Fleet Rollout

- Deploy compact-capable RNBO export to one test box.
- Confirm registration advertises compact capabilities for that target only.
- Confirm server sends compact rows to that target and full rows to legacy
  targets in the same score resend.
- Upgrade the rest of the birds.
- Only after all normal clients advertise compact support, change the default
  target capability for the lab image.

## Test Plan

### Server Unit Tests

- Legacy target with `maxNoteRows: 819` and `noteCount: 4` transmits `819` rows.
- Compact target with the same score transmits `4` rows.
- Empty compact target transmits `0` note rows between begin and commit.
- Mixed target send returns one legacy `transmittedRowCount: 819` and one compact
  `transmittedRowCount: noteCount`.
- ACK validation still retries rejected compact transactions.
- Emergency full-clear mode forces full-capacity rows even for compact targets.

### RNBO Client Tests

- `BEGIN_REPLACE` after a stuck transaction resets receiver state.
- `COMMIT` with missing notes rejects and leaves previous active table intact.
- `COMMIT` with `0` notes sets `activeRowCount` to `0`.
- Playback ignores stale rows above `activeRowCount`.
- Dense same-stage chords still produce correct `playback_debug`.
- `midi_debug` latch behavior is documented and not used as pass/fail proof.

### Integration Tests

- Server sends compact transaction to a compact-capable fake target.
- Server reads commit ACK and surfaces `ack.status: "committed"`.
- `/rnbo/targets` exposes latest send status and target compact capability.
- `/playback/timing-contracts` includes selected target capability metadata.

### Live Tests

Start with one box:

1. Load a score with many notes.
2. Resend and confirm compact target receives `transmittedRowCount = noteCount`.
3. Replace the score with fewer notes.
4. Confirm stale notes do not play.
5. Clear all notes.
6. Confirm `activeRowCount = 0` behavior through `playback_debug`.

Then test the normal ensemble shape:

```text
6 players
2 RNBO instances per player
12 assigned targets
```

Measure:

- resend wall-clock time
- per-target ACK status
- stage/readback sync
- audible stale-note absence
- behavior when one target is offline or rejects a commit

## Performance Target

For the normal rig, score resend time should scale with actual note count, not
target row capacity.

Example rough comparison for twelve targets:

```text
legacy: 12 * 819 rows = 9828 row messages
compact with 30 notes each: 12 * 30 rows = 360 row messages
```

That is the difference between a recovery-only operation and a viable routine
performance operation.

## Rollback And Safety

Keep these escape hatches until compact mode has survived real sessions:

- Per-target capability gate defaults to legacy behavior.
- Config option to force full clear rows.
- Admin full-clear resend.
- ACK status visible in `/admin/rnbo/resend` and `/rnbo/targets`.
- Operator guide documents that `playback_debug`, not `midi_debug`, is the
  proof surface for stale-row diagnosis.

If a compact client misbehaves, remove its compact capability advertisement and
the server will return to full-capacity clearing for that target.

## Recommended First Cut

Implement the server capability gate first while defaulting every target to
legacy behavior. Then update one RNBO client export to advertise compact support
and prove:

```text
compact send -> commit ACK -> no stale rows after note count shrinks
```

Do not change the default clear behavior for all clients until the RNBO receiver
and playback lookup prove `activeRowCount` semantics on hardware.
