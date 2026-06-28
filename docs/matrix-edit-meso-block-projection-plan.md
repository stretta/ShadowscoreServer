# Matrix Edit Meso-Block Projection Plan

## Goal

Reframe Matrix Edit as a meso-block performance workspace. It should show the
current editable block as an ensemble projection of assigned clips, including
loop aliases, while Event List remains the canonical clip editor and Structure
Editor owns block/player assignments.

## Design Boundaries

- Event List is the canonical editor for clip contents and exact event
  attributes.
- Structure Editor owns section/block definition, player assignment, clip
  assignment, block duration, and loop/one-shot behavior.
- Matrix Edit answers: "what does this meso block look like for the ensemble?"
- Matrix Edit may edit clip data, but it does so through the block-time
  projection of assigned clips.
- Repeated material must be visibly derived, but still feel active and playable.

## Phase 1: Define The Projection Model

Name the Matrix Edit surface as a block projection or meso-block projection in
code and documentation.

Define the rendering concepts:

- Source occurrence: the first visible instance of a clip's authored material.
- Loop alias: repeated material derived from the same clip events.
- One-shot remainder: empty block time after a non-looping clip ends.

Confirm edit semantics:

- Editing a source occurrence edits the clip.
- Editing a loop alias edits the same underlying clip event modulo clip length.
- A later "materialize alias" command can copy repeated material into
  independent clip data if that becomes necessary.

## Phase 2: Simplify The Matrix Header

Replace the upper area with a compact operational header centered on the
performer's current context:

- Playing block
- Editing block
- Selected player
- Assigned clip
- Playback state

Rules:

- If the playing block and editing block match, show and move the wiper.
- If they do not match, freeze or hide the wiper and clearly show that playback
  is on a different block.
- Move deep clip-inspection controls out of the main header.
- Provide a direct path from Matrix Edit to Event List for canonical clip
  inspection.

## Phase 3: Render The Block-Time Projection

For each player lane in the selected meso block:

1. Read the block duration from the timing contract or selected block duration.
2. Read the player's assigned clip.
3. Render clip events into the block timeline.
4. For one-shot clips, render only events within the clip's actual span.
5. For looping clips, repeat events across the full block duration.

Each projected event or cell should carry occurrence metadata:

- Source clip id
- Source event id
- Occurrence index
- Source clip time
- Projected block time
- Alias status

## Phase 4: Differentiate Repeated Material

Render aliases with a quiet secondary treatment:

- First occurrence uses the normal enabled-cell style.
- Repeated aliases use the same color family with lower visual emphasis.
- Repeat-cycle boundaries are subtle but visible.
- A small loop/repeat mark may appear at the start of each repeated cycle.

Aliases should not look disabled. They are active playback material, just
derived from clip data.

## Phase 5: Define Interaction Rules

- Hovering or selecting an alias should reveal that it maps back to clip time.
- Clicking an alias should select the underlying source event while preserving
  projected occurrence context.
- Editing an alias should update the source clip and immediately update all
  visible aliases.
- Deleting an alias should be treated as deleting the underlying source event,
  with an explicit affordance or confirmation if needed.
- Materializing an alias into independent data is deferred until there is a
  clear workflow need.

## Phase 6: Align Structure Editor Language

Update Structure Editor language and workflow around:

- Section or block selection
- Player assignment
- Clip assignment
- Loop vs one-shot behavior
- Block duration

Structure Editor should support the workflow "I am player 1 and I am working on
section A" rather than centering the workflow on directly editing a clip id.

## Phase 7: Verification Scenario

Use a score with:

- Block A: 16 beats
- Player 1: 4-beat looping clip
- Player 2: 8-beat looping clip
- Player 3: 6-beat one-shot clip

Verify:

1. Playback on A while editing A moves the wiper.
2. Playback on B while editing A does not move the wiper.
3. Loop aliases are visible across the block timeline.
4. One-shot material leaves the remainder of the block empty.
5. Editing an alias updates every repeated occurrence.
6. Event List still shows canonical clip data without projected aliases.
7. Structure Editor shows assignments and durations using block/player language.

### Verification Notes

- 2026-06-28 on `wren.local`: deployed the current Matrix Edit bundle and
  Structure Editor static page, then restored a temporary score with block A at
  16 beats.
- Player 1 used a 4-beat looping clip and Matrix Edit reported
  `6 aliases mapped` while playing and editing A.
- Player 2 used an 8-beat looping clip and Matrix Edit reported
  `2 aliases mapped`.
- Player 3 used a 6-beat one-shot clip and Matrix Edit reported no aliases.
- Switching the live playhead to B while keeping Matrix Edit on A reported
  `Playback on B; wiper hidden`.
- Event List and Structure Editor routes were verified live after deployment.
- Alias edit mapping is covered by the projection unit tests; live browser
  verification focused on served bundle behavior and projection state.

## Implementation Order

1. [x] Simplify the Matrix Edit header and wiper rules.
2. [x] Add projection metadata internally with minimal visual change.
3. [x] Add alias rendering treatment.
4. [x] Add alias selection and edit behavior.
5. [x] Tighten Structure Editor labels and workflow.
6. [x] Update docs and tests.
