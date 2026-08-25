# Realtime and Playback Participant Architecture Audit and Migration Plan

## Status

Proposed on 2026-08-25. This document is a source-grounded architecture audit
and migration plan. It does not describe implemented behavior unless explicitly
identified as current.

Implementation update, 2026-08-25: the recommended first slice is implemented
and deployed to `wren`. The server now has shared loaded and event-backed
publisher primitives, the four existing SSE surfaces are thin adapters over
runtime-owned publishers, and `/playback/snapshot` uses the shared coherent
playback source while retaining fresh sequential generations. Characterization
coverage proves event framing, upstream-listener sharing, timer cleanup, and
fresh-read coalescing. This slice did not change collaboration WebSocket framing,
RNBO delivery, assignment, preparation, activation, or transport writes.

Implementation update, 2026-08-25: Phase 2 is implemented as a separately
versioned, read-only `/realtime` gateway using the maintained `ws` library and
the `shadowscore.realtime.v2` WebSocket subprotocol. It exposes the shared
`score`, `transport`, `playback`, and `playback.transfers` topics with bounded
messages and queues, heartbeat eviction, stable-client replacement, correlated
idempotent subscription requests, deterministic shutdown, and `/session`
discovery. `/collab` remains on its version-1 wire contract and RNBO playback
orchestration remains unchanged.

Implementation update, 2026-08-25: Phase 3 is implemented and deployed to
`wren`. `/collab`
now shares the maintained, bounded, heartbeat-aware WebSocket connection layer
used by `/realtime`, while its version-1 JSON protocol and score-domain command
hub remain separate. Connection ordering and message shapes are preserved;
fragmented messages are now accepted, duplicate stable client IDs are replaced
deterministically, and malformed or oversized input is closed explicitly.
Deployment verification proved exact source parity, focused remote tests, the
version-1 startup sequence plus a fragmented application ping, all four
version-2 topic snapshots, stopped transport, and receiver-confirmed READY
transfers.

Implementation update, 2026-08-25: Phase 4 is implemented and deployed to
`wren`. A normalized participant registry now projects RNBO targets and
connected realtime software sessions without changing the hardware registry,
score assignment documents,
or playback delivery. It retains offline identities, records lifecycle events,
handles connection and RNBO endpoint replacement, resolves current exact and
stable assignment fields, and exposes a read-only `participants` topic.
Deployment verification proved source parity, focused remote tests, exact live
RNBO assignment resolution, software add/replacement/offline lifecycle events,
stopped transport, and receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the first Phase 5 extraction is implemented
and deployed to `wren`. Playback update records, availability observations,
aggregate cohort state, desired invalidation, one-slot preparation invalidation,
cached reads, and adapter-transaction promotion now live in a transport-neutral
state store.
The RNBO adapter translates its existing compiled payloads and acknowledgements
into that store while retaining its public methods and response fields. OSC
delivery, retry, activation, lifecycle history, operation serialization, cohort
selection, clock control, and transport behavior remain in the RNBO adapter.
Deployment verification proved source parity, the complete RNBO adapter suite,
matching desired/prepared hashes and adapter transaction IDs, stable repeated-
read hash caching, stopped transport, and receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the second Phase 5 extraction is implemented
and deployed to `wren`. Mutation-impact history, dirty and missing voice
selection, selective desired-hash cache invalidation, full invalidation
clearing, and bounded lifecycle-event storage now live in transport-neutral
state components. The RNBO adapter still owns lifecycle derivation and logging,
operation serialization, participating-cohort and failure policy, delivery and
activation, clock control, and all transport behavior. Deployment verification
proved exact source parity, the focused state and complete RNBO adapter suites,
bounded lifecycle publication, stable repeated-read hash caching, stopped
transport, aligned synchronization, and receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the third Phase 5 extraction is implemented
and deployed to `wren`. Serialized playback operations now use a
transport-neutral queue, and prepared-cohort policy now classifies
participating, unavailable, missing, invalid, READY, and already-active
participants independently of RNBO. RNBO still owns target resolution,
preparation matching, activation requests and acknowledgements, retry timing,
lifecycle derivation, clock control, and all transport behavior. Deployment
verification proved exact source parity, the focused queue, cohort-policy,
state, and complete RNBO adapter suites, stable
repeated-read compilation, bounded lifecycle publication, stopped transport,
aligned synchronization, and receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the first Phase 6 facade slice is
implemented and deployed to `wren`. A transport-neutral playback participant
coordinator now wraps the RNBO adapter and owns read access to playback updates,
lifecycle history, delivery status and events, operation-queue status, and
readiness inspection. Playback snapshots, the read-only update route, and
generic realtime transfer publication now consume the coordinator. RNBO
diagnostics, score preparation, block activation, macro transitions, transport
controls, and all delivery writes remain directly RNBO-owned. Deployment
verification proved exact source parity, the focused coordinator, snapshot,
route, and complete RNBO adapter suites, identical coordinator and RNBO
transaction and queue state, stable repeated-read compilation, bounded
lifecycle publication, stopped transport, aligned synchronization, and
receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the second Phase 6 facade slice is
implemented and deployed to `wren`. The playback participant coordinator now
delegates block preparation, update application, cached prepared activation,
prepared-activation scheduling, and activation confirmation. Macro look-ahead
and transitions, live-edit update actions, new-score activation, held section
cues, locate, and transport-start orchestration now call the coordinator. The
RNBO adapter remains the only production delivery implementation and still
owns target resolution, OSC encoding and writes, retries, acknowledgement
validation, transaction promotion, clock and phase controls, raw resend, and
RNBO diagnostics. Deployment verification proved exact source parity, the
focused coordinator, macro, transition, route, and complete RNBO adapter suites,
identical coordinator and RNBO prepared transactions, stable repeated-read
compilation, an idle operation queue, stopped transport, aligned
synchronization, and receiver-confirmed READY transfers.

