# Mesostructural OSC Clip And Instance Snapshot Development Plan

## Goal

Give ShadowscoreServer a composition-owned OSC payload system whose saved state
comes from a specific RNBO instance, not from an editor. An OSC editor may send
one draft to many live instances, but that fanout is a performance/editing
operation and must never imply that those instances share saved score state.

The score stores instance-specific state as reusable OSC clips. A
mesostructural block layers those clips by assigning each one to a logical OSC
role. The role is a stable stand-in for a destination that may be offline,
restarted under a different RNBO instance number, or mapped to different
hardware when the score is loaded.

This extends Shadowscore's existing role:

- note clips organize sound-object events;
- OSC clips store captured persistent state for individual processes;
- mesostructural blocks layer both kinds of clips and assign them to logical
  destinations;
- macrostructure arranges those combined block states through time.

RNBO remains the real-time sound and performance runtime. Shadowscore supplies
the mesostructural and macrostructural compositional backbone that RNBO's own
parameter and export surfaces intentionally do not provide.

## Corrected Product Decisions

The next implementation should preserve these decisions:

1. A saved snapshot describes one RNBO instance's persistent state. It is
   captured from exactly one source instance even when an editor is currently
   sending live changes to several instances.
2. The stored payload is an OSC clip. It has its own stable clip id and can be
   reused, copied, renamed, or assigned to a mesostructural block without
   embedding a live destination.
3. A mesostructural block contains OSC layers that map logical roles to OSC
   clip ids. Every occurrence of block `F` recalls the same layer assignments.
4. Logical OSC roles are static score-owned destination identities. Runtime
   mappings connect those roles to currently available OSC instances, just as
   MIDI tracks can be mapped to available MIDI outputs.
5. Runtime role assignments reuse the same stable-device and routing-status
   principles as ShadowScore player assignments, but remain a distinct mapping
   collection because an OSC Editor instance is not necessarily a score player.
6. Score data remains valid when the rig is absent. Loading a score exposes
   unresolved roles and offers compatible discovered instances as mappings;
   it does not rewrite clips to match the current rig.
7. A newly discovered instance is initialized into the current score through
   an onboarding operation: create or select a logical role, capture the
   instance's current state into an OSC clip, assign that clip to the active
   block, and map the role to the live instance. Automatic onboarding is only
   safe when identity and destination are unambiguous; otherwise Admin presents
   the instance as an unmapped resource requiring confirmation.
   Each onboarding capture creates a distinct OSC clip for that instance; it
   never derives one shared saved clip from an editor's multi-target selection.
8. Recall is initially best-effort OSC. Existing list ACK mechanisms remain a
   way to hydrate editor text fields; they are not required for field-by-field
   recall verification.
9. Writes are concurrent across instances and ordered within each instance.
10. Persistent parameters and lists are sent before `Clock`. A saved `Clock`
   value is compositional state and is sent last.
11. `Clock: 1` is implemented consistently by sequencer exports as an armed,
   next-shared-beat start. `Clock: 0` suspends the process according to the
   shared sequencer contract.
12. `RTZ`, probes, panic actions, stage readbacks, and other momentary commands
   are not snapshot state.
13. `Ignore Shadowscore recall` is runtime routing policy. It suppresses
   automatic and manual recall to an assigned instance without deleting the
   OSC clip or the block layer that references it.

## Data Model

### Logical Control Assignments

Add a top-level score collection for stable OSC control roles. The exact name
can be finalized during implementation; this plan uses `oscAssignments`.

```json
{
  "oscAssignments": {
    "analog-sequencer-a": {
      "label": "Analog Sequencer A",
      "app": "analogsequencer",
      "deviceId": "heron",
      "oscTargetId": "heron:analogsequencer:main",
      "ignoreRecall": false,
      "locked": false,
      "routingStatus": ""
    }
  }
}
```

The durable identity is the role id plus the target's stable device identity.
`oscTargetId`, host, port, and RNBO base address are refreshed routing details.
The mapping layer must preserve unassigned, offline, stale, ambiguous, locked,
and ignored states without rewriting OSC clip data.

Do not merge this collection into `assignments`. Existing assignments route
stable score players to ShadowScore playback clients; `oscAssignments` routes
composition-owned control roles to arbitrary editor-capable RNBO instances.

### OSC Clips

Add a top-level `oscClips` collection. Each clip stores the semantic state
captured from one live instance. Capture provenance is diagnostic metadata; it
does not become the playback destination.

