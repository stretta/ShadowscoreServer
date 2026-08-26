# Realtime Transaction Architecture Efficiency Plan

## Status

Approved for staged implementation on 2026-08-26. Each phase must preserve the
current fail-closed playback contract: exact participating cohorts, receiver-
confirmed preparation and activation, operation identity, phase acknowledgement,
direct execution witnesses, and rollback on incomplete evidence.

The plan addresses duplicated acquisition and computation around those barriers.
It does not treat the barriers themselves as inefficiency.

## Goals

- Acquire each live runtime fact once and share a versioned snapshot.
- Compile each target payload once per meaningful score and capability revision.
- Derive realtime presentation objects from one coherent playback generation.
- Make playback orchestration truly adapter-neutral before enrolling software
  participants in the production cohort.
- Isolate transport-start compatibility strategies from HTTP route handling.
- Improve RNBO throughput only through an explicit receiver capability contract.

## Non-goals

- Removing READY, ACTIVE, phase, execution, or audibility distinctions.
- Replacing deterministic whole-payload score transactions with edit deltas.
- Changing JACK authority, RNBO message ordering, retry policy, or active fleet
  behavior as part of an optimization shortcut.
- Enrolling realtime software participants in production playback before the
  unified coordinator and live acceptance gates are complete.

## Phase 1: Shared Runtime Inventory

### Problem

One logical runtime read currently fetches and walks the same RNBOOSCQuery tree
separately for playback targets, device metadata, and generic OSC control
targets. Manual-registry views are also awaited sequentially. Participant-topic
refresh and command paths can repeat this work.

### Implementation

1. Add one RNBO runtime-discovery operation that fetches the OSCQuery tree once.
2. Extract playback targets, RNBO devices, and generic control targets from that
   tree without additional network reads.
3. Load independent manual-registry views concurrently.
4. Preserve configured-target fallback, peer projections, error behavior, and
   all public response shapes.
5. Add a fetch-count regression test proving one runtime acquisition performs
   one local OSCQuery fetch.

### Acceptance

- Existing discovery extractors and public routes remain compatible.
- One shared discovery request yields all three local inventory views.
- The complete local test suite passes.
- Wren source parity, focused remote tests, service state, `/healthz`, `/session`,
  `/rnbo/targets`, and hardware smoke pass without changing transport state.

## Phase 2: Reusable Compiled Target Artifacts

Introduce an immutable compiled artifact keyed by score revision, active block,
voice, target capability signature, and compilation options. Reuse it for
desired-state comparison, timing contracts, preparation, retries, and transport
configuration. Bind the adapter transaction ID at delivery time so retries do
not rebuild notes, message rows, or payload hashes.

Checkpoint implementation completed locally on 2026-08-26: a bounded immutable
artifact cache is shared by the RNBO adapter and route runtime; transaction IDs
are bound onto cloned wire rows only at delivery; desired hashes, retries,
timing contracts, clock/pattern reassertion, transport-start planning, and the
continuing-clock arrangement check consume the shared artifacts. Cache compile,
hit, eviction, entry-count, and compile-duration metrics are exposed through
the adapter metrics snapshot.

Acceptance requires compile-count and duration instrumentation plus exact wire-
message parity tests for normal, empty, loop-expanded, legacy-clear, compact,
staged, and resumable transactions.

## Phase 3: Single Coherent Playback Publication

Make the coherent playback generation the shared acquired state. Derive the
authoritative transport topic and HTTP representations from that generation
instead of rebuilding playback independently at 250 ms and 500 ms intervals.
Preserve fresh HTTP semantics by coalescing in-flight work and defining a short,
explicit freshness window.

Checkpoint implementation completed locally on 2026-08-26: playback HTTP and
authoritative transport reads share the same runtime publisher, overlapping
loads are coalesced, and sequential reads reuse a generation for at most 125 ms.
Publisher load/cache/coalescing metrics and a playback acquisition counter make
reuse measurable. Command responses and automatic sync-recovery decisions force
a new shared generation so bounded read caching never weakens fresh-after-write
or fail-closed control semantics. The authoritative transport object exposes
the playback generation from which it was derived.

## Phase 4: Unified Participant Orchestration

Replace the privileged primary-adapter methods plus separate software-participant
methods with one operation that:

1. freezes resolved participant identities;
2. partitions the cohort by adapter;
3. compiles and prepares each partition;
4. records normalized READY state with adapter-specific tokens;
5. activates the exact prepared cohort;
6. requires adapter-appropriate execution evidence; and
7. rolls back or reports degradation according to explicit cohort policy.

RNBO remains the only production adapter until parity and live acceptance are
complete. Software-participant enrollment is a later, explicit checkpoint.

Checkpoint implementation completed locally on 2026-08-26: the participant
coordinator now records one bounded operation ledger for preparation and
activation, freezes each adapter partition and its participant identities,
passes one operation identity through each enrolled adapter, normalizes READY
and ACTIVE evidence, and records rollback outcomes for partial preparation or
activation failure. Existing RNBO prepare/activate entry points delegate through
this operation seam. The WebSocket JSON adapter remains visible in diagnostics
but is excluded from production operations unless its adapter id is explicitly
enrolled when constructing the coordinator; Wren does not enable that option.

## Phase 5: Transport-Start Strategy Drivers

Extract atomic clock arm, transactional transport start, and legacy coordinated
start into strategy drivers with shared `supports`, `plan`, `execute`, `verify`,
`rollback`, and evidence-normalization boundaries. Select a strategy from one
frozen inventory and one compiled timing set.

Compatibility strategies remain available until deployed capability evidence
shows that a path can be retired.

The first Phase 5 checkpoint freezes one exact RNBO participant inventory and
one compiled timing set before selecting atomic clock arm, transactional
transport start, or legacy coordinated start. Atomic and transactional
execution now share normalized ACTIVE/phase evidence and rollback dispatch;
the selected strategy and evidence are returned in transport-start diagnostics.
The second Phase 5 checkpoint routes legacy coordinated execution through that
same driver boundary, including the intentional no-phase-reset variant. Legacy
success now publishes the same normalized ACTIVE/phase evidence shape, and any
failure in its Clock Off, SetStage, Clock On, acknowledgement, correction, or
phase-verification sequence dispatches one centralized playback-stop rollback.

## Phase 6: Capability-Gated RNBO Flow Control

Do not raise UDP batch size speculatively. Define and validate a receiver
capability for bounded batch ingestion, acknowledgement, or credit-based flow.
Use current one-row pacing for clients without that capability. Measure transfer
duration, event-thread backlog, READY latency, retry rate, and first activation
before enabling a faster profile.

## Checkpoint and Deployment Policy

Each phase is a separate reviewed local commit. Before deploying to Wren:

- inspect the scoped diff and current worktree;
- run focused tests and the complete local suite;
- identify Wren and confirm the source-copy target;
- sync only the reviewed checkpoint files with relative paths;
- compare local and remote checksums;
- run relevant remote tests;
- restart only the ShadowscoreServer service when required;
- verify service state, routes, inventory, transfer state, and hardware smoke;
- leave transport and client payload state unchanged unless the phase explicitly
  requires a live transaction test.

Hands-on verification is requested whenever success depends on audible output,
operator timing feel, or a live client/export behavior that server evidence
cannot establish alone.
