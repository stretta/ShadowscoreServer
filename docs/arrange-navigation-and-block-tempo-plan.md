# Arrange, Navigation, And Block Tempo Development Plan

## Status

Implementation in progress.

- Phases 1–6 (Schema And Migration, Runtime Live Tempo Policy, Split Player And
  Arrangement Controls, Arrange Surface, Navigation Consolidation, Diagnostic
  Disclosure) are implemented locally and covered by the full server test
  suite.
- The Arrange surface includes the horizontal
  occurrence strip, drag and keyboard reorder, explicit performance controls,
  written/live tempo controls, duration-proportional occurrences, and the
  display-rate interpolated arrangement wiper. Visible occurrence move controls
  provide touch access, while selection remains independent of playback.
  Running traversal latches canonical arrangement edits until the next block
  boundary, and JACK look-ahead prepares the pending successor.
- Phase 7 source-first export, deployment, hardware smoke, and read-only live
  UI/API validation are complete. Transport-changing live acceptance remains
  pending explicit session authorization and a clean RNBO prepared-transaction
  acknowledgement.

## Goal

Simplify ShadowScore's user-facing information architecture and make arranging,
transport, and tempo feel like one coherent musical workflow.

The target experience is:

- `ShadowScore` groups the note and event editing surfaces.
- `Arrange` is the primary form, block, tempo, and transport workspace.
- `OSC` groups the OSC editors and related OSC tools.
- `Setup` groups system overview, routing, administration, and diagnostics.
- each block owns one written tempo;
- the performer can change tempo live and decide whether future block changes
  recall their written tempos;
- player note generation and arrangement movement have distinct, unambiguous
  controls;
- the arrangement is constructed by adding, assigning, dragging, and
  duplicating graphical block entries; and
- transport events remain available for diagnosis without occupying the normal
  performance surface.

## Settled Product Decisions

### Navigation

Use these primary navigation groups:

```text
ShadowScore ▾   Arrange   OSC ▾   Setup ▾
```

`ShadowScore` contains:

- Piano Roll
- Matrix
- Event List

These are complementary editing views over musical material. ShadowScoreClient
is the current playback destination, but the grouping must not assume that it
will remain the only destination.

`Arrange` is a direct top-level destination because it is the primary place to
construct and run the form.

`OSC` is the intentionally simple current name for:

- Analog Sequencer
- List Sequencer
- List Velocity Sequencer
- Poland
- Plate
- Soft Piano
- TTID
- OSC Volume
- OSC Macros

The menu may visually separate editors from tools, but they remain under one
top-level `OSC` label for now.

`Setup` contains:

- System Overview, currently called Dashboard
- player and client routing
- Admin
- Transport Status and diagnostics

The route `/` may remain the dashboard route initially. Navigation labels and
ownership can change before route compatibility is reconsidered.

### Arrange Replaces The User-Facing Structure/Transport Split

The current Structure Editor already contains block editing, song form, tempo,
cueing, section navigation, and macro Play/Stop. The current Transport page
contains another set of performance controls plus detailed diagnostics.

Create one musician-facing `Arrange` surface containing:

- the shared performance transport;
- live tempo and tempo-follow policy;
- the graphical block arrangement;
- the playing block and arrangement wiper;
- the selected block inspector;
- block duration, TTID, scale, written tempo, and player-to-clip assignments;
- add arrangement entry, create block, duplicate block, remove, and reorder
  actions; and
- an Advanced or Diagnostics entry point.

Keep the existing Transport Status capability as a Setup/Diagnostics surface.
This is a user-interface consolidation, not a merger of the underlying
transport, score-store, playback-snapshot, or diagnostic services.

### Two Distinct Playback Controls

There are two high-value playback operations:

```text
PLAYERS       [Play] [Stop]
ARRANGEMENT   [Run]  [Hold]
```

`Players Play/Stop` controls note generation for assigned playback clients,
including the standardized `Clock` control.

`Arrangement Run/Hold` controls movement through the block arrangement.

`Hold` is preferred to a second `Stop` because holding the arrangement leaves
the current block active while player note generation continues.

Default interaction rules:

- Players Stop sends `Clock: 0`, stops note generation, and holds arrangement
  movement at the current location.
- Players Play sends the required start, readiness, phase, recall, and
  `Clock: 1` operations, then respects the selected arrangement mode.
