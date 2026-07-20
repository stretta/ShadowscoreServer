# Phase-Aligned RNBO Playback and Editor State Plan

## Implementation Status

As of 2026-07-20:

- Checkpoint 1 server support is implemented: score transactions now expose a
  stable payload hash, row counts, send/ACK timestamps, preparation duration,
  active transaction metadata, and bounded `prepare_started`,
  `prepare_completed`, and `prepare_failed` lifecycle events. Live Finch and
  four-bird acceptance have passed.
- Checkpoint 1's coherent `GET /playback/snapshot` contract is implemented with
  monotonically increasing generations, an authoritative JACK position,
  per-target execution witnesses, phase error, readiness/send data, and timing
  contracts collected from one request cycle.
- A host-owned RNBO stage collector now polls local and peer
  `currentStagePath` OSCQuery endpoints concurrently, caches timestamps and
  errors, prevents overlapping cycles, and supplies freshness-qualified client
  witnesses to the shared snapshot.
- Unified transport startup now sends `SetStage 0` before `Clock 1`. The stage
  write establishes the independent start position; the clock write arms each
  client to begin on its next synchronized beat.
- Shadowscore supplies the score tempo to JACK. RNBO observes the same tempo
  domain through Link, so unified startup does not send a competing RNBO
  `Tempo` control before arming clients.
- Transport and Piano Roll now consume only the shared snapshot for playback
  refreshes, prevent overlapping polls, reject regressing generations, and
  chase the authoritative playhead. Piano Roll keeps client stage calculation
  separate for a future diagnostic overlay.
- The Matrix, Piano Roll, and Transport views now consume server-owned
  playback state; browsers no longer construct peer stage-readback URLs.
- The staging contract is mandatory across Finch, Heron, Raven, and Wren.
  Every client validates prepare-only data into a separate bank, emits opcode
  `92` READY, swaps banks on the next-beat start boundary, and emits opcode
  `93` ACTIVE. The opcode `90` compatibility path has been removed.
- Unified Play snapshots each target's prepared transaction between
  `SetStage 0` and `Clock 1`, polls its existing ACK readback after arming the clock, and
  promotes the prepared transaction only after a matching opcode `93` ACTIVE.
  The shared snapshot exposes the activation ACK and bounded lifecycle events
  report `activation_scheduled`, `activation_completed`, or
  `activation_missed`. Live server-to-Finch activation validation is complete.
- Repeated Block A canary testing completed three consecutive starts with
  matching Finch ACTIVE acknowledgements at stage zero. All four players had
  their complete note payloads and were aligned exactly in two runs and within
  one stage in the third.
- Identical staged payloads are now reusable. Automatic score/playhead updates
  preserve an already active or prepared staged transaction instead of
  retransmitting the same note table. Manual, discovery, and forced full-clear
  sends still bypass reuse so recovery remains explicit.
- JACK-derived macro playback now opens a 12-beat look-ahead window and asks
  the RNBO adapter to prepare the next macro block on every playback target.
  The macro snapshot reports pending and last look-ahead results.
- Once look-ahead preparation is READY, automatic playback stages every target
  during the final pre-boundary beat, then fans out `Clock 1` concurrently. It
  reconciles opcode `93` ACTIVE and no longer resets clients reactively after
  the macro playhead has crossed the boundary.
- Live Block A-to-B validation passed on 2026-07-20: Finch prepared transaction
  `1005` 12 beats ahead, was armed in the final beat, and returned opcode `93`
  ACTIVE for transaction `1005` at stage zero before the server reported the
  B playhead. The earlier reactive-path `activation_missed` result did not
  recur.
- Live deployment also exposed an independent Wren shutdown stall when the
  port-3000 graph editor held `/transport/events` open. Shutdown now closes
  long-lived collaboration/SSE/HTTP connections before persistence flush, so
  editor use cannot hold systemd in `stop-sigterm` until its kill timeout.
- The fleet contract is now a clean break: every ShadowScore playback target
  is normalized to compact double-buffer replacement with 819 rows per bank,
  16384 note floats, READY/ACTIVE staging, and no opcode-90 compatibility path.
- Transport control writes now fan out concurrently across targets. Automatic
  boundary arming completes all independent `SetStage` writes before issuing
  the `Clock 1` start writes concurrently.
