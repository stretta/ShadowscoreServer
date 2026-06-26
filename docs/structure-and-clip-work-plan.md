# Structure, Clip, and Matrix Edit Work Plan

This plan describes the remaining work to separate composition structure, reusable clips, and block-oriented Matrix Edit workflows.

## 1. Route Ownership

Status: implemented.

Make Structure Editor the default/root experience.

- Move `/` from Matrix Edit to Structure Editor.
- Keep Matrix Edit at `/matrix-edit`.
- Keep Event List at `/event-list`.
- Update session metadata:
  - `endpoints.app` points to the root Structure Editor experience.
  - `endpoints.structureEditor` points to the Structure Editor route.
  - `endpoints.matrixEdit` remains `/matrix-edit`.
- Update smoke tests and README references.

## 2. Clip Data API

Status: implemented for add, replace, remove, and rename.

Promote `clips` from an empty placeholder to first-class score state.

Add store operations:

- `addClip(clipId, document)`
- `replaceClip(clipId, document)`
- `removeClip(clipId)`
- `renameClip(oldId, newId)`, if renaming proves cleaner than add/remove.

The clip document follows the ShadowScore composition shape:

```json
{
  "notes": [],
  "context": {
    "clip": {},
    "scale": {},
    "grid": {},
    "seed": 0
  },
  "duration": { "bars": 1 },
  "playbackType": "looped",
  "behavior": {
    "followsPitch": true,
    "followsScale": true,
    "transposeMode": "scale-degree"
  }
}
```

Clip duration is independent from mesostructural block duration. A 1-bar looped clip assigned to an 8-bar block repeats eight times across that block; a one-shot clip plays once inside the block.

Add HTTP routes:

- `GET /clips`
- `POST /clips`
- `POST /clips/:clipId`
- `DELETE /clips/:clipId`

Add WebSocket messages:

- `clip.add`
- `clip.replace`
- `clip.remove`
- `clip.rename`, if supported.

Start by rejecting clip deletion when the clip is referenced by any mesostructural block. That avoids accidental musical loss. Clearing references can be added as an explicit later operation.

## 3. Structure Editor Clip Assignment

Status: implemented for existing-clip menus, clear assignment, and placeholder clip creation from a player/block slot.

Clip placeholder creation uses `playbackType: "looped"` by default.

Change per-player `clipId` fields from freeform text to menus populated from `score.clips`.

Structure Editor should support:

- Assign an existing clip to a player/block slot.
- Clear an assignment.
- Create a new placeholder clip from a player/block slot.
- Make unassigned slots visually obvious.

For empty slots, the menu can offer:

```text
None
Create new clip...
existing-clip-1
existing-clip-2
```

The create flow should create the clip and immediately assign it to that player in the selected mesostructural block.

## 4. Matrix Edit As Block Workspace

Status: implemented for the current block-oriented workflow. Matrix Edit has a
block selector populated from macrostructure/mesostructure, loads assigned clips
for the selected block, renders all assigned clips together, saves the selected
player's edits to the assigned clip, and keeps legacy voice-note editing as
fallback when the selected block has no clip assignments. Matrix Edit can create
a default looped clip from an empty player/block slot, assigns it to that slot,
blocks accidental edits to empty clip-based slots, and renders other players'
assigned clips as dim contextual/read-only reference layers.

Reframe Matrix Edit around a selected mesostructural block.

Matrix Edit should not become the sole authority for clip attribute editing. Event List is the canonical clip editor for clip-owned data such as `duration`, `playbackType`, behavior flags, and note events.

Add controls:

- Block selector.
- Editing player/voice selector.
- Assigned clip selector/status.
- Create clip for an empty player/block slot.
- Save writes to the assigned clip instead of directly to `voices[player].notes`.

Matrix Edit render model:

- Load the selected mesostructural block.
- Resolve each player's assigned `clipId`.
- Render all assigned clips together on the grid.
- Highlight/edit the current player's assigned clip.
- Show other players' clips as contextual, read-only layers unless explicitly unlocked.

Write model:

```text
selectedBlockId + selectedPlayerId -> clipId -> clips[clipId].notes
```

This replaces the current legacy model:

```text
selectedPlayerId -> voices[player].notes
```

Keep legacy voice-note editing temporarily as compatibility behavior until the clip-based workflow is stable.

Possible later refinements:

- Add an explicit assigned-clip selector in Matrix Edit if direct reassignment from the grid becomes useful.
- Add a stronger visual legend for selected-player notes versus context notes.
- Decide whether Matrix Edit should ever unlock cross-player editing, or whether all assignment changes should remain in Structure Editor.

## 4.5. Event List As Canonical Clip Editor

Status: implemented as the primary Event List workflow. Event List now flows server -> clip -> clip attributes -> note event editor. It no longer presents a player/voice selector as the primary editing axis, because player assignments belong to mesostructural blocks rather than clips.

Event List owns:

- Clip selection.
- Clip create, rename, and delete.
- Clip attributes: duration, time signature, playback type, and behavior flags.
- Clip note events: add, edit, delete, paste/import, and save.

This keeps clip data canonical in one place while Structure Editor owns block assignment and Matrix Edit owns block-context interlock editing.

The clip time signature lives in `clip.context.clip.TimeSignature` and gives Matrix Edit meter clues for bar/beat delineation. It is clip metadata, not block metadata.

RNBO target selection and transport controls are intentionally not part of Event List. Tempo, steps, clock interval, and target routing are playback concerns derived from block/macro state and assignments, and should be calculated/sent by the server behind the scenes.

## 5. Playback Compilation

Status: implemented for active-block playback. RNBO compilation resolves
assigned clips from the active mesostructural block when clip assignments exist,
with legacy voice-note compilation retained as fallback. The compiler accepts
both canonical `{ clipId }` assignments and older short string assignments, so
restored documents normalize safely.

Update RNBO/OSC compilation to resolve note data from mesostructure.

Current path:

```text
voices -> flattened score transaction
```

New path:

```text
selected/current meso block -> player clip assignments -> resolved clip notes -> flattened score transaction
```

Resolved implementation decisions:

- The server advances active-block state during timed macro playback.
- RNBO receives the current active block, not a pre-flattened macro chain.
- Each assignment-bound target receives its player's resolved clip material for the current block.
- A looped clip repeats across the containing block duration; a one-shot clip is transmitted once.

## 6. Macro Playback Model

Status: implemented for manual and timed playhead state. The score now stores
`structureState.activeBlockId` and `structureState.macroIndex`, Structure Editor
exposes active-block controls, RNBO compilation follows the active block, and
the server can run timed macro traversal from the current block using macro
tempo and block durations. Repeated block IDs in the macro chain preserve their
actual macro index, so `A, B, A, B` can report the second `A` as index `2`.

Add score/session playback state such as:

```json
{
  "activeBlockId": "A",
  "macroIndex": 0
}
```

Possible routes:

- `POST /structure/playhead`
- `POST /macrostructure/advance`
- `POST /macrostructure/reset`

Keep this separate from clip data. It is playback/navigation state, not composition material.

Implemented routes/messages:

- `GET /structure/playhead`
- `POST /structure/playhead`
- `POST /macrostructure/advance`
- `POST /macrostructure/reset`
- `GET /macrostructure/playback`
- `POST /macrostructure/playback/start`
- `POST /macrostructure/playback/stop`
- WebSocket `structure.playhead.update`
- WebSocket `macrostructure.advance`
- WebSocket `macrostructure.reset`

Remaining macro playback refinements:

- Add WebSocket start/stop commands if non-HTTP clients need direct control.
- Refine elapsed/remaining-time display in Structure Editor after live use.

## 7. Migration And Compatibility

Current saved scores may already have note data under `voices[player].notes`.

Status: first pass implemented. Admin can explicitly import non-empty legacy voice notes into looped clips assigned to a target mesostructural block, defaulting to block `A`. The import leaves original voice notes intact and skips existing clips unless `overwriteClips` is requested.

Implemented migration path:

- Leave voice notes intact as legacy data.
- `POST /admin/import-legacy-voice-notes`
- Admin button: `Import voice notes to clips`
- Seed clips from existing voices, such as `player-1-main`, `player-2-main`, and so on.
- Assign those seeded clips into default block `A`, or another requested block.

Do not auto-migrate destructively. Future migration tools can add preview/dry-run output, selective player import, and optional cleanup of legacy voice notes after the clip workflow is fully stable.

## 8. Saved Score Library

Status: implemented for Pi-local JSON save/load/delete through Admin.

The active score still persists to `data/score.json`, but the host can now keep
named score snapshots as JSON files under `data/scores/`.

Implemented routes:

- `GET /admin/scores`
- `POST /admin/scores`
- `POST /admin/scores/:scoreId/load`
- `DELETE /admin/scores/:scoreId`

The Admin page exposes a Saved Scores panel for naming the current score,
loading a saved score into the active session, refreshing the list, and deleting
old saved scores. Loading a saved score uses the same restore path as uploaded
backups, so score documents are normalized through the current server model.

Possible later refinements:

- Add a Structure Editor entry point for save/load if Admin feels too hidden.
- Add duplicate/rename score actions.
- Add optional score descriptions or performance metadata.
- Add an export/download button per saved score.

## Suggested Build Order

1. Make Structure Editor root.
2. Add clip API, store operations, collaboration messages, and tests.
3. Update Structure Editor clip menus and placeholder-clip creation flow.
4. Refactor Matrix Edit load/save behavior around selected block and assigned clips.
5. Add block-resolved RNBO compilation.
6. Add manual macro playhead state and active-block playback controls.
7. Add explicit migration/import from current voice notes.
8. Add timed macro chaining driven by block durations.
9. Add Pi-local saved score library.