Implementation update, 2026-08-25: the first Phase 7 slice is implemented and
deployed to `wren`. The version-2 gateway now advertises separate `observer`
and `playback` roles. Playback clients register through a required version-1
participant declaration with stable device identity, display metadata,
declared capabilities, and bounded runtime metadata; the server returns its
granted role capabilities and normalized participant identity. Observer
sessions no longer appear as playback participants. `/session` and the initial
`hello.required` envelope expose the role and participant-version contract for
discovery. This slice adds no prepare, READY, activation, ACTIVE, execution-
witness, score, or transport commands. Deployment verification proved exact
source parity, the complete local suite, focused remote gateway and route
tests, live observer separation, live playback add/offline lifecycle events,
stopped transport, aligned synchronization, and receiver-confirmed READY RNBO
transfers.

Implementation update, 2026-08-25: the second Phase 7 slice is implemented and
deployed to `wren`. A transport-neutral realtime playback adapter now registers
with the participant coordinator, delivers versioned multi-voice
`playback.prepare` commands, and accepts correlated `playback.ready` requests
only when participant connection, operation ID, block, score revision, and
payload hash match the pending preparation exactly. Capability declaration and
server grants remain separate; missing capability, mismatched READY, timeout,
disconnect, connection replacement, and shutdown have explicit outcomes.
Normal transport, look-ahead, cue, and activation orchestration do not yet call
this adapter, so software clients cannot enter a production playback cohort
before activation and ACTIVE proof exist. Deployment verification proved exact
source parity, the complete local suite, focused remote tests, live capability
discovery and unsolicited-READY rejection, hardware smoke, stopped transport,
aligned synchronization, and receiver-confirmed READY RNBO transfers.

Implementation update, 2026-08-25: the third Phase 7 slice is implemented and
deployed to `wren`. The coordinator can explicitly activate the exact frozen
software cohort produced by a completed prepare operation. Activation consumes
each prepared slot, carries a distinct operation ID plus the exact prepared
operation ID, and accepts ACTIVE only when connection, activation, preparation,
block, score revision, and payload hash all match. Mismatch leaves the request
pending for correction; timeout, send failure, disconnect, replacement, and
shutdown clear both prepared and active truth. Normal transport, look-ahead,
cue, and activation orchestration remain RNBO-only pending execution witness,
reconnect reconciliation, and explicit production-cohort enrollment.
Deployment verification proved 641 local tests, 200 focused tests from Wren's
deployed tree, live `playback:active` discovery and grant, rejection of an
unsolicited ACTIVE, hardware smoke, stopped transport, and aligned RNBO
players.

The Max for Live playback-client discussion exposed the need for this work, but
the architecture is not specific to Ableton Live. The goal is to establish one
transport-neutral participant model and one reusable realtime publication layer
for the clients ShadowscoreServer already supports and for future playback
engines.

## Executive Finding

ShadowscoreServer already contains most of the required domain semantics, but
they are divided across boundaries that make a second playback transport likely
to duplicate important behavior:

- At audit time, `src/collaboration/websocket.mjs` combined a hand-built WebSocket transport,
  connection tracking, presence, score subscriptions, and every collaboration
  command in one module.
- `src/http/routes.mjs` implements separate SSE paths for score events, RNBO
  transfer state, legacy transport state, and the canonical transport object.
  Several browser surfaces additionally poll `/playback/snapshot` as often as
  every 250 ms.