- Live four-player Block A validation passed on 2026-07-20. Transaction `1004`
  activated on Finch (158 notes), Heron (186), Raven (127), and Wren (211).
  Sixteen corrected peer-readback samples had a one-stage median raw spread;
  the final time-normalized spread was 0.0575 beat, below one 1/16-beat stage.
  The earlier stable multi-beat offsets did not recur.
- The coherent snapshot boundary is timestamped after concurrent peer polling,
  so each execution witness retains its real observation age. This prevents
  later peer responses from being clamped to a misleading zero-age readback.
- Phase 6 ordered UDP bursts are live on Wren with `sendBatchSize: 4` and the
  existing 5 ms inter-burst delay. A fresh Block A fleet resend completed in
  1.37 seconds; individual READY durations were 0.84 to 0.97 seconds with exact
  row counts and no retries. A subsequent four-client activation retained a
  0.052-beat median normalized phase spread.

## Objective

Ensure that:

- every RNBO client has its score data before playback begins;
- table activation and stage reset occur on the correct JACK boundary;
- Matrix, Piano Roll, Transport, and Chase display one coherent playback
  position; and
- dense material such as Finch's block D produces MIDI from the beginning of
  the block.

## Current Evidence

Live testing on `wren.local` established several distinct problems:

- The historical dense block-D fixture compiled to 392 Finch rows, but the live
  score has since changed and Block D is empty. Block A is the current canary:
  Finch transmits 158 rows, Heron 186, Raven 127, and Wren 211.
- Before ordered bursts, current Block A preparation took 2.99 to 4.54 seconds
  across the fleet. That was too slow for a narrow activation look-ahead.
- The clients can agree with one another while remaining several beats behind
  the JACK-derived server position.
- Matrix can poll a peer instance number through wren's OSCQuery address rather
  than through the peer host, making an unrelated wren instance appear to be
  the selected player's stage witness.
- Matrix, Piano Roll, and Transport poll independently. Their endpoint latency
  can exceed their polling interval, allowing overlapping requests and stale
  responses to produce visibly different positions.

These are related symptoms, but they require separate corrections to score
delivery, phase activation, and editor observation.

## Core Architecture

The implementation should preserve four invariants:

1. Score transfer never determines playback phase.
2. A client continues using its active table while another table is prepared.
3. Prepared tables activate only on an explicit JACK boundary.
4. Every editor consumes the same versioned playback snapshot.

Editors should distinguish between two positions:

- **Authoritative playhead:** the score position derived from JACK.
- **Execution witness:** an individual client's reported `current_stage`.

Chase should follow the authoritative playhead by default. Client stages should
appear as diagnostic overlays rather than independently driving editor
position.

## Phase 1: Instrument the Existing System

Make the discrepancies measurable without changing playback behavior.

### Server measurements

Record the following for each transaction and target:

- block ID and payload revision;
- compiled row count and payload hash;
- send start and finish times;
- acknowledgement time and validation result;
- total preparation duration;
- active, prepared, and queued transaction IDs;
- client `current_stage` and derived beat;
- JACK block beat;
- phase error in beats and stages; and
- observation timestamp and age.

Add structured events for:

```text
prepare_started
prepare_completed
prepare_failed
activation_scheduled
activation_completed
activation_missed
phase_error
```

### Phase 1 acceptance gate

A Block A fleet run must clearly report:

- the expected 158, 186, 127, and 211 rows;
- transfer duration;
- acknowledgement result;
- server and Finch beat positions; and
- phase error at the beginning and end of the block.

## Phase 2: Add a Coherent Playback Snapshot

Introduce one server-owned endpoint, provisionally:

```text
GET /playback/snapshot
```

The response should be an atomic, versioned observation:

```json
{
  "generation": 1842,
  "observedAt": "2026-07-20T13:07:42.125Z",
  "transport": {
    "authority": "jack",
    "running": true,
    "tempo": 100,
    "macroIndex": 7,
    "blockId": "D",
    "beatIntoBlock": 40.25
  },
  "targets": {
    "finch": {
      "online": true,
      "currentStage": 644,
      "stagesPerBeat": 16,
      "beatIntoBlock": 40.25,
      "phaseErrorBeats": 0,
      "activeTransaction": 1103,
      "preparedTransaction": 1104,
      "payloadRevision": "example-revision",
      "stateAgeMs": 73
    }
  }
}
```

