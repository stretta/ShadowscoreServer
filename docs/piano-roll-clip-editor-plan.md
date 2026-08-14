# Piano Roll Clip Editor Plan

## Historical Status

This document records the first-version design. The route, duration editing,
loop projection, reference layers, zoom, velocity lane, and recoverable
per-clip drafts were delivered, but the explicit-Save decision below has been
superseded. The current editor autosaves completed gestures after a short quiet
window, retains Revert and stale-draft recovery, and exposes playback application
separately. It has also evolved into the condensed-score orchestration surface
described in
[`piano-roll-orchestration-plan.md`](piano-roll-orchestration-plan.md), including
atomic cross-player **Move to...** operations.

## Intent

Create a piano-roll style editor for ShadowScore clips. The first version should
feel like a time-aware evolution of Matrix Edit: the user still selects a block,
player, and assigned clip, sees the other assigned clips as context, and edits
the focused clip. The important new dimension is that note duration is visible
and directly editable by dragging a note edge.

This is a clip editor, not a structure editor. Structure Editor continues to own
sections, block durations, and player-to-clip assignment. Event List remains the
exact textual fallback for clip attributes and note events until the piano roll
has equivalent conflict handling and review affordances.

## Product Shape

The editor should live as a new server-hosted surface, tentatively
`/piano-roll`, backed by source in the Matrix Edit application family. Matrix
Edit remains available for dense grid entry and pattern-scale manipulation; the
piano roll is optimized for durations, overlaps, melodic contour, and velocity
shape.

The core interaction model:

- Select block, player, and assigned clip using the same ShadowScore context as
  Matrix Edit.
- Render the focused clip as horizontal note bars across time.
- Render other assigned block clips as lower-emphasis reference bars.
- Drag a note body to move onset and pitch.
- Drag a note right edge to resize duration.
- Do not include left-edge trimming in v1.
- Edit velocity in a dedicated velocity lane below the note grid.
- Keep edits local until the user presses an explicit Save button.
- Preserve chase/playback marker behavior where the current block and routed
  target make it available.

## Existing Ground To Reuse

Matrix Edit already has most of the data and server workflow needed for this
surface:

- `ShadowScoreNote` contains `pitch`, `start_time`, `duration`, and `velocity`.
- The ShadowScore projection code maps clip notes into block-time occurrences,
  including looped aliases and one-shot behavior.
- Matrix Edit already saves focused clip notes through `/clips/:clipId` and the
  collaboration draft path.
- It already distinguishes focused clip notes from read-only reference material.
- It already has a velocity lane, though the current one-row implementation is
  too cramped for the piano roll and should be enlarged for both surfaces.

The main architectural move should be extracting shared clip-editor logic from
Matrix Edit rather than forking a second unrelated client.

## UI Layout

Use a dense application layout, not a landing page. The first viewport should be
the working editor.

Top strip:

- block selector / chase toggle
- player selector
- clip selector
- dirty, saving, stale-revision, and route/playback state
- save/revert controls for explicit batch edits
- hot/batch mode control can arrive later; v1 Piano Roll should start in batch
  mode only

Main editor:

- left pitch ruler with compact piano-key or pitch-row labels
- scrollable note grid
- vertical bar and beat guides based on the clip time signature and grid
  subdivision
- focused notes as solid bars using selected player color
- loop aliases as subdued repeated bars that clearly indicate they are
  projected, not separate source notes
- reference clips as low-emphasis bars in their player colors
- playback wiper when live stage data is available
- horizontal and vertical scrolling as the score space grows beyond the viewport

Velocity lane:

- placed directly under the note grid and horizontally aligned with time
- at least twice the vertical space currently allocated in Matrix Edit
- v1 target: 3-4 logical rows or about 88-120 CSS px minimum, whichever better
  fits the existing renderer
- draggable vertical bars per note onset in Matrix Edit
- per-note velocity bars in Piano Roll, so overlapping notes at the same start
  can still be edited distinctly

