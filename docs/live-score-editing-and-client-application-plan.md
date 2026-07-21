# Live Score Editing and Client Application Plan

## Status

Implementation and four-client acceptance are complete as of 2026-07-21.

- The server now records normalized score-mutation impact without coupling
  canonical writes to RNBO transmission.
- Per-block/per-target desired, prepared, and active hashes are exposed by
  `GET /playback/updates` and embedded in `/playback/snapshot`.
- Look-ahead and transport-start preparation select dirty/missing voices before
  compilation and retain complete compact target replacement.
- `POST /playback/updates/apply-next-beat` and
  `POST /playback/updates/update-now` implement the guarded server contract.
  Targets must advertise `continuingScoreActivation`; unsupported fleets are
  rejected before activation.
- The RNBO client source now includes an `ActivatePrepared` request armer and a
  phase-preserving boundary swap with an owned-note-flush signal.

Local server and RNBOscript contract tests pass. Finch instance 20, Heron
instance 11, Raven instance 12, and Wren instance 22 run the continuing client
and advertise `continuingScoreActivation`. Live canaries verified
wrong-transaction rejection, stopped stage-zero activation, selective
one-player next-beat activation without resetting the stage counter, matching
ACTIVE acknowledgements, and owned-note release when an empty replacement
became active.

The shared author-facing playback control is now present in Matrix Edit, Piano
Roll, Event List, and Structure Editor. It distinguishes Saved, Prepared, and
Active; chooses **Apply next beat** while running and **Update players now**
while stopped; shows per-player readiness; and refuses ensemble activation
when an assigned player is unavailable. Matrix Edit was implemented
source-first and exported from matrixedit commit
`a736acc529524d99d8e16596c48bab7bed6a2ad8`.

Ordinary edits now autosave in all four score-authoring surfaces. Piano Roll
retains recoverable drafts and Revert, Event List retains an explicit commit
for pasted bulk replacement, and Structure keeps cue/play/advance as explicit
performance actions rather than persistence operations.

The first four-bird attempt exposed and fixed a capability-truthfulness issue:
live discovery now treats the `ActivatePrepared` inport as authoritative. A
fresh-client test also exposed and fixed the missing configured client prefix
before OSCQuery readback exists. Finally, the A-to-B test exposed a legacy
macro arm path; macro advance and transport start now use the same guarded
atomic application path as live edits.

The final deployed acceptance run started block A with all four clients ACTIVE
at stage zero, prepared block B during look-ahead, and activated transaction
1005 on all four clients before the A-to-B boundary. Client readback returned
ACTIVE opcode 93 at stages 1021-1023 without a phase reset. Playback was then
stopped and returned to block A; the final server state reports all four A
payloads Active and no affected targets.

The plan follows from the phase-aligned RNBO rollout: score data is now
double-buffered, validated with READY, and activated atomically with ACTIVE.
That protects playback integrity, but it changes the old meaning of **Save**.
Saving the score and changing what the clients are playing are now separate
operations and must be presented that way everywhere.

## Goal

Preserve the immediacy of live editing without returning to partial,
mid-transfer client updates.

The authoring contract should be:

1. Ordinary edits are saved to the canonical score automatically.
2. Saving never claims that playback has changed.
3. The playing block can be updated explicitly with **Apply next beat**.
4. Upcoming blocks are prepared automatically from the latest saved score.
5. Only affected block/target payloads are prepared or transmitted.
6. Each affected target still receives a complete atomic replacement, not a
   fragile series of note-edit deltas.

This produces a live-editing feel at beat resolution while retaining complete
transactions, payload validation, READY/ACTIVE acknowledgement, and the
existing missed-deadline safety policy.

## Clean-Break Constraint

This redesign does not preserve legacy score-file or client-protocol
compatibility.

- Define one current score schema and one current playback protocol.
- Do not add compatibility readers, load-time migrations, dual-write fields,
  deprecated aliases, version-branching editor behavior, or old-client
  fallbacks for this work.
- Reject incompatible persisted scores with a clear schema error instead of
  silently reshaping them.
- At deployment, optionally archive the old persisted score for reference,
  then initialize a current-format score. Re-authoring current state is an
  acceptable cutover cost.
- Require every playback client to implement the continuing-activation
  contract before enabling the author-facing action. A mixed legacy/current
  fleet is not a supported operating mode.