```json
{
  "oscClips": {
    "osc-analog-a-001": {
      "name": "Analog A - opening",
      "schemaVersion": 1,
      "app": "analogsequencer",
      "params": {
        "ClockRate": 2,
        "GateTime": 0.45,
        "Clock": 1
      },
      "inputPorts": {
        "Steps": [1, 0, 1, 0, 1, 0, 0, 1]
      },
      "capture": {
        "deviceId": "wren",
        "targetId": "wren:analogsequencer:main",
        "capturedAt": "2026-07-15T16:00:00.000Z"
      }
    }
  }
}
```

OSC clips store semantic parameter and input-port names. Live addresses are
resolved from the logical role's current normalized OSC target at recall time.
The saved `targetId` in `capture` is informational and must never override the
role assignment.

Capture should normally be complete for the persistent controls exposed by the
source instance, so assigning the clip produces deterministic state. Missing
controls mean "not owned by this clip" and are left unchanged at recall. This
permits gradual adoption and future export revisions.

### Mesostructural OSC Layers

Each block maps logical OSC roles to OSC clips independently of player/note
clip assignments:

```json
{
  "mesostructure": {
    "F": {
      "duration": { "bars": 4 },
      "players": {},
      "oscLayers": {
        "analog-sequencer-a": {
          "clipId": "osc-analog-a-001"
        }
      }
    }
  }
}
```

This indirection separates three concerns:

- the OSC clip says what state should be active;
- the block layer says which logical process should receive that state;
- `oscAssignments` says which live instance currently performs that role.

Reusing a clip across blocks for the same role is normal. Assigning the same
clip to a different role is allowed only as an explicit compositional action;
capture and onboarding always create distinct per-instance clips.

Deleting a block layer must not automatically delete its OSC clip. Deleting an
OSC clip must be rejected while referenced, or require an explicit operation
that also removes/replaces every reference.

## Recall Contract

For each block OSC layer, resolve its `clipId`, then resolve the layer's role to
one live instance. Compile that OSC clip into ordered groups:

1. Non-clock RNBO parameters.
2. OSC message-inport lists and other persistent message state.
3. Any editor-declared late state.
4. `Clock`, if present, as the final write.

Different instances are dispatched concurrently. Writes within one instance
remain ordered. A failure on one instance does not prevent recall attempts on
the others.

The recall result records, at minimum:

- block id, role id, and OSC clip id;
- resolved target id and routing status;
- skipped reason for unassigned, offline, ambiguous, or ignored roles;
- attempted write count;
- immediate send successes and failures;
- start and completion timestamps.

These results describe Shadowscore's send attempt, not confirmed RNBO state.

### Clock And Block-Boundary Timing

Sending `Clock: 1` exactly after a block boundary would make a client that
quantizes starts to the next beat enter one beat late. Sending the rest of the
snapshot before the boundary is also not automatically safe: current RNBO
parameter and message-inport writes take effect immediately, so a preload can
alter the final beat of the outgoing block.

The initial implementation must not claim atomic boundary activation. It should
first measure a boundary-time burst with real dense snapshots:

1. At block entry, send non-clock params and lists.
2. Send `Clock` last.
3. Record dispatch duration and observe whether newly clocked processes enter a
   beat late because of their next-beat quantization.

After that baseline, choose one of two phase-aligned strategies:

1. **Short lead window**: send the ordered burst immediately before the block
   boundary and accept that controls can become effective slightly early. This
   is viable only if live tests show the transition is musically clean at the
   densest expected payload.
2. **Client staging and commit**: standardize supported sequencer exports so
   snapshot values can be staged without affecting the current process, then
   committed together on the requested shared beat. This is the correct path if
   exact block-boundary behavior is required.

The target staged behavior is:

1. Shadowscore knows the upcoming block and boundary from macro playback.
2. It sends the upcoming block's snapshot into client-side pending state.
3. It sends the final clock state and commit instruction after the snapshot
   payload.
4. The RNBO export commits the pending state and activates `Clock: 1` on the
   shared beat corresponding to the new block boundary.

If `Clock: 0` remains an immediate stop rather than a quantized transition, it
must not be sent early during lookahead. Either the client stages it with the
rest of the snapshot or Shadowscore sends it at the boundary. Phase 1 must
settle this common export contract.

The first implementation can separate delivery into two milestones:

- boundary recall, sufficient for validating storage, routing, ordering, and
  editor workflow;
- beat-aware staged or measured-lookahead recall, required before calling
  phase-aligned clock transitions production-ready.