### Collection model

- ShadowscoreServer polls or receives state from every client.
- Browsers no longer contact peer OSCQuery hosts directly.
- Each snapshot receives a monotonically increasing generation.
- All fields come from one server-side observation cycle.
- Stale target observations are explicitly marked.

Start with server-side polling and caching. Add Server-Sent Events or WebSocket
delivery only after the data contract is stable.

### Phase 2 acceptance gate

Repeated snapshots must never regress in generation or combine block metadata
from requests observed at substantially different times.

## Phase 3: Correct Editor Playback Behavior

### Matrix

- Remove construction of peer stage URLs using wren's host and port.
- Consume the server playback snapshot.
- Base `Wiper tracking` on the selected player having a fresh stage witness.
- Chase the authoritative JACK playhead.
- Draw the selected client's execution stage as a separate marker.
- Show phase error when it exceeds a configurable threshold.

### Piano Roll

- Replace independent playback and target requests with the snapshot request.
- Prevent overlapping refreshes.
- Ignore responses older than the last applied generation.
- Chase the authoritative playhead.
- Optionally display client execution witnesses.

### Transport

- Consume the same snapshot.
- Remove overlapping refresh cycles.
- Display snapshot freshness and target readiness.
- Clearly identify JACK as the phase authority.

### Request safety

Until push delivery is implemented:

- allow only one request in flight per view;
- abort superseded requests when practical;
- apply responses only if their generation is newer; and
- use a refresh interval consistent with measured endpoint latency.

### Phase 3 acceptance gate

With Matrix, Piano Roll, and Transport open simultaneously:

- all report the same macro index, block, and JACK beat;
- chase positions differ by no more than one rendering frame;
- a delayed HTTP response cannot move any display backward; and
- selecting Finch shows Finch's witness separately from the score cursor.

## Phase 4: Introduce Staged Score Preparation

Extend the client protocol from immediate replacement to double-buffered
preparation.

### Proposed lifecycle

```text
PREPARE_BEGIN
    -> NOTE or batched note data
    -> PREPARE_END
    -> READY_ACK
    -> ACTIVATE_AT_BOUNDARY
    -> ACTIVE_ACK
```

### Capability-gated wire contract

Legacy clients continue receiving transaction flags `0` and return the
existing opcode `90` committed ACK. A client that advertises
`stagedScoreActivation: true` receives `PREPARE_ONLY` bit `1` in the existing
`BEGIN_REPLACE` flags field. For that transaction:

- `BEGIN_REPLACE` and `NOTE` write only the staging table;
- `COMMIT` validates staging without replacing the active table;
- successful validation emits opcode `92` (`READY`) with the transaction ID
  and final success flag `1`;
- the server exposes that ID as `preparedTransaction` while retaining the
  previous `activeTransaction`; and
- a legacy opcode `90` response is rejected as an opcode mismatch.

The Finch canary implements the activation ACK emitted when the prepared table
becomes active on the next-beat `Clock 1` start. Legacy clients do not emit or
participate in this readback.

### RNBO client changes

Maintain separate state for:

```text
activeTable
stagingTable
activeTransaction
preparedTransaction
```

`PREPARE_END` must validate:

- transaction ID;
- expected row count;
- received row count;
- payload checksum; and
- block and revision identity.

A successful `READY_ACK` means only that the table is ready. It must not change
playback.

### Server changes

- Compile upcoming blocks in advance.
- Begin preparation before the active block ends.
- Maintain at least one prepared block per client.
- Measure rolling preparation duration per target.
- Schedule preparation using measured worst-case duration plus a safety margin.
- Do not repeatedly transfer identical payload hashes.

If two consecutive macro entries use identical content, reuse the prepared or
active payload. Send only the boundary activation information instead of
retransmitting the note table.

### Phase 4 acceptance gate

Finch must report the complete D transaction as prepared and validated before
the D boundary.

## Phase 5: Add Beat-Scheduled Activation

Stage selection and clock start remain independent client operations. Their
ordering is the synchronization contract:

1. prepare and validate the score on every client;
2. reassert the Shadowscore tempo to JACK and start JACK;
3. send `SetStage 0` to every ready client;
4. send `Clock 1` to every ready client during the same pre-boundary beat; and
5. let each client begin on its next synchronized beat.

The server must never send `Clock 1` before `SetStage 0`, and must not send a
reactive stage reset after the clients have armed.

### Preferred contract

The server prepares the client ahead of time with:

```text
transactionId
targetBlockId
initialStage
```

After preparation succeeds, the server sends `SetStage 0` and then `Clock 1`.
At the next synchronized beat, the client:

1. swaps staging into active;
2. begins playback from the previously selected stage; and
3. sends `ACTIVE_ACK`.

The existing client behavior in which `Clock 1` waits for the next beat is the
required synchronization primitive. Do not add a competing client-side
absolute-JACK scheduler, and do not send `SetStage 0` reactively after the
server observes a transition.

### Missed-deadline policy

Never activate a late transaction halfway through a block. If a client is not
prepared:

- suppress its score output;
- report `activation_missed`;
- keep it muted until the next valid quantized activation; and
- do not let an old table play against the new block.

### Phase 5 acceptance gate

Across all four clients:

- activation occurs within one stage, or `1/16` beat, of the JACK boundary;
- no client performs a late mid-block reset; and
- phase error remains within the agreed tolerance for the full block.

## Phase 6: Improve Transfer Throughput

Once validation is available, optimize the transport using Finch as the
canary.

Candidate improvements include:

- batching multiple note rows into one message;
- using OSC bundles where supported;
- experimentally reducing the fixed 5 ms pacing delay;
- adapting pacing to measured client capacity;
- coalescing duplicate playhead-triggered requests;
- cancelling queued transfers superseded by a newer revision;
- caching compiled payloads by block and revision; and
- skipping transmission when the client already has the required hash.

Test every pacing or batching change for:

- missing or out-of-order rows;
- acknowledgement mismatches;
- CPU load;
- network errors; and
- MIDI output correctness.

### Phase 6 acceptance gate

Every populated Block A target should prepare comfortably inside the look-ahead
window, preferably in under three seconds, with exact row-count validation and
without retries.

## Phase 7: Live Rollout

Roll out incrementally:

1. Deploy instrumentation and the snapshot endpoint to wren.
2. Update Transport to use the snapshot.
3. Update Piano Roll and Matrix.
4. Deploy double buffering to all four birds.
5. Test populated Block A repeatedly across the fleet.
6. Enable scheduled activation on the fleet.
7. Validate Block A note counts and phase alignment across Finch, Heron, Raven,
   and Wren.
8. Remove the old post-boundary full-transfer and opcode-90 paths.

These rollout steps are complete. Staging is now a mandatory client contract;
there is no temporary legacy capability flag.

## Test Strategy

### Unit tests

- Snapshot generation ordering
- Phase-error calculation
- Payload hash and row-count validation
- Same-payload deduplication
- Preparation deadline calculation
- Missed-activation behavior

### Integration tests

Simulate:

- a slow target;
- lost or delayed note messages;
- a delayed acknowledgement;
- client reconnection during preparation;
- a superseded transaction;
- consecutive identical blocks;
- HTTP responses arriving out of order; and
- client stage drift.

### Live fleet tests

For populated Block A, verify:

- all target-specific rows are received and validated;
- `READY_ACK` precedes the boundary;
- `ACTIVE_ACK` follows the scheduled boundary;
- the first expected notes occur near stage zero;
- MIDI debug activity matches compiled event density;
- phase error remains within one stage; and
- every editor shows the same authoritative playhead.

## Implementation Checkpoints

Land and verify each checkpoint independently:

1. Playback observability and snapshot contract
2. Editor snapshot migration and Chase correction
3. Validated client staging buffer
4. Look-ahead preparation and payload deduplication
5. JACK-boundary activation
6. Finch throughput tuning
7. Fleet rollout and removal of the legacy path

Lowering the MIDI send delay alone may improve symptoms, but it does not fix
late commits or inconsistent observations. The durable fix is staged look-ahead
delivery, atomic beat-aligned activation, and a shared playback snapshot.