- `src/adapters/rnbo-osc.mjs` owns both RNBO-specific work and participant-
  generic work: target availability, dirty selection, desired/prepared/active
  hashes, operation serialization, activation barriers, lifecycle history, and
  aggregate update state all live beside OSC encoding, UDP delivery, RNBO
  capability rules, and OSCQuery ACK polling.
- `src/server.mjs`, `src/http/routes.mjs`, and
  `src/playback/block-transition.mjs` call the concrete RNBO adapter directly.
  The server therefore models "playback participant" as "RNBO target" even
  where the behavior is not intrinsically RNBO-specific.
- `src/registration/peer-registry.mjs` is correctly centered on hardware units
  and their RNBO/OSC resources. It is not a general registry for a connected
  software participant such as a laptop.

The correct response is not one monolithic protocol and not the removal of
HTTP or SSE. The safe consolidation boundary is:

1. one internal topic-publication layer with multiple wire adapters;
2. one playback participant coordinator with target-specific delivery
   adapters; and
3. compatibility adapters that preserve all current routes and RNBO behavior
   during migration.

## Scope

This plan covers:

- realtime connection and publication infrastructure;
- score, transport, playback, transfer, presence, and assignment topics;
- playback participant identity, availability, capabilities, and assignment;
- desired, prepared, armed, active, advancing, and execution-witness state;
- extraction of RNBO-independent orchestration from the RNBO OSC adapter;
- compatibility for current HTTP, SSE, `/collab`, registration, and RNBO
  contracts;
- verification and rollout gates that prevent a refactor from weakening the
  existing fleet safety policy.

## Non-goals

- Implementing the Max for Live device in this project.
- Replacing JACK as the current musical-position authority.
- Replacing RNBOOSCQuery, Bonjour coordinator discovery, or hardware-unit
  registration.
- Sending timing-critical note events through Node or a browser connection.
- Making WebSocket delivery equivalent to READY, ACTIVE, advancing, or
  audible proof.
- Removing stable HTTP or SSE routes before every current consumer has an
  equivalent and independently verified path.
- Generalizing OSC Block State recall into note-player activation. Those are
  distinct performance contracts.

## Current Architecture Audit

### 1. Score realtime paths

The score store is a good authority boundary. Every accepted mutation emits a
`change` event containing the mutation type, version, source client ID, detail,
and a structured-cloned complete score.

That event currently fans out through two independent mechanisms:

- `/events` SSE sends an initial complete snapshot and then store events.
- `/collab` WebSocket sends `welcome`, `snapshot`, and `presence.list`, then
  broadcasts each store event as `score.changed`.

Successful `/collab` writes also send an `ack` containing another complete
score. The writing client can therefore receive the same complete score in the
broadcast and the acknowledgement. All connected WebSocket clients receive all
score changes; there is no topic subscription or role filtering.

The collaboration module also contains approximately thirty score-domain
command cases. Connection mechanics cannot be reused without importing that
entire command surface.

### 2. WebSocket implementation

At audit time, the WebSocket implementation was intentionally small and dependency-
free, but it is not an appropriate foundation for a playback control plane:

- fragmented frames are rejected;
- there is no configured maximum message size;
- outgoing writes do not apply a backpressure policy;
- ping frames receive pongs, but the server does not actively detect a stale
  client with a heartbeat deadline;
- a caller-controlled `clientId` query parameter is used directly as the map
  key, so a duplicate ID can replace the tracked client without closing the old
  socket;
- the handshake has no protocol negotiation, client role, capability grant,
  or authentication/authorization boundary;
- transport and domain behavior are tested mainly through in-memory fake
  clients, with only a narrow masked-frame parser test at the wire level.

A maintained WebSocket implementation should own RFC framing, fragmentation,
close behavior, and limits. ShadowscoreServer should own the application
protocol, identity, authorization, topic subscriptions, and delivery policy.

### 3. SSE and polling paths

There are four current realtime observation shapes:

| Surface | Source | Publication model |
| --- | --- | --- |
| `/events` | score store | Event-driven SSE with complete score documents |
| `/rnbo/transfers/events` | RNBO adapter `EventEmitter` | Event-driven SSE snapshots |
| `/transport/events` | JACK transport emitter | Legacy event-driven SSE |
| `/api/v1/objects/transport/events` | authoritative transport publisher | Shared 500 ms snapshot publisher plus SSE |

The canonical transport publisher is the strongest current reuse model: one
publisher refreshes a snapshot and shares it among all subscribers. It should
be generalized into a topic source, not replaced with connection-specific
polling.

`/playback/snapshot` has no equivalent publisher. Multiple browser surfaces
poll it independently, some at 250 ms. The snapshot itself is correctly
server-owned and coherent, but its acquisition and fanout are duplicated per
consumer.