Manual block selection should ultimately be quantized to a future beat and use
the interval before that beat for snapshot delivery. Until that behavior is
implemented, the UI must report that a manual immediate recall arms clock for
the next observed beat.

## HTTP API Draft

Use clip CRUD, block-layer assignment, capture, and recall routes with score
revision checks:

```http
GET    /osc/clips
POST   /osc/clips
GET    /osc/clips/:clipId
PUT    /osc/clips/:clipId
DELETE /osc/clips/:clipId
POST   /osc/clips/capture

GET    /mesostructure/:blockId/osc-layers
PUT    /mesostructure/:blockId/osc-layers/:roleId
DELETE /mesostructure/:blockId/osc-layers/:roleId
POST   /mesostructure/:blockId/osc-layers/recall
```

`POST /osc/clips/capture` accepts exactly one normalized live `targetId`, a
requested clip name/id, and optional block/role assignment. The server reads
the source instance through OSCQuery and the existing app-specific list
readback protocol, validates the resulting semantic payload, then creates the
clip. It must reject multiple source target ids.

`PUT /osc/clips/:clipId` supports deliberate offline editing or replacement of
a clip document. It contains `params`, `inputPorts`, app identity, and
`expectedVersion` or `expectedStructureRevision`. Compositional data remains
writable while the rig is absent.

`PUT /mesostructure/:blockId/osc-layers/:roleId` contains a `clipId` and must
validate that both the role and clip exist. It changes only the block layer,
not the clip payload or live assignment.

The recall route accepts optional role ids and a dry-run flag:

```json
{
  "roles": ["analog-sequencer-a"],
  "dryRun": false
}
```

Add separate assignment routes or extend an existing generic assignment
service without overloading player routes:

```http
GET    /osc/assignments
PUT    /osc/assignments/:roleId
DELETE /osc/assignments/:roleId
POST   /osc/assignments/reconcile
```

`PUT /osc/assignments/:roleId` is also the persistence surface for
`ignoreRecall`.

## Editor Workflow

Editors remain live performance surfaces. They can read one instance and send
the same change to any checked set of instances, but their local draft is not
score state and must not be saved implicitly.

Provide a consistent score section without replacing instrument-specific UI:

- **Capture state from**: exactly one live source instance.
- **Capture as OSC clip**: reads that instance's actual state and creates a
  score-owned OSC clip.
- **Assign clip to**: chooses a mesostructural block and logical role.
- **Load OSC clip into editor**: optional drafting convenience; fills the form
  without sending and does not change the saved clip.
- **Recall block layer now**: resolves the selected block/role/clip through the
  server and sends it to the assigned instance.
- **Ignore Shadowscore recall**: assignment-level opt-out for the selected live
  instance.
- With **CHASE** enabled, a playing-block change loads the focused role's
  Written clip into the editor with Max-style `set` semantics: controls update
  without emitting editor OSC. Unspecified slots and ignored roles leave the
  editor controls unchanged. Playback recall remains independent across all
  roles.
- status: source instance, clip id/name, assigned block and role, routing state,
  active block, and last recall result.

Keep these concepts independent:

- **Get state from** selects one live RNBO source and may use OSCQuery plus list
  ACK readback to populate the UI.
- **Send data to** selects live targets for immediate editing.
- **Capture state from** selects the sole source of new score data.
- **Assign clip to** selects the block and logical destination for an existing
  OSC clip.
- a logical role determines which runtime target receives the OSC clip during
  score recall.

The first editor integration should be a list-based sequencer because it
exercises both RNBO params and OSC-list inports. AnalogSequencer should follow
because it exercises dense parameter state and the standardized `Clock`
transition.

## Implementation Phases

There is no backward-compatibility requirement. No valuable score data depends
on the prototype `mesostructure.*.oscSnapshots` schema, so implementation should
replace it outright rather than maintain dual reads, migrations, aliases, or
deprecated routes.

### Phase A: Replace The Prototype Schema

Status: implemented in the first replacement-schema pass. The score now owns
top-level `oscClips`; blocks own `oscLayers`; prototype mutations, routes, and
collaboration events have been removed; persistence and restore reject broken
layer references; and recall resolves layers through clips. The full local test
suite passes against the replacement schema.

- Add top-level `oscClips: {}` to initial score creation and normalization.
- Replace every block's `oscSnapshots` collection with `oscLayers: {}`.
- Remove `replaceOscSnapshot` / `removeOscSnapshot` store mutations and add
  OSC clip CRUD plus block-layer assignment mutations.
