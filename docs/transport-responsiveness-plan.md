# Transport Responsiveness Plan

## Goal

Make Play feel immediately acknowledged while preserving the coordinated
multi-client start contract. The interface must distinguish a received Play
request from audible playback, and performance work must be driven by measured
phase timings rather than removing synchronization barriers speculatively.

## User-facing state contract

The authoritative transport exposes these states:

1. `stopped`: no server-owned player transport is running.
2. `starting`: Play was accepted and the server is discovering and preparing
   the participating cohort.
3. `synchronizing`: the frozen cohort is receiving timing and phase commands.
4. `verifying`: required ACKs and direct execution witnesses are being checked.
5. `playing`: the participating cohort passed the start contract.

`starting`, `synchronizing`, and `verifying` are transitional states. They must
never set `is_playing` or imply audible playback. The shared transport bar uses
a restrained amber pulse and short state label while they are active. Reduced
motion preferences disable the pulse without removing the color or text cue.

The initiating browser presents `starting` immediately, before the HTTP request
finishes. Other connected clients learn the same state from the authoritative
transport event stream.

## Reliability invariants

- Freeze the participating target IDs before JACK/timing writes.
- Require the ACK target set to match that frozen cohort exactly.
- Preserve exact prepared transaction, block, revision, payload hash, READY,
  ACTIVE, clock-start ACK, phase ACK, and direct phase verification.
- Keep the post-beat phase-arm window until a client-side transactional start
  protocol replaces it.
- Roll back clocks, JACK, macro playback, and published player state when a
  selected participant fails.
- Keep known-unavailable assignments visible and outside the frozen cohort.

## Implementation slices

### Slice 1: perceived responsiveness and measurement

- Record an authoritative transition with phase, label, start time, elapsed
  time, and completed phase durations.
- Publish the transition in playback and transport snapshots.
- Present immediate local feedback in the shared transport bar.
- Preserve a final timing record for diagnostics after success or failure.

### Slice 2: observability and cohort hardening

- Include serialized activation work in operation-queue status and idle waits.
- Reject a phase-boundary target reread that is not the exact frozen cohort.
- Add regression coverage for transient participant disappearance.

### Slice 3: measured server optimization

Collect live timings across cold/warm starts, tempo and beat phase, unavailable
players, and restart adoption. Optimize only phases proven redundant or safely
parallelizable. Candidate work includes parallel non-dependent configuration
writes and avoiding unchanged timing-control writes when a fresh instance
contract proves they are already live.

Clock Off, SetStage, Clock On, ACK baselines, running correction, beat-window
phase reset, phase ACK, and direct verification remain ordered.

The first measured seven-client restart start spent 1.822 seconds in
configuration while the safe beat-arm wait was only 97 milliseconds. The first
optimization therefore reuses the startup discovery snapshot for configuration
and runs independent timing/pattern and TTID/swing/snapshot setup concurrently.
The phase-boundary cohort reread and every synchronization barrier remain live
and ordered.

Seven-client Wren acceptance reduced the matched restart start from 6.651 to
5.135 seconds (22.8%) and a clean warm start from 4.145 to 3.192 seconds
(23.0%). Both successful optimized runs retained seven start ACKs, seven phase
ACKs, direct phase verification, and zero measured skew.

One intervening warm start correctly failed closed after Raven remained one
stage (0.25 beat) behind through the direct-verification timeout. The rollback
left all clocks and JACK stopped. This was not averaged away: repeated-start
testing must continue to treat occasional client arm misses as a reliability
signal. The same session also showed an automatic sync-recovery attempt starting
while an operator Stop was in flight; preventing that overlap is the next
cohort-control hardening task.

That overlap is now guarded by an operator-Stop epoch. A Stop marks itself in
progress before its first asynchronous clock write, so a new automatic recovery
cannot begin mid-command. Recovery that was already running rechecks the epoch
before Clock On, immediately after Clock On, and before publishing playback; a
superseded recovery rolls back instead of restoring transport after Stop.

Wren acceptance after deployment completed a seven-client verified start in
4.693 seconds with zero skew, followed by Stop in 0.801 seconds. Playback and
JACK were stopped, all seven payloads remained ACTIVE, and the automatic
recovery supervisor retained `lastAttemptAt: null`, confirming it did not begin
work during the operator Stop.

### Slice 4: client-side transactional start

Extend the RNBO client with an operation-identified start arm, shared musical
boundary/deadline, armed acknowledgement, activation acknowledgement, and
cancel/reconciliation behavior. This is the path to removing server round trips
without exchanging reliability for speed.

## Live acceptance matrix

- Warm and cold starts with every assigned bird online.
- One known-offline bird before Play.
- One late registration during startup discovery.
- One selected bird disappearing during preparation, Clock Off, Clock On, and
  verification.
- Starts early and late within a beat at slow, normal, and fast tempos.
- Concurrent look-ahead or an edited active block during Play.
- Server restart with clients moving and with clients stopped.
- Locate, Re-sync, repeated Stop/Play, and arrangement boundary transitions.

For every run capture the frozen cohort, transition phase timings, transaction
IDs, receiver-confirmed READY/ACTIVE, clock and phase ACK sets, direct phase
verification, arm-window delay, degraded assignments, rollback status, and
audible observation.