- Arrangement Hold never stops player note generation.
- Arrangement Run resumes form movement from the held block and beat anchor.
- Return to Start changes location; it is not another Stop operation.
- Previous, Next, Cue, and Return to Start belong to the Arrangement control
  group.
- silently running the arrangement while Players are stopped is not a primary
  workflow. If later required, it belongs behind an advanced control.

The UI must render the combined state in words, for example:

```text
Players playing · Arrangement held on B
```

### Tempo Is A Static Block Attribute

Do not add a tempo track, tempo event list, or per-occurrence tempo automation.

Each mesostructural block owns one positive finite `tempo` value:

```json
{
  "mesostructure": {
    "A": {
      "tempo": 120,
      "duration": { "bars": 4 },
      "ttid": 2741,
      "players": {}
    }
  },
  "macrostructure": {
    "blocks": ["A", "B", "A"]
  }
}
```

Every occurrence of block `A` therefore has the same written tempo. To create a
related block at a different tempo, the user duplicates the block and edits the
duplicate:

```text
A at 120 BPM → duplicate as A1 → set A1 to 96 BPM
```

This is intentionally less flexible than a tempo track. The constraint makes
tempo behavior visible and keeps tempo aligned with the other written block
attributes.

`macrostructure.tempo` is removed from the canonical model after migration.
Macrostructure continues to own only ordered block occurrences.

### Written Tempo And Live Tempo

The UI exposes two related but distinct values:

- Written tempo: `mesostructure[blockId].tempo`.
- Live tempo: the effective tempo currently governing transport.

Expose a musician-facing control similar to:

```text
TEMPO  [108.0 BPM]   Follow Block Tempo [on]
Written for B: 96 BPM
```

`Follow Block Tempo` is runtime transport policy, not score content.

Behavior:

- changing Live Tempo updates the effective transport tempo immediately;
- with Follow Block Tempo on, a live adjustment lasts for the remainder of the
  current block and the next block recalls its written tempo;
- with Follow Block Tempo off, live tempo remains latched across block changes;
- enabling Follow Block Tempo while a block is already playing does not cause
  an unannounced immediate jump;
- after enabling it, the next block boundary recalls written tempo;
- provide `Use Block Tempo Now` for an intentional immediate recall;
- editing a block's Written Tempo changes canonical block data but does not
  silently change the live tempo;
- when the edited block is active and following is enabled, the UI offers an
  explicit `Use Block Tempo Now` action.

The live display must show both values whenever they differ. It must also show
the effective source using musician-facing language such as `Block`, `Manual`,
or `External`, while retaining JACK/Link/server details in diagnostics.

### Reuse An Existing Block Or Duplicate It

There is no dedicated Repeat command.

`Add to Arrangement` creates another arrangement entry and lets the user assign
any existing block ID, including an ID already used elsewhere in the
arrangement. Multiple entries assigned to the same block share all block
attributes, including tempo.

`Duplicate` retains the existing block-duplication behavior:

- create a new mesostructural block;
- copy the source block attributes and player assignments;
- create independent copies of the assigned ShadowScore note clips;
- retain the currently copied OSC-layer references;
- do not invoke OSC Block State duplication;
- do not add the new block to the arrangement; and
- select the new block for inspection.

The only duplication behavior change in this plan is the editable default name
suggestion.

Default duplicate naming uses the source's family and the next available
positive integer as an editable UI suggestion:

```text
A       → suggest A1
A again → suggest A2 when A1 exists
A1      → suggest A2
Verse   → suggest Verse1
Verse7  → suggest Verse8
```

The Arrange UI helper:

- strip a trailing positive integer to find the family root;
- increment an existing suffix, or start an unsuffixed source at `1`;
- skip IDs already present in the currently loaded score;
- put the suggestion into the existing editable duplicate-name prompt; and
- send the user's final explicit ID through the existing duplicate endpoint.

No server-side name allocator or duplicate API redesign is required. The server
continues to validate that the submitted target ID is available. If another
change makes the suggested ID stale, the normal collision error is sufficient
and the user can choose another name.

From the graphical arrangement:

- Add to Arrangement inserts a new entry and assigns an existing block ID
  selected by the user. Choosing the same ID is how a block is repeated.
- Duplicate clones the selected block definition and selects the new block for
  inspection.
- Duplicate does not alter the arrangement. The user adds and assigns the new
  block through the same Add to Arrangement workflow used for every other
  occurrence.

Use distinct labels for the three creation operations:

- `Add to Arrangement`: create an occurrence that references an existing block;
- `New Block`: create a new blank block definition; and
- `Duplicate Block`: use the existing block and ShadowScore-clip duplication
  behavior with a source-derived default name.

### Graphical Arrangement And Wiper

Adapt the interaction model from
`/Users/mdavidson/Documents/Max 9/Library/reorder_bliocks.js`:

- horizontal colored blocks;
- pointer drag to reorder;
- clear selection while pressed;
- add, duplicate, remove, and inspect actions; and
- immediate visual feedback.

Browser-specific rules:

- block width is proportional to musical duration, subject to a readable
  minimum width;
- repeated occurrences are separate draggable items even though they reference
  the same block ID;
- occurrence identity in the UI must not rely on block ID alone;
- the persisted arrangement may remain `macrostructure.blocks` unless stable
  occurrence metadata becomes necessary;
- dragging previews the new order locally;
- canonical arrangement order is saved once on drop, not on every pointer
  movement;
- keyboard reordering and touch interaction are required, not follow-up
  accessibility work;
- selection and playback highlighting are independent;
- the freewheeling wiper is an overlay and does not cause arrangement layout
  redraws;
- the wiper consumes `/playback/snapshot`, anchors to authoritative beat,
  tempo, block, and observation time, and interpolates with
  `requestAnimationFrame`;
- it re-anchors on start, stop, seek, block change, tempo change, stale
  observation, and large correction; and
- arrangement edits made during playback autosave canonically but do not move
  the active traversal underneath the performer. The running traversal adopts
  the changed order at the next safe block boundary.

### Transport Events Are Diagnostic

The `Events` section on Transport Status is the early-debugging display meant
here. It is unrelated to the Event List editor.

Retain the `/transport/events` event stream and recent bounded log, but move the
display under a closed disclosure:

```text
Transport Diagnostics ▾
  ...
  Recent Transport Events ▾
```

The event connection may remain active while the disclosure is closed so the
recent log is already populated when opened. Connection failures should affect
only the diagnostic indicator, not the primary transport status.

## Target Data Model

### Canonical Score

```json
{
  "mesostructure": {
    "A": {
      "tempo": 120,
      "duration": { "bars": 4 },
      "scale": {},
      "ttid": 2741,
      "players": {},
      "oscLayers": {}
    }
  },
  "macrostructure": {
    "blocks": ["A"]
  }
}
```

Tempo validation belongs with mesostructural block normalization and mutation.
The UI may constrain ordinary input to 20–400 BPM. The server contract must at
minimum require a positive finite value and return a clear validation error.

### Runtime Transport State

Expose effective tempo policy in the aggregate transport/playback snapshot:

```json
{
  "tempo": {
    "live": 108,
    "written": 96,
    "followBlockTempo": false,
    "source": "manual",
    "activeBlockId": "B"
  }
}
```

This state is not stored inside the score. The service default is
`followBlockTempo: true`. A configuration default may be added if a host needs
a different startup policy, but live performance changes remain runtime state.

### Migration

Existing scores store one `macrostructure.tempo`. During load/restore/import:

1. read the existing macrostructure tempo, falling back to the configured
   transport tempo and then 120;
2. assign that value to every mesostructural block that does not already have a
   valid tempo;
3. preserve any block tempo already present;
4. remove `macrostructure.tempo` from the normalized canonical score; and
5. persist the normalized result through the existing migration path.

This produces no musical change for existing scores because all blocks inherit
the former global tempo.

Exports, initialization requests, fixtures, and documentation must use
block-owned tempo after the migration. There is no mixed long-term mode in
which some runtime paths continue to prefer `macrostructure.tempo`.

## Transport And Playback Semantics

### Effective Tempo

Use one resolver everywhere:

```text
effectiveTempo =
  live manual tempo, when Follow Block Tempo is off
  current block written tempo, after a followed block entry
  current live tempo, after an in-block manual adjustment
  configured fallback only when no valid runtime or block tempo exists
```

The resolver must feed:

- JACK tempo writes;
- timer-mode duration and rescheduling;
- playback snapshot tempo;
- wiper interpolation;
- apply-next-beat transition guards;
- RNBO activation confirmation timing;
- transport status BPM; and
- any block-duration-in-milliseconds calculation.

No runtime path should read `macrostructure.tempo` after migration.

### Block Entry

When arrangement movement enters a block:

1. make the new block and macro index authoritative;
2. if Follow Block Tempo is on, adopt the new block's written tempo;
3. write the adopted tempo to the configured live tempo authority;
4. perform the existing block preparation, OSC recall, TTID distribution,
   activation, phase alignment, and Clock policy in their required order; and
5. publish one coherent playback snapshot containing the new block and
   effective tempo.

The implementation must define and test the exact boundary order. UI work must
not hide a transition where the block changes before its tempo is applied.

### Timer Mode

Timer mode currently derives milliseconds from macrostructure tempo. Change it
to use effective live tempo.

A live tempo change while timer playback is running must re-anchor from current
musical progress and reschedule the remaining duration. It must not restart the
block or apply the new BPM only after an obsolete timeout fires.

### Beat-Derived Mode

Beat-derived arrangement position remains based on authoritative musical beat,
not elapsed wall-clock time. A tempo change changes the rate at which future
beats arrive; it does not rewrite the current composition-beat position.

## API Direction

Retain the existing facade and lower-level diagnostic routes. Add or refine:

```text
POST /transport/players/play
POST /transport/players/stop
POST /transport/arrangement/run
POST /transport/arrangement/hold
POST /transport/tempo
POST /transport/tempo/follow-block
POST /transport/tempo/use-block
```

The current `/transport/play` and `/transport/stop` routes may remain
compatibility facades whose behavior matches Players Play/Stop plus the default
arrangement policy.

Suggested request shapes:

```json
{ "bpm": 108 }
```

```json
{ "follow": false }
```

All mutations return the aggregate transport state so every editor can render
the same result without reconstructing policy from low-level responses.

For duplication:

```text
POST /mesostructure/:sourceBlockId/duplicate
```

Keep the existing request contract: `blockId` is the explicit target name. The
Arrange UI supplies an editable suggestion such as `A1`; the server validates
and creates that requested ID. Duplication does not insert an arrangement
occurrence and does not automatically call `/osc/block-state/duplicate`.

## Shared Navigation Implementation

The current route tabs are copied into multiple standalone pages, which has
already allowed individual OSC pages to omit Transport.

Replace page-owned navigation lists with one shared navigation definition and
renderer. Requirements:

- one source of truth for menu labels, routes, group membership, and ordering;
- current-page indication;
- mouse, keyboard, and touch operation;
- menus open by activation and focus, not hover alone;
- compact mobile behavior;
- no dependency on an external font or framework;
- pages remain usable if the menu script fails; and
- Matrix Edit changes occur in its source repository before exporting the
  server bundle.

The first navigation pass changes information architecture and labels. It does
not need to rename every HTTP route.

## Implementation Phases

### Phase 1: Schema And Migration

- add required block tempo defaults and normalization;
- migrate macrostructure tempo into blocks;
- remove canonical macrostructure tempo;
- update persistence, restore, initialization, fixtures, and API docs;
- verify the existing structured block copy naturally carries the new tempo
  attribute;
- update the Structure/Arrange duplicate prompt to suggest source-derived
  names; and
- test legacy-score migration and collision behavior.

Acceptance:

- every normalized block has a valid tempo;
- existing scores sound unchanged immediately after migration;
- canonical output no longer contains `macrostructure.tempo`;
- the duplicate prompt suggests `A1`, then the next available A-number, while
  remaining editable; and
- all other block-duplication behavior remains unchanged.

### Phase 2: Runtime Live Tempo Policy

- add runtime live tempo and Follow Block Tempo state;
- create the effective-tempo resolver;
- update JACK, timer, RNBO timing, transition guards, snapshots, and status;
- add tempo control endpoints;
- re-anchor timer playback on live tempo changes; and
- test block-boundary adoption with following on and off.

Acceptance:

- live tempo changes are immediately audible/observable;
- manual tempo survives block changes only when following is off;
- the next block recalls written tempo when following is on;
- score editing never silently changes live tempo; and
- all user-facing BPM displays agree with the playback snapshot.

### Phase 3: Split Player And Arrangement Controls

- introduce Players Play/Stop and Arrangement Run/Hold facade commands;
- preserve the existing lower-level services;
- define coherent aggregate state and error reporting;
- update shared transport controls; and
- verify stop, hold, resume, cue, next, and return behavior.

Acceptance:

- Hold keeps the current block sounding;
- Players Stop silences assigned players and holds location;
- Players Play resumes with the selected arrangement mode;
- controls never present two unexplained Play/Stop pairs; and
- Matrix, Piano Roll, OSC editors, and Arrange consume one aggregate state.

