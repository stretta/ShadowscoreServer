# Piano Roll Orchestration Plan

## Implementation Status

The initial condensed-score orchestration slice is implemented. Piano Roll
autosaves completed note gestures, preserves recoverable drafts and Revert, and
supports Alt-click, browser context-menu, and keyboard access to **Move to...**.
The atomic server transaction handles existing destination clips, creates and
assigns missing parts, protects shared clips, preserves expressive note fields,
and rejects stale or broken references. The actions in **Deferred Actions**
remain unimplemented.

## Intent

Evolve the Piano Roll from a focused clip editor into a condensed-score
orchestration surface. A musician should be able to see the notes assigned to
every player in the current block and redistribute musical material without
leaving the score view.

The first delivered action is:

1. Alt-click, right-click, or invoke the keyboard context menu on a note.
2. Open `Move to...`.
3. Choose an ensemble player.
4. Move the source note into that player's clip in the current block.

The contextual menu is deliberately extensible. Later actions may include
`Double with...`, Cut, Copy, Delete, and exact-field editing, but the first
implementation must not imply those semantics before they are designed.

## Product Model

Treat the Piano Roll as a condensed score, not as an isolated clip canvas.
Every visible note has provenance:

- source block;
- source player;
- source clip;
- source note index and `note_id` when present; and
- projected occurrence when a looped clip repeats across the block.

The source note remains the editable object. Clicking a projected loop alias
must resolve to its original source note rather than creating or moving the
rendered occurrence.

`Move to...` is an exclusive orchestration assignment. It removes the note
from the source clip and inserts it into the destination player's clip. Future
doubling must use a distinct action because it preserves the source note.

## Player And Clip Resolution

The destination menu represents the ensemble roster, not only players that
already have a clip in the current block.

For each player:

- If the current block assigns a valid destination clip, move into it.
- If the player exists in the ensemble but has no clip in the current block,
  show `create part`; choosing it creates and assigns a destination clip as
  part of the same transaction.
- If the block assignment references a missing clip, disable the destination
  and report the broken reference. Do not silently replace potentially lost
  score data.
- If source and destination resolve to the same clip, show an already-present
  no-op state.
- If the player does not exist in the ensemble, player creation belongs in
  Setup rather than the note menu. When no destination players exist, provide
  an `Add players in Setup...` path. Broken block assignments link to Arrange
  for repair.

An automatically created part uses a predictable clip ID based on block and
player, made unique if that ID already exists. It inherits the source clip's
duration, playback type, context, and behavior, but begins with no notes before
the moved note is inserted. This keeps timing and playback semantics aligned
with the material being orchestrated.

## Shared Clip Safety

Clips are reusable score objects. Moving a note out of a source clip or into a
destination clip can therefore affect more than the visible block/player
pair.

Before mutation, collect every block/player reference to both clips. If either
clip is shared outside the selected source and destination, require explicit
confirmation that names all affected score locations. The server must also
require a shared-edit confirmation flag so a client cannot bypass the guard
accidentally.

Do not silently duplicate and reassign a shared clip. That would change score
topology and obscure whether the composer intended the sharing.

## Atomic Mutation Contract

Moving a note is one revision-aware score transaction. It may include:

- removing the note from the source clip;
- creating a destination clip;
- assigning that clip to the destination player in the current block; and
- inserting the note into the destination clip.

All changes succeed or none do. Two independent `/clips/:clipId` replacements
are not acceptable because a stale revision or interrupted request could leave
a duplicate note, a lost note, or an unassigned part.

The request identifies the note with both source index and `note_id` when
available and includes the expected score version. The server validates:

- the block, source player, destination player, and source clip exist;
- the source player is assigned to the source clip in the selected block;
- the note identity still matches the expected source index;
- source and destination clips are different;
- shared-clip edits were explicitly confirmed; and
- the destination clip reference is valid or absent.

The moved note preserves every musical and expressive field. Preserve
`note_id` when it is unique in the destination clip; allocate a new numeric ID
only when the target already contains the same identity or the source had no
identity.