HTTP remains the correct mechanism for initial reads, diagnostics, explicit
commands, administration, and recovery. SSE remains useful for read-only
consumers. The duplication to remove is separate source acquisition and event
semantics, not the existence of multiple wire transports.

### 4. Playback lifecycle ownership

The RNBO adapter currently contains two different categories of responsibility.

Participant-generic responsibilities:

- observe score-mutation impact;
- select dirty/missing voices;
- enumerate available and unavailable assigned targets;
- calculate desired payload identity;
- track desired, prepared, and active hashes and transaction tokens;
- serialize overlapping activation operations;
- preserve one prepared slot per target;
- require exact block, payload, transaction, and acknowledgement matches;
- aggregate ensemble update state;
- record preparation/activation lifecycle events;
- preserve offline assignments while excluding known-unavailable members from
  the participating cohort;
- fail a selected cohort closed when readiness or activation proof fails.

RNBO-specific responsibilities:

- compile notes into the RNBO row/context representation;
- choose RNBO timing resolution and enforce RNBO capacity;
- allocate an exactly representable numeric RNBO transaction ID;
- encode and pace OSC/UDP messages;
- retry/resume partial RNBO transfers;
- interpret RNBO opcodes and rejection reasons;
- poll OSCQuery ACK, stage, clock-start, and phase-reset paths;
- write `Clock`, `SetStage`, `ClockInterval`, `MaxSteps`, and related RNBO
  controls;
- discover/reconcile RNBO targets and retain RNBO transfer diagnostics.

These responsibilities should be separated without changing either category's
observable behavior.

### 5. Identity, registration, and assignment

The current hardware registry has a sound hardware-specific contract:

- peers register a stable hardware-unit identity;
- heartbeats refresh a TTL;
- units remain visible but become offline after expiration;
- RNBO targets and OSC resources are nested under the unit;
- score assignments retain stable `deviceId` and refresh ephemeral RNBO
  endpoint fields when reconciliation is unambiguous.

A directly connected software participant does not naturally belong in that
registry. It may have no peer ShadowscoreServer, RNBOOSCQuery instance, or
hardware-unit heartbeat endpoint.

Add a playback participant registry as a projection above transport-specific
registries:

- registered RNBO targets are projected from the hardware registry;
- connected software participants are projected from realtime sessions;
- assignments resolve against stable participant/device identity;
- transport-specific endpoint metadata remains attached to the participant's
  adapter descriptor.

Do not turn `/hardware/units` into a mixed hardware/software inventory.

### 6. Naming and protocol consistency

Current public contracts use different conventions:

- canonical transport uses `request_id` and `client_id`;
- collaboration uses `requestId`, `clientId`, and `expectedVersion`;
- target and transaction state often uses RNBO-specific field names such as
  `rnboTargetId` and numeric `transactionId`.

Existing contracts must remain compatible. A new realtime protocol should use
one canonical convention and translate legacy messages at the edge.

## Preserved Invariants

The migration is unacceptable unless all of these remain true:

1. The score store remains the durable composition authority.
2. JACK/authoritative arrangement state remains control truth; participant
   readback is execution evidence.
3. Saved, desired, prepared, armed, active, advancing, and audible remain
   distinct states.
4. Transfer completion does not imply READY, and READY does not imply ACTIVE.
5. ACTIVE is accepted only for the exact participant, adapter transaction,
   block, payload hash, and current operation.
6. Each target's staging-slot capacity is explicit. Preparing one block cannot
   silently leave a different block eligible for activation.
7. The participating cohort is frozen before timing/activation writes.
8. Known-unavailable assignments remain visible and may be omitted as a
   reported degraded cohort; a participant that fails after cohort selection
   causes rollback/failure.
9. Clock-start acknowledgement, phase acknowledgement, direct execution
   position, and physical audibility are not interchangeable.
10. Current RNBO transport, score preparation, retry, activation, phase, and
    startup-adoption behavior remains unchanged until separately migrated and
    proven.

## Target Architecture

```text
                         Score store
                             |
                    Domain event/topic sources
                  / score / transport / playback \
                 / transfers / presence / routing \
                             |
                    Realtime topic broker
                    /         |          \
           HTTP snapshots   SSE adapters   WebSocket gateway
                                             |
                                  browser / M4L / future clients

                         Playback coordinator
                   / participant registry and state \
                  / compile / prepare / arm / confirm \
                         /                    \
                 RNBO adapter             future adapters
              OSC/UDP + OSCQuery          WebSocket/JSON, etc.
```

### Realtime topic broker

The broker is an internal API, not a replacement public protocol. Each topic
defines:

- a stable name and protocol version;
- a complete snapshot loader;
- an optional event source or bounded refresh interval;
- a monotonically increasing topic sequence;
- subscriber registration and cleanup;
- coalescing policy for replaceable snapshots;
- retention/replay policy, normally latest snapshot plus a small event window;
- authorization requirements;
- serialization independent of SSE or WebSocket.

Initial topics:

| Topic | Source | Delivery rule |
| --- | --- | --- |
| `score` | score-store events | Complete initial snapshot, then revisioned mutation events |
| `transport` | authoritative transport publisher | Latest complete timestamped object state |
| `playback` | coherent playback snapshot publisher | Latest complete snapshot at a shared bounded rate plus lifecycle-triggered refresh |
| `playback.transfers` | adapter transfer events | Replaceable current snapshot plus bounded completed history |
| `participants` | participant registry | Identity, assignment, availability, capabilities, and liveness changes |
| `presence` | realtime sessions | Ephemeral editor/operator presence only |

SSE routes and the WebSocket gateway subscribe to these same sources. No wire
adapter independently polls RNBO, JACK, or the score store.

### Realtime WebSocket gateway

Use a maintained WebSocket server implementation rather than extending the
custom frame parser. The gateway owns:

- standards-compliant handshake, fragmentation, ping/pong, and close handling;
- maximum frame/message size;
- server-generated connection ID and duplicate stable-client policy;
- heartbeat deadline and disconnect cleanup;
- per-connection outbound queue and backpressure accounting;
- protocol negotiation;
- role and server-granted capability set;
- topic subscriptions;
- request correlation and idempotency cache;
- orderly shutdown.

Snapshot events may be coalesced to the latest value for a slow client.
Commands, command results, READY, ACTIVE, and errors must never be silently
dropped or replaced.

Proposed version-2 envelope:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "event",
  "topic": "transport",
  "request_id": null,
  "client_id": "server-granted-stable-id",
  "sequence": 42,
  "observed_at": "2026-08-25T16:00:00.000Z",
  "payload": {}
}
```

The initial client message requests a role and subscriptions. The server
returns the accepted identity, granted capabilities, protocol version, session
ID, heartbeat interval, and accepted topics. A client declaration is not an
authorization grant.

### Domain command handlers

Score editing, transport intent, participant acknowledgements, and presence
remain separate handlers even when they share a socket. Each handler owns:

- schema validation;
- authorization;
- revision/idempotency rules;
- domain service invocation;
- normalized result/error production.

The existing collaboration switch becomes a version-1 compatibility handler,
not the connection manager.

### Participant registry

A normalized participant descriptor should contain at least:

```json
{
  "participant_id": "wren:rnbo-inst-22:shadowscore",
  "stable_device_id": "wren",
  "kind": "rnbo",
  "adapter": "rnbo-osc",
  "status": "online",
  "available": true,
  "capabilities": {},
  "endpoint": {},
  "last_seen_at": "2026-08-25T16:00:00.000Z",
  "expires_at": null
}
```

The registry owns normalized liveness and capability truth. It does not own
score assignments, payload state, or musical position.

RNBO descriptors retain their current hardware and OSCQuery metadata under
`endpoint`. A connected software participant retains its realtime session and
declared runtime metadata there. Existing score assignment fields remain
supported while a resolver projects them into normalized participant IDs.

### Participant coordinator

The coordinator owns the transport-neutral state machine:

```text
saved-not-active
      |
      v
  preparing -> failed
      |
      v
    ready
      |
      v
    armed -> activation-failed
      |
      v
    active
      |
      v
 advancing / execution-witnessed