### Phase 4: Arrange Surface

- evolve Structure Editor into Arrange;
- add the graphical arrangement strip;
- implement drag reorder, Add to Arrangement, New Block, Duplicate Block,
  Remove, and keyboard actions;
- add written and live tempo controls;
- add the interpolated wiper;
- retain the selected block inspector and assignments; and
- move low-level transport state to diagnostics.

Acceptance:

- a user can construct and reorder a form without editing numbered selects;
- repeated references and independently duplicated blocks are visually
  distinguishable;
- the wiper remains smooth under the normal snapshot cadence;
- a drop causes one canonical order write;
- active traversal is stable during live edits; and
- mobile and keyboard workflows are complete.

### Phase 5: Navigation Consolidation

- implement the shared grouped navigation;
- put Piano Roll, Matrix, and Event List under ShadowScore;
- expose Arrange directly;
- put all listed editors/tools under OSC;
- put System Overview, routing, Admin, and Transport Status under Setup; and
- update route tests to cover every hosted page.

Acceptance:

- all user-facing pages render the same four primary groups;
- no OSC editor can independently omit a destination;
- current-page state is correct;
- menus work with pointer, touch, and keyboard; and
- existing URLs continue to resolve.

### Phase 6: Diagnostic Disclosure

- move Recent Transport Events inside the closed Transport Diagnostics area;
- keep the bounded event log and connection status;
- ensure failure is non-blocking; and
- update route/static UI tests.

Acceptance:

- Events do not occupy the normal transport viewport;
- opening the disclosure shows recent events immediately; and
- Event List navigation and semantics are unchanged.

### Phase 7: Source-First Export, Deployment, And Live Validation

- make Matrix Edit navigation changes in the Matrix Edit source repository;
- commit source before exporting to `public/matrix-edit`;
- verify clean build provenance;
- run focused and full server tests;
- deploy to `wren.local`;
- verify served pages, navigation, tempo behavior, duplication, arrangement
  hold/run, player stop/play, OSC recall, and wiper behavior; and
- leave live transport safely stopped after validation.

Implementation checkpoint, 2026-07-24:

- Matrix Edit source commit `cd73e5e` was exported with clean provenance before
  the server deployment;
- server commit `30e0069` was deployed from a clean detached worktree to
  `wren.local`, excluding unrelated local OSC editor changes;
- the service restart, standard route checks, `/structure-editor`,
  `/transport/status`, and the hardware smoke test passed;
- live read-only UI validation confirmed grouped deep-link navigation,
  duration-sized and keyboard-labeled arrangement occurrences, separate
  stopped Players and held Arrangement state, external live tempo distinct from
  written block tempo, a closed diagnostic disclosure, and an eight-entry
  event buffer that continues updating while closed;
- JACK remained rolling independently while Players were stopped and
  Arrangement was held, so no transport-changing action was issued; and
- both RNBO targets were online and fresh, but their prepared score updates
  remained `saved-not-active` because post-restart preparation received
  transaction IDs ahead of the server expectation. At that checkpoint, live
  player, arrangement, OSC recall, and wiper motion scenarios remained an
  explicit authorized-session validation task.

Hands-on continuation, 2026-07-24:

- the earlier RNBO acknowledgement failure was traced to the audio device
  disappearing and stopping JACK/DSP processing; after the device and JACK
  returned, both clients again produced matching READY and ACTIVE
  acknowledgements;
- the operator confirmed Return to Start, Players Play with Arrangement Run,
  arrangement-wiper movement, block advance, Arrangement Hold while player
  stages continued, Arrangement Run resume, and Players Stop; and
- Players Stop currently sends `Clock: 0` only to assigned ShadowScore playback
  clients. It does not override `Clock` on clock-capable OSC roles such as
  Analog Sequencer. Treat global OSC-instrument stopping as a documented
  follow-up decision rather than silently changing block-owned snapshot state;
- written tempos A=90, B=60, C=144, and D/E/F=120 were confirmed canonical,
  but Follow Block Tempo initially left Link/JACK at 90 across B and C. The
  server had been attempting a JACK transport reposition, which the active
  `jack_transport_link` timebase immediately superseded; and
- Link-authority tempo application now requests BPM through
  `jack_transport_link`'s JACK metadata property
  `http://www.x37v.info/jack/metadata/bpm`. Direct JACK reposition remains the
  behavior only when the server itself is configured as tempo authority; and