- Define deletion rules for referenced clips and orphan reporting.
- Update New Score, reset, persistence, named-score save/load, backup/restore,
  block duplication, SSE, and WebSocket collaboration to use only the new
  schema.
- Replace prototype fixtures and tests directly. Do not retain legacy score
  normalization or old HTTP/WebSocket event names.

Exit criterion: `rg oscSnapshots` finds no production references, a new score
contains `oscClips` and per-block `oscLayers`, and the full suite passes against
the replacement schema.

### Phase B: OSC Clip And Layer APIs

Status: implemented. Clip CRUD and block-layer HTTP/WebSocket surfaces keep
payload mutation separate from layer assignment, enforce role/clip app
compatibility, reject referenced-clip deletion with structured block/role
references, and expose per-clip plus collection-wide reference/orphan reports.
Tests cover reuse across blocks and replacing one layer without mutating the
shared clip.

- Implement OSC clip list/create/read/replace/delete routes.
- Implement block OSC-layer list/assign/remove routes.
- Validate app compatibility when a clip is assigned to a role.
- Reject deletion of a referenced clip with a response listing its block/role
  references; provide a separate explicit delete-with-references operation only
  if the UI needs it.
- Keep clip payload mutation separate from layer assignment and live role
  assignment.
- Include clip and layer changes in structure revision checks and collaboration
  events.

Exit criterion: an offline client can create an OSC clip, reuse it in multiple
blocks, replace one block's layer without changing the clip, and safely inspect
all references.

### Phase C: Capture One Live Instance

Status: implemented locally. `POST /osc/clips/capture` accepts one normalized
target, refreshes parameters from OSCQuery, uses the existing `-999` plus ACK
readback contract for ListSequencer and ListVelSequencer lists, excludes
momentary controls, stores enum indexes and capture diagnostics, and can create
the clip plus block layer in one store revision. Unit and route tests cover
ListSequencer, ListVelSequencer, AnalogSequencer, incomplete readback, and
failure without partial score mutation. Live rig acceptance remains pending.

- Add a server capture service that accepts exactly one normalized target id.
- Read persistent RNBO params from that instance's OSCQuery tree.
- Capture persistent list inports through the existing app-specific request/ACK
  path; report unsupported or timed-out list reads explicitly.
- Apply the snapshot control contract so probes, RTZ, panic, ACK, stage
  readbacks, and other momentary controls are excluded.
- Store enum params in the established semantic numeric representation.
- Record capture provenance and completeness diagnostics without making the
  source target the playback destination.
- Support an atomic convenience request that creates the clip, assigns it to a
  block/role, and fails without partial score mutation if capture fails.

Exit criterion: capturing ListSequencer, ListVelSequencer, and
AnalogSequencer produces three independent OSC clips that match each source
instance even if one editor was live-sending to all three.

### Phase D: Refactor Recall Around Layers

Status: implemented locally. Recall resolves each block layer through its OSC
clip and role assignment, reports block/role/clip/assignment/target identities,
keeps per-target ordering and cross-target concurrency, and independently skips
missing roles, missing clips, routing failures, app mismatches, and ignored
roles. Existing automatic entry idempotence and telemetry remain intact.

- Change recall compilation from `block.oscSnapshots[roleId]` to
  `block.oscLayers[roleId].clipId -> score.oscClips[clipId]`.
- Include block, role, clip, assignment, and resolved target in dry-run and
  recall diagnostics.
- Skip missing clips, missing roles, unassigned/offline instances, incompatible
  apps, and ignored assignments independently.
- Preserve current per-instance ordering, cross-instance concurrency,
  persistent/late/Clock ordering, telemetry, and automatic block-entry
  idempotence.
- Rename the prototype routes and WebSocket events to OSC-layer terminology.

Exit criterion: two roles in a block can recall different OSC clips to two live
instances, and reassigning either role changes only the runtime destination.

### Phase E: Replace Editor Snapshot UX

Status: streamlined locally across all seven bundled OSC editors after live rig
testing exposed capture ambiguity. The shared panel now presents PLAYING and
EDITING blocks, optional chase, focused-instance routing, and one Written or
Unspecified slot per structural block. A first write creates the focused
instance's clip/layer and a later write replaces it; missing layers remain
unspecified no-ops rather than implicit empty state. Multi-instance live sends
remain independent, capture safety follows the CHASE and PLAYING distinction,
and clip bookkeeping is available only under advanced tools. Browser and rig
acceptance of the streamlined presentation passed against the live wren and
finch setup.