This constraint applies only to historical data and protocols. Draft conflict
protection, transactional score writes, full-replacement recovery, and
READY/ACTIVE validation remain required because they protect current data and
live playback.

## Terms

Use these terms consistently in APIs, status models, logs, and user interfaces:

- **Draft**: a local edit that has not reached the canonical server score.
- **Saved**: accepted by the score store and assigned a score revision.
- **Desired**: the compiled payload implied by the latest saved score for one
  block and playback target.
- **Prepared**: the client has validated that desired payload and returned
  READY, but is not playing it.
- **Armed**: the prepared transaction has been scheduled for a beat boundary.
- **Active**: the client returned ACTIVE for that transaction and is playing
  it.
- **Dirty for playback**: the desired payload hash differs from the target's
  prepared and active hashes. This is not the same as an unsaved editor draft.

Do not use **Save**, **Send**, **Synced**, or **Live** as interchangeable labels.
A successful HTTP write proves only Saved. A successful UDP transfer plus READY
proves Prepared. Only a matching ACTIVE acknowledgement proves Active.

## Current Behavior Audit

### Editor persistence behavior

| Surface | Current canonical-score behavior | Current live behavior | Required direction |
| --- | --- | --- | --- |
| Matrix Edit | Note gestures are saved after an 80 ms quiet window. Assignment and TTID changes are also written directly. | A score mutation can trigger RNBO preparation, but the editor does not distinguish Saved from Active. | Keep autosave. Add shared playback-difference status and `Apply next beat` for the playing block. |
| Piano Roll | Each clip has a local draft and an explicit **Save** button. | Save also causes a score-change resend, preserving the old coupled mental model even though activation is staged. | Autosave completed gestures while retaining draft/conflict recovery. Replace Save with playback status and the shared apply action. Keep Revert/undo. |
| Event List | Notes and clip attributes remain local until separate **Save** actions. | Save can trigger RNBO preparation without proving activation. | Autosave validated row/attribute edits on blur or a short quiet window. Keep explicit confirmation for bulk replace/import and destructive operations. |
| Structure Editor | Block assignments and song form use explicit Save; tempo already writes on change; duplicate, delete, cue, and transport actions are immediate. | Block and macro changes are mixed with playhead-driven client preparation. | Autosave valid structural edits as atomic documents. Treat cue/play/advance as performance actions, not saves. Show the shared playback state when an edit changes the playing or prepared block. |
| TTID controls | Matrix Edit and TTID-capable editors write block TTID immediately. Some TTID routes can also audition selected OSC targets. | Score persistence, OSC audition, and RNBO score playback do not share one activation contract. | Keep canonical TTID autosave. Label direct OSC output **Audition**. Route playback-affecting application through the same block/target impact and boundary model. |
| OSC snapshot editors | **Write State** stores a block snapshot; control gestures can go directly to checked instances; **Recall Now** is explicit. | Persistence and live recall are already visibly separate. | Preserve this model. Reuse its explicit Write/Recall vocabulary as a precedent, but do not merge OSC snapshot recall with RNBO note-table activation. |
| Admin | **Save score** creates a named library snapshot. Load, restore, reset, initialize, routing changes, and RNBO resend are explicit operator actions. | **Resend RNBO score** is an all-target recovery operation. | Rename the library action to **Save score copy** if needed for clarity. Keep resend as recovery, separate from author-facing `Apply next beat`. Whole-score replacement must invalidate playback state explicitly. |

Consistency does not require every UI gesture to use the same debounce. It
requires every surface to mean the same thing by Saved, Prepared, and Active.
Multi-field or destructive operations may retain a confirmation step, but an
ordinary edit should not require a Save button merely to reach the canonical
score.

### Current RNBO update efficiency

The current path is partly efficient, but its selection model is too broad:

1. `shouldSendScoreTransaction()` allows selected score events to enqueue an
   RNBO resend. Ordinary sends are coalesced behind the configured 100 ms
   debounce.
2. A send enumerates every assigned RNBO playback target.
3. `compileScoreTransaction()` compiles only the active block and only the
   voice assigned to that target.
4. Compact replacement transmits the complete set of actual note rows for that
   target, not the client's full row capacity.
5. For staged clients, a matching block ID and payload hash can reuse an
   already active or prepared transaction, avoiding another UDP transfer for
   that unchanged target.