- live follow-tempo testing then exposed `jack_transport_link` rewriting JACK
  BBT backward while adopting the requested BPM. That briefly re-entered the
  preceding arrangement block and created a tempo-recall feedback loop.
  Beat-derived arrangement playback now preserves a monotonic composition beat
  across those Link BBT discontinuities; and
- the operator confirmed on the deployed fix that arrangement transitions no
  longer bounce backward while Follow Block Tempo changes the live BPM; and
- the operator confirmed that `Use Block Tempo Now` immediately adopts an
  edited written tempo for the active playing block. A selected non-playing
  block remains an editing context and is not treated as a live-tempo audition.

## Test Matrix

### Data And Migration

- new score defaults give every block tempo 120;
- legacy global tempo 96 becomes tempo 96 on every block;
- a pre-existing block tempo is preserved during migration;
- invalid block tempo is rejected;
- macrostructure order can reference the same block more than once without
  copying it;
- duplicated block tempo is independent after editing;
- A duplicates to A1, then A2;
- A1 duplicates to A2 when free and skips to A3 when occupied;
- the suggested target remains editable;
- explicit target naming still works; and
- a stale or conflicting target receives the existing collision error.

### Live Tempo

- adjust live tempo while stopped;
- adjust live tempo while Players are playing and Arrangement is held;
- adjust live tempo during timer-mode arrangement movement;
- adjust live tempo during beat-derived arrangement movement;
- cross a block boundary with Follow Block Tempo on;
- cross a boundary with it off;
- enable following mid-block and confirm no immediate jump;
- invoke Use Block Tempo Now;
- edit active block written tempo without changing live tempo; and
- confirm snapshot, transport display, Piano Roll wiper, Matrix wiper, and
  arrangement wiper agree.

### Playback Controls

- Players Play plus Arrangement Run;
- Players Play plus Arrangement Hold;
- Players Stop while running;
- Arrangement Hold while players continue;
- resume arrangement from hold;
- cue and return while held;
- offline or partially ready clients; and
- repeated start/stop actions remain idempotent.

### Arrange Editing

- drag unique blocks;
- drag repeated occurrences;
- add another arrangement entry assigned to an already-used block ID;
- duplicate a block without changing arrangement order;
- add the new duplicated block to the arrangement explicitly;
- remove one repeated occurrence without deleting the block;
- delete an unreferenced block;
- edit while stopped;
- edit while running near a block boundary;
- keyboard reorder;
- touch reorder; and
- narrow viewport overflow.

### Navigation And Diagnostics

- every hosted HTML surface has the same menu groups;
- direct deep links correctly mark their group/current item;
- menus are keyboard navigable;
- Transport Status is reachable under Setup;
- Events disclosure defaults closed;
- event logging continues while closed; and
- Event List remains under ShadowScore and is never labeled diagnostic.

## Primary Impacted Areas

Expected implementation areas include:

- `src/state/score-store.mjs`
- `src/state/score-initialization.mjs`
- `src/state/persistence.mjs`
- `src/playback/macro-playback.mjs`
- `src/playback/playback-snapshot.mjs`
- `src/http/routes.mjs`
- `src/http/transport-page.mjs`
- `public/structure-editor/index.html`
- `public/shared/`
- `public/piano-roll/`
- `public/editors/`
- Matrix Edit source followed by `public/matrix-edit/` export
- score, route, playback, persistence, static-page, and OSC editor tests
- README, operator guide, initialization API, and data-format documentation

## Non-Goals

- no tempo track;
- no tempo automation curve;
- no per-occurrence tempo override;
- no immediate HTTP route-renaming requirement;
- no removal of low-level transport or event diagnostics;
- no redefinition of Event List as a diagnostic page;
- no change to OSC as the chosen temporary navigation label; and
- no increase in playback snapshot polling cadence solely for wiper animation.

## Completion Criteria

The work is complete when a performer can:

1. open Arrange from the primary navigation;
2. see and manipulate a graphical block form;
3. reuse an existing block ID without invoking Duplicate;
4. duplicate A as A1 without manually inventing a name;
5. assign a written tempo to each block;
6. adjust live tempo without rewriting the block;
7. choose whether the next block recalls written tempo;
8. hold arrangement movement while the current block continues producing
   notes;
9. stop all assigned player note generation with an unambiguous control;
10. reach ShadowScore editors, OSC editors, and Setup tools through stable
    grouped menus; and
11. open transport events only when diagnostics are needed.
