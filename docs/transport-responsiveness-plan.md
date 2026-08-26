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

A repeatable acceptance harness is now available as `npm run
measure:transport -- --runs 5`. It refuses to interrupt existing playback,
captures the authoritative transition and direct-verification evidence for each
Play, and guarantees a Stop attempt plus stopped-state check between runs.

The first five-run, seven-client sample passed 5/5. Every run had seven clock
ACKs, seven phase ACKs, direct phase verification, zero phase skew, and no
automatic recovery attempt; Raven matched the other targets on every run. Play
latency was 3.234/3.329/4.982 seconds minimum/median/maximum. Configuration was
stable at 0.972/1.009/1.069 seconds. The slow tail was instead phase
verification: four runs took 0.698-0.885 seconds there, while the 4.982-second
run spent 2.407 seconds verifying. The prior Raven miss was not reproduced,
but five runs are evidence of current health rather than proof that the
intermittent case is gone. Preserve the verification barrier and use larger
samples to isolate that tail before changing the start contract.

Verification diagnostics now retain every polling attempt, per-client read
latency and error, projected stages, offsets, ACK attempt history, and granular
coordinated-start step timings. One failed read still invalidates that entire
attempt, every expected target remains mandatory, and retry and timeout policy
is unchanged. The beat-arm wait is now presented as `synchronizing` rather than
`verifying`, matching what the server is actually doing during that inherent
wait.

Twenty additional seven-client starts passed 20/20 with zero final skew. In a
ten-run direct-read sample, normal final verification took 45-81 milliseconds.
One run initially observed Heron instance 13 and Finch instance 22 one stage
ahead; all seven aligned on the next 100-millisecond poll without a corrective
write. Raven was aligned in both attempts. In the ACK sample, all phase ACKs
passed on their first read and four of five clock-start ACK sets did likewise;
one local Wren instance needed one retry.

The final granular sample passed 5/5. Seven-client correction and phase-reset
write fan-outs each cost roughly 120-160 milliseconds, ACK and final direct
reads were generally 45-116 milliseconds, and the deliberate beat-arm window
varied from 0 to 558 milliseconds. Configuration remained near 1 second. The
first start after a server restart also paid a one-time 952-millisecond
discovery plus 620-millisecond preparation cost, while subsequent discovery and
preparation totaled 213-470 milliseconds. These measurements move the next
safe performance investigation toward unchanged configuration writes and the
pre-verification synchronization fan-outs. They do not support weakening ACK,
phase, or direct-read barriers.

An attempted ACTIVE-only timing-write optimization was rejected during live
acceptance. The experiment skipped `MaxSteps` and `ClockInterval` only when
every participating target reported an exact receiver-confirmed ACTIVE hash,
since those values are included in the hashed payload. On the second repeated
start, both Heron instances remained exactly one stage ahead of the other five
clients for all 32 direct-read attempts across the five-second timeout. The
server failed closed and stopped playback as designed. The experimental change
was immediately removed and never committed. Restoring the full timing writes
then passed 5/5 starts with every target at zero offset. Treat those writes as
part of the effective synchronization and settling sequence until the RNBO
client exposes a stronger transactional timing-activation contract; ACTIVE hash
equality alone is not sufficient grounds to omit them.

### Slice 4: client-side transactional start

Extend the RNBO client with an operation-identified start arm, shared musical
boundary/deadline, armed acknowledgement, activation acknowledgement, and
cancel/reconciliation behavior. This is the path to removing server round trips
without exchanging reliability for speed.

The client canary now implements a fixed seven-integer `TransportStart` request
with operation-matched ARM, ACTIVATE, and CANCEL commands and distinct ARMED,
ACTIVE, CANCELED, and REJECTED acknowledgements. ACTIVE is emitted only after
the first resulting playback stage is witnessed. A post-ACTIVE CANCEL remains
valid and idempotent, while a delayed ACTIVATE cannot revive the canceled
operation.

Discovery reports `transactionalTransportStart: true` only when both the live
`TransportStart` inport and `transport_start_ack` outport exist in the same
running export; advertised configuration, or either surface by itself, is
insufficient. The server selects the transactional path only when every frozen
participating target exposes that complete surface plus the existing phase
reset acknowledgement contract. Mixed and older fleets retain the proven
legacy coordinated-start sequence unchanged.

The four-bird canary established two required safe JACK beat windows. Sending
phase reset or ACTIVATE at arbitrary points in a beat reproducibly split first
stage witnesses between 20 and 21. Sending each command near the beginning of a
fresh JACK beat gave every client almost one full beat to arm, and Wren, Raven,
Finch, and Heron all acknowledged ACTIVE at stage 20. The server sequence is
therefore: ensure JACK rolling; phase reset in a safe window and verify every
phase ACK; schedule any prepared score activation; ARM every client and wait
for the full ARMED barrier; ACTIVATE in a second safe window; then require every
ACTIVE acknowledgement to match both operation ID and first stage. Any reject,
timeout, cohort mismatch, or stage mismatch sends CANCEL to the full
transactional cohort and invokes the existing stop/JACK rollback.

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