The proposed next authoring refinement is separated into
[`osc-block-state-authoring-ui-plan.md`](osc-block-state-authoring-ui-plan.md).
It remains under workflow review and does not supersede the implemented Phase E
behavior until its save, Unspecified-slot, focus, onboarding, and copy questions
are resolved through prototype testing.

- Remove **Write snapshot to** and any path that serializes the editor's local
  draft directly into score state.
- Reuse the editor's single focused instance as the state source and derive its
  logical role rather than exposing role selection in the normal workflow.
- Present PLAYING, EDITING, and CHASE controls plus one Written or Unspecified
  state slot for every available structural block.
- Add **Write to block** with create-versus-replace labeling. While playback
  runs, CHASE prevents writing; with CHASE off, permit writing only when
  EDITING is different from PLAYING.
- Keep **Get state from** and **Send data to** as separate live-editor features;
  checked write targets must not influence capture.
- Keep clip browsing, assignment, and duplication available as advanced tools;
  normal editing addresses state by focused instance and structural block.
- Show capture completeness, source identity, routing, active block, and recall
  results close to the initiating control.

Exit criterion: the UI makes it impossible to mistake a multi-target editor
draft for a saved per-instance OSC clip.

### Phase F: Resource Mapping And Instance Onboarding

Status: onboarding and resource visibility are implemented locally.
Admin's device-first, instance-second form can now **Add to current score**
through one endpoint that captures a single online target and atomically creates
or reuses its logical role, OSC clip, and active-block layer. Repeating the same
stable device/app mapping replaces the existing captured clip rather than
creating duplicates. A normalized report and Admin view classify score roles
and discovered instances as mapped, compatible, offline, ambiguous, or
unmapped. Automatic onboarding is default-off and accepts explicit stable
role/app/device templates; discovery events mutate the score only for exactly
one online match, and otherwise return diagnostics without partial state. Live
rig acceptance remains pending.

- On score load, compare required logical roles with normalized discovered OSC
  targets and present mapped, compatible, offline, ambiguous, and unmapped
  resources in Admin.
- Change role creation to the device-first, instance-second flow already used
  by the revised Admin form.
- Add **Add to current score** for an unmapped instance. The operation creates
  or selects a logical role, captures the instance into a new OSC clip, assigns
  it to the active block, and maps the role to the instance.
- Auto-suggest stable role ids and clip names from app plus ordinal, never from
  a volatile RNBO instance number.
- Permit automatic onboarding only when policy is enabled and device/app/role
  identity is uniquely resolvable. Otherwise leave the instance visible and
  unmapped rather than mutating the score silently.
- Make onboarding idempotent so rediscovery or RNBO restart does not create
  duplicate roles or clips.

Exit criterion: a new AnalogSequencer on wren can be added to the current score
in one operation, then disappear and return under a new live instance number
without losing its logical role or block layer.

### Phase G: Score Initialization Workflow

Status: the API checkpoint is implemented. A declarative request document is
validated into an exact device-free score skeleton, previewed without mutation,
and applied in one revision-checked store swap. The plan reports players, note
clips, blocks, macro entries, OSC roles, and implicit Unspecified block/role
slots. Live device fields are rejected so discovery and onboarding remain a
separate phase. A four-player, six-section request document is checked in at
`config/score-initialization.four-player.json`. An Admin form remains deferred
until this API has been exercised in normal setup work.

- Add a declarative score-initialization request that can create players,
  sections/mesostructural blocks, macro order, note clips, loop lengths, OSC
  roles, and empty OSC-layer slots in one validated transaction.
- Represent common setups as request documents or named templates rather than
  hard-coding a single ensemble into Admin.
- Return a dry-run summary before mutation and make the create operation atomic.
- Keep rig discovery separate from structural initialization; discovered
  instances fill logical role mappings and OSC clips after the score skeleton
  exists.
- Provide a minimal Admin surface only after the API is stable. Codex-initiated
  setup can use the same public transaction rather than private store edits.

Exit criterion: a request can create a score with four players, six one-bar
loop sections, macro order, clips, and OSC role slots, after which discovered
instances can be onboarded without hand-editing JSON.

### Phase H: RNBO Staging And Boundary Accuracy

- Retain the selected client staging/commit protocol and current dense-recall
  telemetry work.
- Update supported RNBO exports only after the server recalls OSC clips through
  the new layer model, so staging work lands on the durable architecture.
- Verify staged commit across multiple sequencers with different payload sizes,
  including `Clock: 0`, silent patterns, and clock-on re-entry.

Exit criterion: independently captured instance clips activate on the same
shared block boundary without leaking next-block state into the outgoing block.

