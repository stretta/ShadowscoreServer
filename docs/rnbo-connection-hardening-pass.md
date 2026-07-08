# RNBO Connection Hardening Pass

## Goal

Harden the ShadowScore-to-RNBO connection without losing the stable baseline we
now have with the four current Pis.

The near-term goal is not a new musical feature. It is to make score delivery
more observable, more recoverable, and eventually cheaper to send:

- Keep whole-score replacement transactions as the canonical delivery model.
- Make client commit state explicit enough that the server can trust or reject a
  target based on evidence.
- Reduce routine traffic only after the RNBO client proves that compact
  replacement is safe.
- Preserve a mixed-fleet path where old clients keep receiving full-clear
  transactions while one canary client advances.

## Current Baseline

As of the July 8 live check, the useful baseline is:

- `wren` is the server and also a local RNBO client.
- `finch`, `heron`, and `raven` are peer clients.
- All four ShadowScore playback targets are visible through `/rnbo/targets`.
- Current score sends receive committed ACKs from all four playback targets.
- `finch` is also visible to the Poland editor as `finch:poland:main` after
  refreshing its peer registration agent.
- Poland editor discovery depends on registered `oscTargets`; ShadowScore
  playback depends on registered RNBO score `targets`. Those are related but
  separate surfaces.

Treat this as the known-good mixed-fleet state before changing RNBO client
behavior.

## Roles During The Pass

Use the four Pis intentionally:

- `wren`: server and stable control. Avoid changing its local RNBO client early,
  because it is the reference server and a useful known-good local target.
- `finch`: canary client. It already exercised the class of bug where server
  state looked correct while client playback state needed proof.
- `heron` and `raven`: legacy comparison clients. Keep them on the current
  client behavior while finch changes so mixed-fleet compatibility remains
  visible.

Only promote a behavior from finch after it survives clear, fewer-notes,
more-notes, empty-score, restart, and assignment/resend tests.

## Hardening Order

### 1. Preserve And Recheck The Baseline

Before making a protocol or client change, capture the live state:

- `/hardware/units`
- `/rnbo/targets`
- `/osc/targets?app=poland&status=online`
- `/playback/timing-contracts`
- `/score`

The important witnesses are:

- registered unit and target shape
- `sendStatus.ack.status`
- `noteCount` versus `transmittedRowCount`
- `replacementMode`
- target capabilities
- `playback_debug` when checking actual stale-note behavior

`midi_debug` can be useful as a last emitted MIDI trace, but it is not the
authoritative stale-row proof because it can remain latched.

### 2. Add Server-Side Resend Dampening

The server already queues and coalesces score resends while a send is active.
The next server-side hardening step is a short quiet-window before the first
RNBO resend caused by rapid score mutations.

Recommended first value:

```text
75-150 ms
```

This is not a replacement for compact sends. It only avoids sending a full score
transaction for every transient edit during a drag or bursty UI operation.

Keep manual `POST /admin/rnbo/resend` immediate. Operator recovery should not
wait behind an edit debounce.

### 3. Make ACK State More Operational

ACKs should continue to be surfaced per target in `/rnbo/targets` and Admin, but
the states should be clear enough for operator decisions:

- `committed`
- `pending` or `in-progress`
- `missing`
- `stale transaction`
- `note count mismatch`
- `rejected`
- `unreachable`

If the server cannot prove a commit, it should not look quietly healthy. The
target should read as needing resend or recovery.

### 4. Update Finch Without Advertising Compact Support

The first RNBO client update should improve transaction safety while still
looking legacy to the server.

On finch:

- `BEGIN_REPLACE` abandons stale receiver state for the incoming transaction.
- The receiver tracks `activeTxn`, `expectedNotes`, and `receivedNotes`.
- `COMMIT` validates transaction id and note count before publishing.
- ACKs distinguish committed, stale, mismatch, and rejected states.
- The client still does not advertise `compactScoreReplace`.

This lets us test the safer transaction receiver without also changing traffic
volume or playback scan semantics.

### 5. Prove Active Row Count On Finch

After the transaction receiver is stable, update finch playback lookup so it
scans only committed active rows:

```text
for row in 0 .. activeRowCount - 1
```

Required tests:

- More notes to fewer notes: stale rows above the new count do not sound.
- Notes to empty score: `activeRowCount = 0` produces no playback.
- Dense same-stage chords still emit all expected notes.
- Restart RNBO or `rnbooscquery`, then resend and confirm a clean commit.

Use `playback_debug`, `/rnbo/targets`, and audible behavior as the proof set.

### 6. Advertise Compact Capability Only From Finch

Only after finch proves active row count behavior should it advertise:

```js
{
  supportsBeginReplaceClear: true,
  activeRowCountCommit: true,
  compactScoreReplace: true
}
```

Then verify a mixed send:

- finch receives `replacementMode: "compact"`
- finch has `transmittedRowCount = noteCount`
- wren, heron, and raven stay `replacementMode: "legacy-full-clear"`
- legacy targets still receive capacity-sized clear rows
- every assigned target reports committed ACKs

The whole point of this stage is to prove one new client can coexist with three
legacy clients.

### 7. Promote One Client At A Time

After finch is boring:

1. Promote one of `heron` or `raven`.
2. Keep the other as a legacy comparison target.
3. Promote the remaining peer.
4. Update wren's local RNBO client last.

Do not change the default target capability for the lab image until normal
clients reliably advertise compact support and the full-clear escape hatch has
survived real use.

## Efficiency Strategy

Prefer these in order:

1. Coalesce and debounce routine score sends.
2. Keep full replacement transactions, but make compact replacement safe.
3. Use per-target capability gates.
4. Measure resend wall-clock time and per-target ACK latency.
5. Consider per-target pacing or concurrency limits only if live evidence shows
   packet loss or ACK instability.

Avoid edit-delta transport for this pass. Deltas may reduce traffic, but they
make recovery and proof harder. Full replacement with compact rows gives most of
the efficiency gain while keeping failure modes understandable.

## Rollback Rules

Keep these escape hatches available throughout the pass:

- `POST /admin/rnbo/resend?mode=full-clear`
- `rnbo.forceFullClearRows`
- per-target compact capabilities defaulting to `false`
- removing compact capability advertisement from a misbehaving client
- restarting `rnbooscquery` on a stuck client, followed by a resend

If any compact target behaves strangely, remove its compact advertisement first.
The server should then return that target to legacy full-clear behavior without
requiring a server rollback.

## Definition Of Done

The hardening pass is successful when:

- Four-Pi baseline remains stable after the server debounce and ACK-status work.
- Finch proves safe receiver reset and active row count behavior.
- Finch can run compact while the rest of the fleet remains legacy.
- Empty-score, fewer-notes, and restart recovery tests do not leave stale notes.
- Admin and `/rnbo/targets` clearly show target health and commit state.
- Full-clear recovery remains available and proven.