```

Suggested adapter boundary:

```js
{
  kind,
  enumerateParticipants(context),
  compile({ score, blockId, participant }),
  prepare({ operationId, participant, compiled, reason }),
  arm({ operationId, participant, preparedToken, boundary, position }),
  confirmActive({ operationId, participant, preparedToken, deadline }),
  observeExecution({ participant }),
  stop({ participant, reason })
}
```

The exact interface should be driven by characterization tests. Two identities
must remain distinct:

- `operation_id`: a transport-neutral server correlation/idempotency ID;
- `adapter_transaction_id`: the adapter's own exact activation token, such as
  the RNBO numeric transaction ID.

The coordinator must never assume that all adapters use numeric transaction
IDs, identical payload formats, identical staging capacity, or identical phase
controls.

### RNBO adapter after extraction

The RNBO adapter continues to own:

- RNBO compilation and payload hashing;
- numeric transaction allocation;
- UDP batching, retry, resume, and pacing;
- OSCQuery acknowledgement validation;
- RNBO activation requests and phase controls;
- RNBO target discovery and adapter-specific transfer diagnostics.

It reports normalized preparation and activation outcomes to the coordinator.
Existing RNBO-specific diagnostic routes may continue to expose the richer
adapter data.

## Compatibility Strategy

The migration is additive and internal-first.

- Keep `/collab` and `shadowscore.collab.v1` unchanged at the wire level.
- Keep `/events`, `/rnbo/transfers/events`, `/transport/events`, and
  `/api/v1/objects/transport/events` unchanged.
- Keep canonical transport GET/POST behavior and its `request_id` envelope.
- Keep `/hardware/register`, hardware heartbeats, `/hardware/units`, and RNBO
  target identifiers unchanged.
- Keep `/playback/snapshot`, `/playback/updates`, and RNBO transfer diagnostics
  unchanged until parity tests prove the new internal sources.
- Keep all RNBO opcodes, messages, retry policy, one-staging-slot behavior,
  READY/ACTIVE validation, cohort freezing, and fail-closed barriers unchanged.
- Do not migrate browser clients merely to prove that the new gateway works.
  Migrate a consumer only when the new path gives it a concrete benefit.

Legacy transports become adapters over shared internals. They are not removed
in the same change that introduces those internals.

## Migration Plan

### Phase 0: Characterize and freeze current contracts

Add characterization tests before extraction:

- complete `/collab` connect/write/broadcast/error/presence sequences;
- actual HTTP-upgrade WebSocket tests, including close, ping/pong, malformed
  messages, duplicate IDs, and large complete score frames;
- exact SSE event names and payload shapes for all four streams;
- authoritative transport publisher subscriber lifecycle;
- `/playback/snapshot` desired/prepared/active and execution-witness fields;
- RNBO one-staging-slot invalidation, dirty selection, cohort freezing,
  operation serialization, late ACTIVE reconciliation, and rollback behavior.

Record a clean full-suite baseline. Do not refactor a behavior that lacks a
passing characterization test.

### Phase 1: Extract internal topic publication

Introduce a small `src/realtime/` layer containing topic/source primitives.

1. Generalize the authoritative transport publisher without changing its
   snapshot cadence or public SSE output.
2. Adapt score events and RNBO transfer snapshots to the same subscriber API.
3. Add one coherent playback-snapshot publisher shared by browser polling
   alternatives and future realtime subscribers.
4. Make current SSE handlers thin serialization adapters over these sources.
5. Prove exact SSE parity and cleanup on connection close.

No WebSocket or RNBO lifecycle behavior changes in this phase.

### Phase 2: Introduce the standards-based realtime gateway

Add a maintained WebSocket dependency and implement the generic gateway with:

- bounded messages and outbound queues;
- heartbeat and stale-session eviction;
- protocol negotiation;
- server-generated connection IDs;
- stable-client duplicate policy;
- topic subscriptions and authorization;
- command/result correlation;
- deterministic shutdown.

Initially expose only read-only test topics. Keep `/collab` on its current wire
contract until gateway behavior is proven.

### Phase 3: Move collaboration v1 onto shared connection infrastructure

Extract collaboration domain commands from the current transport module.

1. Preserve every current message name and payload exactly.
2. Preserve the initial `welcome`, `snapshot`, and `presence.list` order.
3. Preserve store revision guards and `sourceClientId` behavior.
4. Route `/collab` through a v1 protocol adapter on the generic gateway.
5. Keep score topic fanout shared rather than maintaining a second store
   listener.

Only after parity is complete should the custom frame parser be removed.

### Phase 4: Add the normalized participant registry

Create a registry above hardware and realtime connection sources.

1. Project existing RNBO targets into normalized participant descriptors.
2. Preserve hardware-unit pages and APIs unchanged.
3. Add participant snapshots and lifecycle events internally.
4. Add assignment resolution from current stable `deviceId` and
   `rnboTargetId` fields.
5. Test duplicate identities, endpoint replacement, offline TTL, reconnect,
   ambiguous resolution, and locked assignment behavior.

Do not change playback delivery in this phase.

### Phase 5: Extract participant playback state

Move transport-neutral state out of `rnbo-osc.mjs` in small, test-preserving
steps:

1. playback update record and aggregate-state calculation;
2. desired/prepared/active hash bookkeeping;
3. staging-slot invalidation;
4. dirty block/voice selection from score-mutation impact;
5. serialized prepare/activation operation queue;
6. normalized lifecycle event history;
7. participating-cohort selection and failure policy.

At first, the RNBO adapter remains the only adapter and calls the extracted
components. Public methods such as `prepareBlock`, `applyBlockUpdate`, and
`playbackUpdates` retain their current behavior.

### Phase 6: Introduce the participant coordinator facade

Place a transport-neutral facade in `runtime` and migrate orchestration callers
away from the concrete RNBO adapter:

- macro look-ahead preparation;
- block-transition activation;
- manual apply/update-now;
- transport-start preparation and activation;
- readiness aggregation;
- playback snapshot construction;
- lifecycle publication.

The RNBO adapter remains the only production delivery adapter during this
phase. Existing `runtime.rnboAdapter` diagnostics may remain available, but
generic orchestration must no longer require RNBO field names.

This is the highest-risk phase. It requires focused RNBO tests, the full test
suite, source-diff review, and a separate live Wren acceptance plan before any
deployment.

### Phase 7: Expose realtime playback participation

After RNBO parity is proven, add versioned playback-domain messages to the
generic gateway:

- participant hello/register and granted capabilities;
- assignment and desired-state snapshot;
- prepare transaction;
- READY acknowledgement;
- activation command;
- ACTIVE acknowledgement;
- execution witness;
- heartbeat, reconnect, and reconciliation.

The first non-RNBO client should be treated as an acceptance consumer of this
architecture, not as the source of its semantics.

#### Phase 7a contract boundary

The first Phase 7 slice establishes registration without exposing preparation
or activation writes. The existing `observer` role remains compatible and is
not projected as a playback participant. A client that requests the `playback`
role must include a versioned participant declaration in its initial hello:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "hello",
  "request_id": "hello-1",
  "client_id": "ableton-laptop",
  "role": "playback",
  "topics": ["score", "transport", "playback", "participants"],
  "participant": {
    "protocol_version": 1,
    "stable_device_id": "ableton-laptop",
    "display_name": "Ableton Live",
    "capabilities": ["score:prepare", "score:activate", "execution:witness"],
    "runtime": {
      "name": "Shadowscore M4L",
      "version": "0.1.0",
      "platform": "max"
    }
  }
}
```