6. Manual/admin recovery intentionally bypasses reuse and may send every
   target again.

Therefore, a one-player edit does not necessarily put note rows on the wire to
every unchanged client: identical staged payloads can be reused. However, every
assigned target is still discovered, compiled, compared, and represented in
the send attempt. The system does not carry an explicit mutation impact such
as “Block B, Player 2 only.” It also does not send just the edited note or keep
a complete multi-block score on each client. Each client has an active table
and a staging table for one compiled block payload.

The whole-target replacement is intentional and should remain. The missing
optimization is selecting only dirty block/target payloads before compilation
and transmission.

### Event-routing inconsistencies

The current RNBO resend allowlist is not a complete playback-dependency model.
For example, it includes clip replacement, block replacement, macro updates,
playhead updates, voice note replacement, and assignment replacement, but
other mutations have different or absent paths. Restore/new/initialize,
assignment clear/preset, TTID distribution, scale transformation, OSC block
state, and routing operations do not all have equivalent behavior.

This makes the event name an unreliable proxy for client impact. The new model
must derive playback impact from the changed resource and its dependencies,
then decide independently whether to save, prepare, activate, recall OSC, or do
nothing live.

## Desired User Model

### Ordinary editing

After a completed edit gesture:

```text
Saving… -> Saved
```

If the edit changes the playing block:

```text
Saved · Players running previous version    [Apply next beat]
```

The button should never be named merely **Send**. Sending is an internal step,
not the result the author requested.

### Apply next beat

Pressing **Apply next beat** requests the latest saved revision of the playing
block, not the editor's private draft and not the score revision that happened
to be visible when the button was rendered.

The state progression is:

```text
Preparing affected players…
Ready · applies on next available beat
Applying…
Live
```

“Next available beat” means the first shared beat for which every required
target is READY before the safety deadline. If preparation misses the
immediately following beat, the server chooses a later beat and the UI says so.
It must never silently activate a partial ensemble or a stale transaction.

### Editing a future block

Future-block edits autosave but expose no performance button by default. When
that block enters the look-ahead window, the server prepares the latest saved
payloads automatically.

If an author edits an already prepared upcoming block:

- mark only affected prepared target payloads stale;
- supersede their old prepared transactions;
- prepare the new hashes if the deadline still permits it; and
- surface **Updating upcoming block** or **Update missed deadline** rather than
  allowing the old revision to activate invisibly.

The existing safety rule remains: never activate a late table partway through
a block. A missed required target must follow the documented suppress/mute and
recovery policy rather than play stale material as though it were current.

### Editing while stopped

When transport is stopped, the action becomes **Update players now**. It
prepares and activates the selected/current block at stage zero without waiting
for a running beat. Starting playback must also verify that the current block's
desired hashes are prepared before it arms Clock.

### No manual apply

If the author does not press the button, the edit remains safely Saved. It
becomes Active naturally the next time that block is prepared and entered.

## Architecture

### 1. Separate persistence from playback dispatch

Remove automatic RNBO preparation from the generic score-store change
listener. Replace it with two consumers:

- a **playback impact tracker**, which marks desired block/target payloads
  dirty; and
- a **playback scheduler**, which prepares payloads only for explicit live
  application, transport start, look-ahead, target recovery, or operator
  resend.

Persistence, collaboration broadcasts, and editor revision handling continue
to observe all score changes. Saving must remain reliable even when every RNBO
target is offline.

### 2. Compute mutation impact centrally

Each accepted store mutation should produce a normalized impact descriptor.
Do not make each browser guess which players or clients are affected.

Suggested shape:

```json
{
  "scoreRevision": 11074,
  "resource": { "type": "clip", "id": "clip-bass" },
  "blockIds": ["B", "D"],
  "voiceIdsByBlock": {
    "B": ["player-2"],
    "D": ["player-1", "player-2"]
  },
  "timingChanged": false,
  "routingChanged": false,
  "invalidateAll": false
}
```

Dependency rules:

| Mutation | Playback impact |
| --- | --- |
| Clip notes/attributes | Every block/voice slot referencing that clip. Duration, playback type, scale behavior, or timing context may change the compiled hash even if notes do not. |
| Block player assignment | Changed voice slots in that block; clear the old target's desired state and prepare the new target when needed. |
| Block duration, scale, or timing | All assigned playback targets in that block. |
| TTID | TTID-capable runtime roles for that block; RNBO note targets only if the compiled note interpretation depends on TTID. |
| Macro order or repetition | Look-ahead schedule only unless block compilation inputs also changed. |
| Global context/grid/timing | All dependent blocks and targets. |
| Player-to-client routing | Old and new target for that player, across referenced blocks. |
| Target discovery/reconnection | Only the missing/reconnected target's required active or upcoming block. |
| Restore, new score, initialization, destructive reset | Invalidate all desired/prepared/active assumptions and require an explicit safe re-establishment path. |
| OSC clip or layer | OSC recall state only; do not enqueue an RNBO note-table transfer unless a declared dependency exists. |

Restore accepts only the current schema. An incompatible saved score fails
before mutating canonical or playback state; it does not enter a migration or
best-effort compatibility path.

### 3. Track hashes, not only global revisions

Maintain state keyed by block and playback target:

```text
(blockId, targetId) -> {
  voiceId,
  desiredScoreRevision,
  desiredHash,
  preparedTransaction,
  preparedHash,
  activeTransaction,
  activeHash,
  state,
  lastError
}
```

Global `scoreRevision` remains the concurrency guard for canonical writes, but
it is too broad to decide whether one client is dirty. An unrelated edit may
advance the score revision without changing that target's compiled payload.
The payload hash is the playback-difference witness.

Cache compilation by the smallest safe dependency fingerprint, including at
least block ID, target/voice identity, effective clip data, timing contract,
block scale behavior, and transport fields written with the transaction.

### 4. Select dirty targets before sending

For routine preparation:

1. Resolve the block's player-to-target assignments.
2. Limit the candidate set using the mutation impact index.
3. Compile or fetch cached desired payloads for those candidates.
4. Drop candidates whose desired hash already matches prepared or active.
5. Send a complete compact replacement only to the remaining targets.
6. Require READY from every required target before arming activation.

Do not introduce note-level network deltas. A note delta would require a much
larger protocol for ordering, deletion, retry, replay, and recovery. Compact
whole-target replacement is already bounded, deterministic, and validated.

If the same clip feeds multiple players or blocks, all genuinely affected
target payloads remain dirty. “Only dirty targets” must never mean “only the
editor's focused player.”

### 5. Add a continuing-playback activation command

The current prepared activation path is designed for block starts: `SetStage 0`
followed by `Clock 1`. Reusing it for live editing would restart the block.

Extend the RNBO client contract with an explicit prepared-table activation
request containing at least:

```text
transactionId
activationMode = continue
boundary = next-beat
```

On the selected shared beat, the client must:

1. verify that the requested transaction is still prepared;
2. atomically swap staging into active;
3. preserve the running stage/phase rather than jumping to zero;
4. reconcile notes already sounding under the old table according to a tested
   policy; and
5. emit ACTIVE with the transaction ID and activation stage.

The note-lifecycle policy must be explicit before rollout. The safe first
policy is to terminate notes owned by the old table at the swap boundary, then
let the new table generate events from that boundary forward. A more seamless
carry policy can follow only if the client can prove note identity and prevent
stuck or duplicate notes.

Use Finch as the canary for this protocol extension before enabling the author
control across the fleet. Once validated, deploy the same required contract to
the complete fleet and remove the superseded activation path rather than
maintaining parallel protocol versions.

### 6. Add application APIs and shared status

Proposed API surface:

```text
GET  /playback/updates
POST /playback/updates/apply-next-beat
POST /playback/updates/update-now
```

Example apply request:

```json
{
  "blockId": "B",
  "expectedScoreRevision": 11074
}
```

The server resolves required targets from canonical assignments and dirty
hashes. Target selection should not be exposed in the normal author control,
because applying only part of a composed player group can break ensemble
integrity. Target-limited operations may remain under Admin for diagnosis.

Expose the same state through `/playback/snapshot` and events so all editors
render one truth:

```json
{
  "blockId": "B",
  "scoreRevision": 11074,
  "state": "saved-not-active",
  "affectedTargetCount": 1,
  "preparedTargetCount": 0,
  "activeTargetCount": 0,
  "requestedBeat": null,
  "scheduledBeat": null,
  "targets": {}
}
```

Suggested event names:

```text
playback.update.desired
playback.update.preparing
playback.update.ready
playback.update.armed
playback.update.active
playback.update.failed
playback.update.superseded
```

### 7. Build one shared editor control

Extend the shared ShadowScore browser state rather than implementing status and
buttons independently in every editor.

The shared component should show:

- canonical save state for the focused resource;
- playing block and whether the focused edit affects it;
- affected player/client count;
- Prepared/Armed/Active progress;
- a single `Apply next beat` or `Update players now` action; and
- per-target details behind disclosure when preparation or activation fails.

The normal compact labels are:

```text
Saving…
Saved
Saved · not yet live
Preparing 1 player…
Ready · next beat
Live
Saved · 1 player unavailable
```

Reserve **Unsaved** for a local draft or failed canonical write. Reserve
**Offline**, **Rejected**, and **Missed boundary** for live delivery failures.

## Surface-by-Surface Changes

### Matrix Edit

- Retain its 80 ms autosave queue and in-flight coalescing.
- Stop the generic score listener from preparing RNBO data after each autosave.
- Add the shared application status near transport/playback context.
- Preserve explicit confirmations for destructive Quantize and whole-score
  regrid operations.
- Keep TTID selection autosaved; distinguish saved TTID from direct audition.
- Keep ShadowScore mode free of a redundant Sync/Save button.

### Piano Roll

- Autosave at the end of pointer/keyboard gestures with a short quiet window.
- Keep per-clip draft snapshots, Revert, stale detection, and conflict recovery;
  autosave changes when the draft is committed, not whether recovery exists.
- Replace **Save** and the current Saved/Unsaved badge with canonical save state
  plus the shared playback state.
- Coalesce drag motion into one canonical write after the gesture instead of
  writing every pointer move.
- Preserve dirty drafts across clip/block navigation if a save is pending or
  rejected.

### Event List

- Autosave a validated row after blur/Enter and coalesce related field edits.
- Autosave add/delete actions as complete clip replacements.
- Keep explicit confirmation for pasted-array replace, destructive bulk
  operations, and conflict resolution.
- Merge note and attribute save status into the shared canonical state.

### Structure Editor

- Autosave a valid block assignment document and song form after a quiet
  window; do not submit intermediate invalid structures.
- Retain Revert/undo for author control.
- Keep Cue Section, Next Section, Return to Start, Play, and Stop as explicit
  performance actions.
- A playing-block assignment/timing change should enable `Apply next beat`.
- A song-form-only ordering change should update look-ahead scheduling without
  retransmitting unchanged block payloads.

### Admin and initialization

- Keep named score-library snapshots explicit; consider **Save score copy** to
  avoid collision with autosave terminology.
- Keep restore/new/reset/initialize confirmation and treat the result as a
  full playback invalidation.
- Keep **Resend RNBO score** as an operator recovery command that can bypass
  hashes and reach every required target.
- Show clearly that a recovery resend has Prepared data but has not necessarily
  made it Active.

### OSC editors

- Preserve the existing distinction between **Write State** and **Recall Now**.
- Do not put the RNBO note-table `Apply next beat` button inside every
  instrument-specific live-routing panel.
- If an OSC snapshot change affects the playing block, use that subsystem's
  beat-aware recall/transaction contract and expose comparable Saved/Live
  status through the shared playback snapshot.

## Failure and Concurrency Rules

- Autosave must use the existing expected score/structure revisions.
- A stale write remains a canonical conflict, not a live-delivery failure.
- Applying always snapshots the latest accepted canonical revision. If a newer
  relevant edit arrives during preparation, mark the older request superseded
  and prepare the new desired hash.
- Never report ensemble-wide Live if only some required targets returned
  ACTIVE.
- An offline target remains dirty and visible. Reconnection prepares only that
  target's required block.
- A manual full-clear resend remains available when hashes or client state are
  not trustworthy.
- Reloading an editor must reconstruct status from server state; no browser may
  be the owner of a pending application.

## Implementation Phases

### Phase 1: Impact and observability

- Define and validate the single current score and playback-state schemas.
- Add normalized mutation-impact generation and dependency tests.
- Add desired/prepared/active hash state keyed by block and target.
- Extend `/playback/snapshot`, `/rnbo/targets`, and Admin diagnostics.
- Measure current target enumeration, compile counts, reused payloads, actual
  transmissions, READY latency, and ACTIVE latency.