## Prototype Baseline Being Replaced

The phases below record the implemented prototype and its live timing evidence.
They are useful implementation inventory, not the target schema. Any reference
to block-owned `oscSnapshots` or saving an editor draft is superseded by Phases
A-H above.

### Phase 1: Contract And Fixtures

Status: implemented. The finalized version 1 contract is documented in
[`osc-snapshot-contract.md`](osc-snapshot-contract.md), enforced by the pure
contract helpers in `src/osc/snapshot-contract.mjs`, and represented by the
fixtures in `test/fixtures/osc-snapshot-contract.json`. The common sequencer
contract uses immediate suspension for `Clock: 0` and next-shared-beat arming
for `Clock: 1`.

- Finalize names for `oscAssignments` and `oscSnapshots`.
- Define the persistent-control allowlist/exclusion contract.
- Define the common sequencer `Clock` behavior in RNBO export documentation.
- Add representative score fixtures for parameter-only, list-based, clock-off,
  offline, unassigned, ignored, and unknown-control cases.
- Decide whether `Clock: 0` stops immediately or on a beat boundary and document
  the common export behavior.

Exit criterion: the schema and clock semantics can describe ListSequencer,
ListVelSequencer, AnalogSequencer, Plate, Poland, SoftPiano, and TTID without
embedding live addresses.

### Phase 2: Score Storage And Mutation APIs

Status: implemented. Initial scores and legacy normalization now provide empty
OSC collections; store, persistence, backup/restore, New Score, reset, block
duplication, HTTP, SSE change events, and WebSocket collaboration preserve and
mutate the version 1 documents. Snapshot writes increment structure revision;
OSC role assignment writes increment score revision without changing player
assignments.

- Extend initial-score creation, normalization, restore, reset, duplication,
  import/export, and persistence for OSC assignments and snapshots.
- Ensure duplicating a mesostructural block copies its OSC snapshots.
- Add store mutations and block-scoped HTTP routes with revision checks.
- Ensure old saved scores normalize with empty collections.
- Emit explicit score events for snapshot and OSC-assignment changes.

Exit criterion: snapshots survive restart, backup/restore, New Score, block
duplication, and collaborative score updates without requiring live hardware.

### Phase 3: OSC Role Assignment And Reconciliation

Status: implemented. The pure resolver operates on normalized `/osc/targets`,
matches unlocked roles by stable device identity plus app/editor capability,
preserves offline and unassigned mappings, rejects ambiguous multi-target
matches, never retargets locked roles, and exposes ignored roles as
non-sendable. Reconciliation is available explicitly and runs when registered
hardware or configured OSCQuery devices return. Admin manages these roles next
to OSCQuery devices without modifying block snapshots.

- Build OSC assignment resolution on normalized `/osc/targets` data.
- Reconcile returning targets by stable device identity and app/capability.
- Preserve offline and unassigned mappings.
- Mark multiple compatible targets ambiguous rather than choosing silently.
- Respect locked mappings and `ignoreRecall`.
- Add Admin UI alongside the existing client and OSCQuery device management.

Exit criterion: a role can be assigned, disappear, return with a changed RNBO
instance address, and resolve safely without modifying block snapshots.

### Phase 4: Snapshot Compiler And Best-Effort Dispatcher

Status: implemented. The compiler resolves semantic controls against the live
target, reports missing and excluded controls, and orders persistent params,
lists, late controls, then `Clock`. Dispatch groups work by target so separate
instances run concurrently while all writes to one instance remain ordered,
including multiple roles mapped to that instance. Manual recall supports role
filters and dry-run, records per-write send outcomes without field ACKs, and
keeps a bounded diagnostic history.

- Compile semantic param and input-port names against each resolved live target.
- Reject or report controls absent from the current export without failing
  other roles.
- Order non-clock params, lists, late state, then `Clock`.
- Dispatch roles concurrently while preserving per-instance ordering.
- Return structured attempted/skipped/failed results.
- Add `dryRun` support and bounded last-recall status for diagnostics.
- Do not add per-field ACK verification.

Exit criterion: a manually recalled block reliably produces the expected OSC
write order and useful failure reporting across mixed online/offline roles.

### Phase 5: First Editor Integration

Status: implemented for ListSequencer. Its mesostructural snapshot panel keeps
the live ACK/OSCQuery read source, checked immediate-send targets, block write
destination, and logical role as separate choices. It serializes numeric form
parameters and list inports without emitting OSC, can load saved state back into
the draft without sending, and uses the explicit block recall API for live
recall. The panel reports active block, saved/dirty state, assignment routing,
ignore policy, and the last recall summary. Pure serializer and served-route
tests cover payload validation and the browser assets.