The server validates the declaration, grants only its role capabilities, and
returns the normalized participant identity in `welcome`. The registry keeps
declared client capabilities separate from server-granted permissions. The
`hello.required` envelope and `/session` advertise the available roles and
participant protocol version, so a client can discover this contract before
registering. Unknown participant versions fail explicitly; they are never
silently treated as the current protocol.

This boundary deliberately does not add prepare, READY, activate, ACTIVE, or
execution-witness messages. Those messages require their own coordinator-backed
delivery and exact operation-ID characterization before they can be granted.

#### Phase 7b prepare and READY boundary

The second Phase 7 slice adds a transport-neutral realtime participant adapter
behind the playback coordinator. The coordinator owns a server-generated or
caller-supplied `operation_id` and can explicitly prepare assigned, connected
software participants. This method is not yet called by normal transport,
look-ahead, cue, or activation orchestration; software participants remain
outside the production playback cohort until activation and ACTIVE proof can
preserve the existing fail-closed policy.

For each selected participant, the adapter sends one non-coalescible
`playback.prepare` command. One participant may own multiple voices; the
payload therefore contains `voice_ids` and a versioned desired-state document
with shared block attributes plus one clip document per voice:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "playback.prepare",
  "payload": {
    "score_contract_version": 1,
    "operation_id": "prepare-1",
    "participant_id": "realtime:ableton-laptop",
    "block_id": "A",
    "voice_ids": ["player-1"],
    "score_revision": 45339,
    "payload_hash": "sha256-of-desired-document",
    "reason": "lookahead",
    "desired": {
      "schema": "shadowscore.playback-score.v1"
    }
  }
}
```

After staging the complete desired document, the client sends a correlated
`playback.ready` request containing the exact `operation_id`, `block_id`,
`score_revision`, and `payload_hash`. The server accepts READY only from the
same participant connection that received the pending command. A mismatched
READY returns an error but leaves the exact request pending for correction;
disconnect, connection replacement, timeout, and shutdown reject it. A newer
connection invalidates pending and prepared truth from the older endpoint.

`/session` advertises `playback.ready`, and the playback role grants
`playback:ready`. Client-declared `score:prepare` remains independently required
before the adapter will send a desired-state document. Activation, ACTIVE,
execution witness, reconnect reconciliation, and production-cohort enrollment
remain later boundaries.

#### Phase 7c activation and ACTIVE boundary

The third Phase 7 slice adds explicit coordinator-driven activation without
enrolling software participants in normal transport. Activation has its own
`operation_id` and references the exact `prepared_operation_id` that produced
READY. The adapter activates the frozen cohort recorded by that prepare
operation; it never discovers a new participant at activation time.

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "playback.activate",
  "payload": {
    "operation_id": "activate-1",
    "prepared_operation_id": "prepare-1",
    "participant_id": "realtime:ableton-laptop",
    "block_id": "A",
    "voice_ids": ["player-1"],
    "score_revision": 45339,
    "payload_hash": "same-prepared-payload-hash",
    "boundary": "next-cycle",
    "position": { "beat": 16 }
  }
}
```