Creating and assigning a destination clip increments the structure revision.
A move between two existing assigned clips changes only the score revision.
The mutation event must identify both clips so live RNBO delivery refreshes all
players that reference either changed clip.

## Draft And Conflict Handling

The Piano Roll currently autosaves revision-aware clip drafts. Before an
orchestration transaction, allow pending autosaves to settle. If any involved
draft becomes stale or cannot save, keep the menu operation from running and
surface the conflict.

After a successful move:

- reconcile all open drafts against the returned score;
- keep the current block and focused player in place;
- remove the note from its source color and render it in the destination
  player's color immediately; and
- announce the completed move in the status region.

The editor should not jump to the destination player. Remaining in the
condensed view supports rapid orchestration across a passage.

## Contextual Menu Interaction

The menu opens on Alt-click (`event.altKey`) before pointer capture or dragging
begins. Also support the browser `contextmenu` gesture and the keyboard Context
Menu / Shift+F10 path.

The menu contains:

- a header naming the clicked pitch, onset, source player, and source clip;
- a top-level `Move to...` action with a player submenu; and
- a future-safe action list that can grow without changing note hit testing.

Close the menu on outside pointer-down, Escape, selection, block/clip context
change, or score refresh. Keep it inside the viewport and provide menu roles,
focus movement, and disabled explanations.

Regular click/drag behavior remains unchanged. Alt-click must return before
pointer capture so it can never begin a move or resize gesture.

## Condensed-Score Hit Testing

Ordinary editing gestures continue to target the focused clip. Contextual
orchestration hit testing covers source notes for every player visible in the
current block, including projected loop occurrences.

Hit ordering should match paint ordering: focused notes are considered above
reference notes, and later deterministic candidates win when notes overlap
exactly. The menu header exposes the chosen provenance. A future overlap picker
can replace this deterministic fallback without changing the transaction API.

## Initial Implementation Phases

### Phase 1: Transaction And Pure Resolution Helpers

- Add pure condensed-score occurrence and destination-resolution helpers.
- Add an atomic score-store note-move method.
- Add a revision-aware HTTP route for the transaction.
- Extend score-mutation impact analysis to both changed clips.
- Cover existing destination, automatic part creation, identity collision,
  stale revision, broken references, and shared-clip protection.

### Phase 2: Contextual Menu

- Add Alt-click and context-menu hit testing across visible player clips.
- Add the extensible menu shell and `Move to...` submenu.
- Show ready, create-part, no-op, and broken-reference destination states.
- Flush pending autosaves before sending the orchestration request.
- Reconcile the returned score without changing the focused player.

### Phase 3: Verification And Live Test

- Run focused core, score-store, route, mutation-impact, and static UI tests.
- Run the complete Node test suite and syntax/diff checks.
- Deploy the host application to `wren` through the repository deployment
  workflow.
- Verify `/piano-roll`, `/healthz`, service state, the live transaction route,
  and hardware smoke from the host without changing transport state.

## Acceptance Criteria

- Alt-clicking a focused or reference note opens a menu without dragging it.
- The menu identifies the note's source player and clip.
- Every ensemble player appears with an accurate destination state.
- Moving to an assigned player removes one source note and adds one destination
  note in a single score revision.
- Choosing `create part` creates, assigns, and populates the new part atomically.
- Expressive note fields survive the move.
- A destination `note_id` collision is resolved without overwriting a note.
- Shared clips require explicit confirmation.
- Stale edits and broken references fail without partial mutation.
- The condensed view stays in place and immediately shows the new player color.
- Keyboard and browser context-menu paths can reach the same action.
- Existing create, drag, resize, velocity, Fold, Chase, autosave, and playback
  behavior remains covered and working.

## Deferred Actions

- `Double with...` and multi-player assignment.
- Cut, Copy, Paste, and Delete menu entries.
- Undo/redo across orchestration transactions.
- Multi-note and lasso orchestration.
- Explicit overlap disambiguation UI.
- Creating new ensemble players from the Piano Roll.