- Add the shared snapshot controls to ListSequencer or ListVelSequencer.
- Serialize form values directly; use ACK readback only when the user chooses
  **Get state from**.
- Keep live read source, immediate write targets, block destination, and logical
  role visibly separate.
- Show active block and saved/dirty/last-recalled status.
- Add route/UI regression tests for the new controls and payloads.

Exit criterion: a user can hydrate or type a list pattern, save it to block
`F`, change the live process, and recall `F` from Shadowscore.

### Phase 6: Macro Playback Recall

Status: implemented. A score-event observer compares the macro occurrence key
(`macroIndex` plus block id) and queues one recall for each genuine entry. This
covers timer playback, JACK-derived playback, manual selection, advance, reset,
collaboration, and any other score mutation that actually changes the active
entry. Identical observations and block/snapshot edits are inert; repeated
occurrences of the same block at different macro indices remain distinct. The
queue serializes rapid entries, contains recall failures, and exposes pending
and last-result diagnostics beside the existing `SetStage` phase-alignment
status in playback responses.

- Invoke recall whenever the active mesostructural block changes through timer,
  JACK-derived playback, manual selection, advance, or reset.
- Make recall idempotent for repeated playback snapshots that do not represent
  a new block entry.
- Keep snapshot recall separate from ShadowScore note-transaction delivery and
  existing `SetStage` phase alignment, while reporting both in playback status.
- Ensure block edits do not accidentally recall state unless the user requests
  it or playback enters the block.

Exit criterion: automatic and manual block changes each cause one observable
snapshot recall, with ignored/offline roles reported rather than treated as
fatal playback errors.

### Phase 7: Clock Standardization And Lookahead

Status: baseline measured; client staging/commit selected, export work pending.
Recall history now records
encoded OSC payload bytes, per-write monotonic offsets and durations, and the
cross-target dispatch window; dry run reports planned payload size without
sending. ListSequencer shows byte and dispatch-duration summaries after manual
recall, and automatic playback diagnostics retain the same telemetry. The
current production behavior remains an ordered burst at observed block entry.

On 2026-07-15, `tools/measure-osc-snapshot.mjs` exercised two AnalogSequencers,
one ListSequencer, and one ListVelSequencer on wren with 128-item persistent
lists. Each recall sent 109 OSC writes / 12,812 encoded bytes. Across 20 runs,
dispatch was 72.8 ms minimum, 84.2 ms median, 133.5 ms p95, and 145.3 ms
maximum, with zero failed writes. The tool restored the original params and
lists, removed its temporary roles/snapshots, and left transport stopped.

At the measured 100 BPM, a roughly 150 ms lead window could finish this payload
before the next beat, but current parameter and list writes become audible
immediately and `Clock: 0` is an immediate suspension. A lead window therefore
cannot provide an exact block boundary without leaking next-block state into
the outgoing block. Phase-aligned production behavior selects standardized
client staging/commit; audible multi-client phase verification remains the
exit test after supported sequencer exports implement it.

The proposed RNBO-side transaction surface, pending/active behavior, metadata,
ACK statuses, Max project location, and acceptance tests are specified in
[`rnbo-osc-snapshot-staging-protocol.md`](rnbo-osc-snapshot-staging-protocol.md).

- Update the supported sequencer exports so `Clock: 1` arms for a shared
  next-beat activation and `Clock: 0` follows the agreed stop contract.
- Use boundary-burst timing measurements to choose a short lead window or a
  standardized client staging/commit protocol.
- If staging is required, ensure parameter and list writes do not affect the
  active process until the client commits them on the requested beat.
- Derive the upcoming boundary from the selected beat witness and send clock or
  commit controls after the snapshot payload.
- Quantize manual block changes when phase-aligned activation is requested.
- Verify that clock-off blocks, zero-step silent blocks, and clock-on re-entry
  retain their distinct musical behavior.

Exit criterion: multiple supported sequencers enter a clock-on block on the
same shared beat after receiving different amounts of snapshot data.

Repeat the baseline while transport is stopped with:

```sh
node tools/measure-osc-snapshot.mjs \
  --base-url http://wren.local:8790 \
  --oscquery-url http://wren.local:5678 \
  --block A --runs 20 --list-length 128
```

### Phase 8: Remaining Editors And Hardening