## Interaction Details

### Note Creation

Click or drag in empty grid space to create a note at the snapped onset and
pitch. Use the existing default duration and velocity controls for initial
values. If the click lands in a loop alias, map it back to source clip time using
the existing projected-stage mapping.

### Note Selection

Support single selection first. Multi-select can follow after the resize and
velocity model is stable. The selected note should expose handles and should be
the note affected by keyboard nudges and velocity-lane edits.

Overlapping notes at the same pitch and time are allowed. Hit testing may return
multiple source-note candidates; v1 can operate on the first or last candidate
from the deterministic hit-test ordering. This is an accepted ambiguous edge
case, not a reason to merge notes or build an inspector before the common case is
working.

### Moving Notes

Dragging the body moves pitch and start together. Start snaps to the active grid
subdivision. Pitch snaps to rows. A move must update the source note only, not
projected alias occurrences.

### Resizing Durations

Dragging the right edge changes `duration`. The minimum duration is one grid
subdivision or the current minimum ShadowScore duration, whichever is larger.
The duration may extend beyond the visible clip boundary only if the existing
score model allows it; otherwise clamp at the clip duration and show edge
feedback.

Avoid integer-only assumptions. ShadowScore mode already allows fractional
durations, and duration edits must preserve sub-beat values.

Do not support left-edge trimming in v1. Keeping onset moves and duration
resizes separate makes the first implementation easier to test and easier to
understand during performance editing.

### Velocity Editing

In Matrix Edit, enlarge the existing lane and keep the current stage-based
behavior: editing a stage updates all notes beginning on that stage.

In Piano Roll, prefer note-specific velocity editing:

- selected note velocity edits only that note
- dragging in the lane over an unselected note selects and edits it
- stacked notes at the same start should be disambiguated by vertical lane
  ordering or by requiring note selection before edit

## Data And Save Model

Use the existing clip document as the source of truth:

```json
{
  "notes": [
    {
      "pitch": 60,
      "start_time": 0,
      "duration": 1,
      "velocity": 96
    }
  ],
  "duration": { "bars": 1 },
  "playbackType": "looped",
  "context": { "clip": {}, "scale": {}, "grid": {}, "seed": 0 },
  "behavior": {}
}
```

The piano roll should save by replacing the selected clip document through the
same revision-aware `/clips/:clipId` path used by Event List and Matrix Edit.
For v1, edits should be explicit-save only: pointer gestures update a local draft
and mark the clip dirty, and the server receives the changed clip only when the
user presses Save.

This deliberately differs from Matrix Edit's current hot behavior. Longer term,
Matrix Edit should gain two modes:

- hot mode: edits are sent immediately, matching the current behavior
- batch mode: edits are accumulated locally and sent only on demand

The first Piano Roll version should start with batch mode only. That keeps the
duration-resize workflow calmer and avoids reintroducing read/write contention
while the new interaction model is still settling.

## Implementation Phases

### Phase 1: Shared Clip Editor Core

- Identify Matrix Edit helpers that should be shared: clip selection, block
  projection, source-stage mapping, focused clip save, stale revision handling,
  velocity parsing, duration parsing, and pitch mapping.
- Extract pure helpers before changing behavior.
- Add unit tests around projected alias resize and move mapping.
- Keep source changes in `/Users/mdavidson/Documents/matrixedit`; export to
  ShadowscoreServer only after the source build and tests pass.

### Phase 2: Velocity Lane Enlargement

- Replace the single-row constant with a configurable lane height.
- Make Matrix Edit allocate at least twice the current velocity height.
- Update hit testing so velocity drags work across the full lane height.
- Update rendering so velocity fill uses the lane height instead of one cell.
- Add static or unit tests for the new lane sizing contract.
- Export the Matrix Edit bundle and verify `/matrix-edit` still serves the new
  asset.

### Phase 3: Piano Roll Rendering Prototype