Exit criterion: for any score mutation, tests and diagnostics identify exactly
which block/target payloads changed without altering current live behavior.

### Phase 2: Selective preparation

- Introduce compile caching and dirty-target selection.
- Preserve compact whole-target replacement and READY validation.
- Reprepare an upcoming block when a relevant saved edit supersedes its
  prepared hash.
- Add full-invalidation handling for restore/new/reset/initialize.

Exit criterion: a one-player clip edit compiles and transmits only affected
target payloads; unchanged targets record reuse/no-op, and a shared clip still
updates every dependent target.

### Phase 3: Continuing next-beat activation

- Implement and test the RNBO continue-mode activation contract.
- Prove stage preservation, atomic swap, note-off safety, ACTIVE readback, and
  missed-boundary behavior on Finch.
- Add `apply-next-beat` and `update-now` server operations.
- Roll through Wren, Heron, and Raven only after canary acceptance.
- Remove the superseded activation behavior after fleet cutover; do not retain
  a compatibility branch.

Exit criterion: a playing-block edit becomes audible at the first safe shared
beat without restarting the block, producing stuck notes, or activating a
partial table.

### Phase 4: Shared UI and Matrix Edit

- Add the shared save/application status component.
- Integrate Matrix Edit source first, test it, commit it, then export the clean
  bundle into ShadowscoreServer with verified provenance.
- Validate autosave, superseding edits, target failure, stopped update, and
  next-beat application.

Exit criterion: Matrix Edit visibly distinguishes Saved, Prepared, and Active,
and the author can apply the playing block on the next safe beat.

### Phase 5: Piano Roll, Event List, and Structure Editor

- Convert ordinary edits to gesture-end/blur/quiet-window autosave.
- Retain drafts, Revert, confirmations, and stale-write handling.
- Remove or rename Save controls that no longer represent canonical
  persistence accurately.
- Reuse the shared application component and state.

Exit criterion: the same edit produces the same save/live semantics on all
three surfaces, including navigation and conflict cases.

### Phase 6: Admin, OSC semantics, and live fleet acceptance

- Clarify score-library, restore, reset, resend, Write State, Recall, and
  Audition labels.
- Audit every score mutation event against the impact table.
- Run live four-bird tests with one dirty player, multiple dirty players,
  shared clips, an offline target, rapid edits, and missed preparation.
- Update the operator guide after the workflow is proven.

Exit criterion: no UI uses Save to imply client activation, no routine edit
resends clean targets, and operator recovery remains available and truthful.

## Verification Matrix

Automated coverage must include:

- rapid Matrix gestures coalesce to the latest canonical score revision;
- Piano Roll drag autosaves once at gesture end;
- Event List and Structure edits retain conflict guards;
- inactive unreferenced clip edits cause zero RNBO transmission;
- active one-player edits affect only that player's target payload;
- shared-clip edits affect every referencing player;
- block timing changes affect every target in that block;
- macro-order-only changes replan look-ahead without note-table transfer;
- identical hashes are reused;
- a superseded preparation cannot become Active;
- Apply waits for every required READY;
- continue-mode activation preserves stage and returns matching ACTIVE;
- missed boundaries and offline targets do not produce false Live state;
- stopped updates activate at stage zero;
- restore/new/reset invalidate all prior prepared/active assumptions;
- incompatible saved files are rejected without migration or partial state
  mutation;
- admin recovery can still force a complete resend.

Live acceptance on the four-bird rig must prove, from both server state and
client readback:

- the exact affected target set;
- transmitted row counts;
- desired, prepared, and active hashes/transactions;
- boundary and activation stage;
- no stuck or duplicate MIDI notes; and
- no phase reset for continue-mode application.

## Decisions Captured

- Canonical saving becomes automatic for ordinary authoring edits.
- Artistically timed playback application remains explicit.
- The primary live action is **Apply next beat** while running and **Update
  players now** while stopped.
- Data integrity continues to rely on complete compact target replacement,
  READY validation, and atomic activation.
- Efficiency comes from dependency-aware dirty target selection, compilation
  caching, coalescing, and payload-hash reuse—not note-level edit deltas.
- The server, not an individual editor, owns desired/prepared/active state and
  boundary scheduling.
- The implementation uses one current data schema and one current client
  protocol. Legacy files and mixed-protocol fleets are intentionally
  unsupported.