Status: implemented for every bundled OSC editor family. ListSequencer,
ListVelSequencer, AnalogSequencer, Plate, Poland, SoftPiano, and TTID now use the
same browser snapshot client and panel while retaining their instrument-specific
draft models and live read/write controls. Loading saved state mutates only the
form draft; saving remains offline-capable at the score API; explicit and
automatic recalls route through logical assignments. Persistent controls honor
the shared metadata/exclusion and late-order contract, and recall results expose
payload-size and dispatch-duration telemetry. A snapshot checksum ACK remains a
conditional follow-up only if live measurements demonstrate loss.

- Roll the snapshot section into AnalogSequencer, Plate, Poland, SoftPiano,
  TTID, and other supported editors.
- Extract a shared browser snapshot client only after two editor integrations
  reveal the stable interface.
- Add optional editor metadata for exclusions and late controls.
- Add payload-size and dispatch-duration telemetry.
- If real tests demonstrate loss, design one optional snapshot-level revision
  or checksum ACK rather than per-field verification.

Exit criterion: snapshot support is an editor-family capability, not a series
of incompatible one-off implementations.

## Verification Plan

### Store And API Tests

- new scores initialize top-level OSC clips and empty block OSC layers;
- OSC clip create, replace, reference-aware delete, duplicate, restore, and
  reset;
- block layer assign, replace, remove, duplicate, and missing-clip validation;
- expected-version and expected-structure-revision conflicts;
- offline and unassigned OSC clips and layers remain editable;
- assignments reconcile by stable identity;
- locked, ambiguous, and ignored assignments do not auto-route incorrectly.

### Capture Tests

- capture accepts exactly one live source target;
- OSCQuery parameter capture uses semantic names and excludes momentary state;
- list capture waits for the correct instance ACK and reports timeout/partial
  capture without borrowing another checked editor target;
- two instances of the same app produce independent OSC clips;
- capture-and-assign is atomic on failure;
- capture provenance never changes recall routing.

### Dispatcher Tests

- semantic names resolve to different OSC addresses per target;
- block layers resolve role to clip and clip to payload before live routing;
- instance fanout is concurrent;
- writes within an instance remain ordered;
- `Clock` is always last;
- `Clock: 0` is retained rather than filtered out;
- missing controls are reported per role/control;
- one failed target does not prevent other targets from receiving the recall;
- duplicate playback observations do not cause duplicate recalls.

### Live Tests

On the host and at least two RNBO clients:

1. Capture different parameter and list states from two instances into separate
   OSC clips and assign them to blocks `A` and `B`.
2. Run automatic macro playback and confirm each boundary produces the intended
   state change.
3. Take one target offline and confirm playback continues with a visible skip.
4. Bring it back with a changed instance id and confirm assignment
   reconciliation.
5. Enable `Ignore Shadowscore recall`, edit the instance manually, and confirm
   block changes leave it untouched.
6. Compare a `Clock: 0` block with a running zero-step block.
7. Re-enter a `Clock: 1` block on multiple sequencers and confirm audible phase,
   not only matching UI counters.
8. Measure snapshot size and dispatch completion time for the densest supported
   editor before deciding whether stronger acknowledgement is necessary.

## Non-Goals For The First Release

- Per-macro-occurrence overrides of a mesostructural block snapshot.
- Sample-accurate activation performed by the server itself.
- Field-by-field OSC acknowledgement and retry.
- Inferring saved state from the editor's checked live-send targets.
- Saving an editor draft as though it were confirmed instance state.
- Silent automatic score mutation when a discovered instance cannot be mapped
  unambiguously.
- Treating the RNBO Graph editor as a Shadowscore snapshot authoring surface.
- Combining ShadowScore player assignments with arbitrary OSC control-role
  assignments.
- Compatibility with the discarded `mesostructure.*.oscSnapshots` prototype
  schema or its routes/events.

## Recommended Delivery Sequence

Land the replacement in independently testable checkpoints:

1. replace the schema, store mutations, fixtures, persistence, and
   collaboration events;
2. add OSC clip and block-layer APIs;
3. refactor manual and automatic recall around role-to-clip layers;
4. implement single-instance capture for one list sequencer and
   AnalogSequencer;
5. replace the shared editor snapshot panel across bundled editors;
6. add Admin resource mapping and idempotent instance onboarding;
7. add atomic score initialization requests/templates;
8. finish RNBO staging/commit and audible multi-instance boundary tests.

The schema replacement should be the first checkpoint because no compatibility
or data migration work is required. Boundary-accurate RNBO export work remains
last so it builds on the durable clip/layer model rather than the discarded
prototype.