- Add a new app entry or route for `/piano-roll`.
- Render focused clip notes as bars with `x = start_time`, `width = duration`,
  and `y = pitch`.
- Render block-time aliases using existing projection data, but mark aliases as
  non-primary.
- Render reference clips with lower emphasis.
- Implement responsive sizing for dense desktop and usable tablet layouts.

### Phase 4: Editing Gestures

- Add pointer capture and drag-state modeling for note body move, right-edge
  resize, and velocity-lane edit.
- Update the local draft during gestures and commit through the existing clip
  save path only when the user presses Save.
- Keep the selected note stable across render cycles.
- Add keyboard nudges after pointer gestures are reliable.

### Phase 5: Conflict And Canonical Workflow

- Integrate the shared draft/revision framework so Event List, Matrix Edit, and
  Piano Roll do not overwrite each other silently.
- Surface stale clip revisions clearly.
- Track dirty state per selected clip and preserve that draft while the user
  changes block, player, or clip context.
- Decide whether Piano Roll becomes a canonical clip editor alongside Event
  List, or whether Event List remains the exact-review surface for advanced note
  fields such as deviation and release velocity.

### Phase 6: Server Hosting And Operator Integration

- Register `/piano-roll` in server static app config and install defaults.
- Add the route to `/session` if it becomes a first-class surface.
- Update operator docs with the intended split:
  Structure Editor for assignments, Event List for exact clip data, Matrix Edit
  for dense grid edits, Piano Roll for time and duration edits.
- Add route smoke coverage alongside `/matrix-edit` and `/event-list`.
- Deploy to the live host only after source provenance is clean and exported
  `build-info.json` points to the committed Matrix Edit source SHA.

## Testing Checklist

- Unit: move and resize preserve `note_id`, pitch, velocity, deviation fields,
  and release velocity.
- Unit: loop alias edits map to the source clip note, not a generated alias.
- Unit: fractional start and duration values survive edits.
- Unit: velocity lane hit testing covers the enlarged lane.
- Browser: note bars align with bar/beat guides at multiple zoom levels.
- Browser: resizing a note edge changes only duration, not start or pitch.
- Browser: dragging the body changes start and pitch but preserves duration.
- Browser: edits remain local until Save, and Revert restores the last server
  clip snapshot.
- Browser: Matrix Edit still supports pitch toggling and velocity edits after
  the lane-height change.
- Server: `/piano-roll` route serves the bundle.
- Server: `/matrix-edit` static tests continue to pass.
- Live: route smoke confirms `/piano-roll`, `/matrix-edit`, `/event-list`, and
  `/session` on the target host before user testing.

## Settled Decisions

- V1 uses an explicit Save button with draft state. It does not autosave after
  every completed gesture.
- Matrix Edit should eventually have hot and batch modes. Its current behavior is
  hot mode.
- V1 supports right-edge duration changes only. It does not support left-edge
  trimming.
- Overlapping notes at the same pitch/time are allowed. Selection may choose the
  first or last deterministic hit-test candidate rather than forcing inspector
  disambiguation.
- Long term, Piano Roll needs horizontal and vertical scrolling and zoom. Do not
  assume the whole clip or pitch range fits in one fixed viewport.

## Open Decisions

- Should the initial Piano Roll velocity lane be note-specific from the start, or
  stage-based for consistency with Matrix Edit?
- Which zoom controls should ship first: timeline zoom only, pitch zoom only, or
  both?
- Should Matrix Edit batch mode share the exact same draft/save controls as
  Piano Roll, or stay visually distinct because its workflow is more grid-like?

## Recommended First Slice

Start with the velocity lane enlargement in Matrix Edit. It is small, validates
the rendering and hit-testing direction, and benefits the existing tool even if
the piano roll takes several passes.

Then build a read-only `/piano-roll` prototype against real clip data. Once note
bars, aliases, reference clips, and the playback wiper line up with Matrix Edit,
add explicit-save drafts and right-edge duration resizing as the first mutating
gesture.