Sending activation consumes the participant's prepared slot. The client sends
a correlated `playback.active` request only after the prepared document is the
executing document. ACTIVE must match the activation operation, prepared
operation, participant connection, block, score revision, and payload hash.
Mismatches leave the exact activation pending for correction. Timeout, send
failure, disconnect, connection replacement, or shutdown leaves neither READY
nor ACTIVE truth for that participant and requires a new preparation or later
reconciliation.

Only one prepare or activation operation may be pending per participant. A new
prepare invalidates an older prepared token, and reconnect invalidates both
prepared and active in-memory truth. The playback role grants
`playback:active`, `/session` advertises `playback.active`, and the client must
also declare `score:activate`. Execution witness, reconnect reconciliation, and
production-cohort enrollment remain later boundaries.

### Phase 8: Optional consumer migration and retirement

After sustained parity:

- move high-rate playback observers from independent 250 ms polling to the
  shared playback topic;
- allow browser transport bars to subscribe through the realtime gateway when
  beneficial;
- retain SSE for read-only and low-complexity clients;
- deprecate a legacy path only with usage evidence, documentation, and an
  explicit compatibility window.

Consolidation does not require every client to use WebSocket.

## Verification Gates

### Every phase

- focused unit and route tests;
- full `npm test`;
- `git diff --check`;
- no unplanned public response-shape changes;
- bounded listener/subscriber counts after repeated connect/disconnect;
- clean shutdown with no retained timers or sockets.

### Realtime infrastructure

- fragmented and large allowed messages work within the configured limit;
- oversized and malformed messages close safely;
- heartbeat timeout removes presence and participants;
- duplicate stable-client behavior is deterministic;
- slow subscribers cannot grow memory without bound;
- replaceable snapshots coalesce, while commands and acknowledgements do not
  disappear;
- SSE and WebSocket subscribers observe the same topic sequence and revision.

### Participant coordinator

- a prepared transaction for another block cannot activate;
- a second preparation invalidates the previous single staging slot;
- all selected participants reach matching READY before arming;
- all selected participants reach matching ACTIVE before committing the
  playhead;
- a selected participant failure remains fail-closed and rolls back as it does
  today;
- known-offline assignments remain visible and produce an explicit degraded
  cohort rather than silently disappearing;
- late ACTIVE reconciliation remains idempotent;
- saved, prepared, active, advancing, and audible surfaces remain distinct.

### Live RNBO acceptance before changing production orchestration

Use the established identity-verified Wren workflow only after explicit
deployment authorization. Require:

- source/checksum parity and focused remote tests;
- service and route health;
- exact participating-cohort reporting;
- transaction-matched READY and ACTIVE across the selected fleet;
- direct advancing `current_stage`/`playback_debug` witnesses;
- continuing activation across multiple block boundaries;
- stopped update-now behavior;
- unavailable-assignment degraded behavior;
- restart adoption without unintended score, clock, or phase rewrites;
- physical audibility confirmation as a separate final witness.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| A broad refactor destabilizes proven RNBO playback | Extract state behind the existing adapter first; keep RNBO as the only production adapter until parity is complete |
| One gateway becomes a monolith | Keep connection infrastructure, topic sources, and domain handlers separate modules |
| WebSocket reliability is mistaken for playback proof | Preserve application transaction IDs, hashes, READY, ACTIVE, and execution witnesses |
| Slow clients create memory pressure | Bound message size and queues; coalesce replaceable snapshots; disconnect persistently stalled clients |
| A client grants itself editor or playback authority | Server grants roles/capabilities; declarations are descriptive requests only |
| Hardware and laptop identity become conflated | Keep hardware registry intact and project both hardware targets and connected software into a separate participant registry |
| New generic names erase useful RNBO diagnostics | Normalize orchestration state while retaining adapter-specific diagnostic payloads and routes |
| Compatibility translation becomes permanent ambiguity | Version the realtime protocol and isolate v1 translation at the edge |
| Polling is removed before the replacement is proven | Introduce shared publishers first; migrate each consumer independently after parity |

## Recommended First Implementation Slice

The first implementation should stop before participant behavior changes:

1. add missing characterization tests;
2. extract the internal topic/source abstraction;
3. route the four SSE surfaces through shared publishers with exact parity;
4. add a coherent shared playback-snapshot publisher;
5. verify the full suite and listener/timer cleanup.

That slice produces immediate consolidation, reduces repeated playback polling,
and creates the source side of a future gateway without touching RNBO delivery,
assignment, activation, transport writes, or live fleet behavior.

The participant-state extraction should be a separately reviewed and accepted
implementation phase.
