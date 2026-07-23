# Smooth Editor Wiper and Playback Observation Plan

## Goal

Make the Matrix Edit and Piano Roll playback wipers appear display-rate smooth
without increasing the existing playback snapshot or RNBO stage sampling rates.
The browser should freewheel visually from an authoritative beat, tempo, and
observation time, then use later observations as correction points.

This work also consolidates playback observation so browser count does not
multiply direct RNBO client polling and both editors render the same musical
position.

## Status

Phases 1 through 5 are implemented as of 2026-07-22. Piano Roll and Matrix Edit
both freewheel lightweight wiper overlays from coherent playback snapshots,
while Matrix Edit retains client stages as secondary execution diagnostics and
no longer polls RNBO clients directly from the browser. The server stage
collector now supplies cached, timestamped periodic observations to snapshot
consumers, performing an immediate read only for a newly observed target (or
when periodic polling is explicitly disabled).

The implementation was deployed to `wren` and the perceived wiper smoothness
was confirmed live on 2026-07-22. That establishes the primary Phase 6
acceptance result without changing snapshot cadence. The wider scenario matrix
below remains available for regression testing; block advancement was not
evaluated in this pass because ShadowScore playback was stopped even though
JACK remained rolling as a clock source.

## Non-goals

- Do not increase `/playback/snapshot`, JACK, or RNBO client polling rates to
  achieve visual smoothness.
- Do not make browser interpolation authoritative for playback.
- Do not hide meaningful seeks, block changes, transport changes, or stale
  observations behind animation.
- Do not couple display animation to note-grid or matrix rerendering.

## Phase 1: Shared browser-side wiper estimator

Create a UI-independent estimator whose inputs are the authoritative beat,
tempo, transport state, active block, observation time, and receipt time.

The estimator must:

- freewheel only while transport is running;
- calculate from the latest absolute anchor rather than accumulating frame
  deltas;
- re-anchor on every accepted observation;
- ease small corrections and snap large discontinuities;
- snap on block, seek, start, and stop changes;
- stop advancing when transport stops;
- freeze after observations become stale; and
- expose deterministic behavior through a controllable clock.

Add unit coverage for normal progression, small correction, large correction,
tempo change, stopping, block change, and stale data.

## Phase 2: Piano Roll display-rate overlay

Piano Roll already consumes `/playback/snapshot`, so integrate it first.

- Feed each accepted snapshot to the shared estimator.
- Move the wiper out of the note and velocity canvas paint passes.
- Render lightweight, pointer-transparent overlays with
  `requestAnimationFrame`.
- Leave the 250 ms snapshot interval unchanged.
- Preserve playing-block/editing-block visibility rules.
- Re-anchor cleanly after resizing or returning to a backgrounded tab.

Acceptance criteria:

- the wiper moves at the display refresh rate during normal playback;
- notes, grids, and velocity bars are not repainted per animation frame;
- stop, seek, tempo, and block changes remain correct;
- stale observations freeze rather than drift indefinitely; and
- idle/stopped animation does not run continuously.

## Phase 3: Shared playback observation source

Move Matrix Edit from direct browser-to-RNBO `current_stage` polling to the
server-owned `/playback/snapshot`.

- Use JACK-derived `beatIntoBlock` as the primary musical wiper.
- Retain per-target `currentStage` as an execution witness and diagnostic.
- Remove Matrix Edit's direct port-5678 stage polling.
- Keep the current browser snapshot cadence.
- Preserve the rule that playback on a different block hides the wiper.

Acceptance criteria:

- Matrix Edit and Piano Roll consume the same snapshot contract;
- both show the same authoritative block and beat;
- additional Matrix Edit windows do not add RNBO client polling; and
- client execution diagnostics remain available separately.

## Phase 4: Matrix Edit display-rate overlay

Integrate the shared estimator after Matrix Edit uses the coherent snapshot.

- Render the authoritative wiper in a lightweight layer above the matrix.
- Keep player execution witnesses visually secondary if retained.
- Avoid rebuilding the matrix frame at display frequency.
- Apply the same correction, transport, block, and staleness rules as Piano
  Roll.

Acceptance criteria:

- Matrix Edit and Piano Roll positions agree within one visual frame when they
  show the same block;
- matrix cells do not rerender at animation frequency; and
- execution witnesses cannot be mistaken for the authoritative playhead.

## Phase 5: Server polling ownership

Make the RNBO stage collector the sole periodic owner of client-stage reads.

- Review the forced all-target refresh performed by every
  `/playback/snapshot` request.
- Prefer fresh cached, timestamped collector observations when possible.
- Preserve `observedAt`, `stateAgeMs`, freshness, timing contracts, lifecycle,
  ACK, and send-state fields.
- Coalesce concurrent refreshes and ensure browser count cannot multiply peer
  sampling.
- Keep JACK, RNBO collection, and browser request cadences independently
  configurable.

## Phase 6: Cross-editor validation

Baseline live result: passed on `wren` on 2026-07-22. Perceived wiper motion was
smooth at the existing snapshot rate. Extended edge-case coverage remains a
regression task rather than a blocker for the completed implementation.

Validate both editors together at multiple tempos and under normal network
jitter. Exercise start, stop, seek, tempo change, block boundaries, editing a
non-playing block, stale snapshot delivery, recovery, tab backgrounding, and
multiple simultaneous browser windows.

Tune shared correction thresholds only after live observation. Large musical
discontinuities must remain immediate; smoothing is only for small display
errors between authoritative checkpoints.

## Delivery order

Land narrow, independently testable checkpoints in this order:

1. Shared estimator and tests.
2. Piano Roll overlay integration.
3. Matrix Edit conversion to `/playback/snapshot` in the Matrix Edit source
   repository, followed by a source-first export.
4. Matrix Edit overlay integration and export.
5. Server polling consolidation.
6. Cross-editor live validation.
