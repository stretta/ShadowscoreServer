# OSC Instant-Write Model

Status: accepted implementation plan. Checkpoint 1 completed the canonical
Block State upsert contract. Checkpoint 2 completed the shared write controller
and AnalogSequencer conversion on 2026-07-24 with 393 passing tests and a live
Wren canary. Checkpoint 3 converted the remaining six OSC editors with 394
passing tests and a successful live Wren canary. Checkpoint 4 removed the
deprecated local-state model and its UI with 392 passing tests; live Wren
verification is pending.

## Contract

- Persistent OSC editor controls always represent canonical score state.
- Checked instances are both live-send and persistence destinations. There is
  no live-only audition mode.
- Range controls send live OSC during movement and save one complete state on
  pointer-up. `change` is the keyboard and touch fallback, with semantic
  deduplication preventing a duplicate write.
- Toggles, selects, committed list edits, and batch mutations save immediately
  after the completed action.
- Momentary commands such as RTZ, Panic, Reset, Probe, and Get Data remain
  unsaved actions.
- Selecting, chasing, focusing, refreshing, or hydrating controls never writes.
- Recall Now remains explicit because complete-state recall is distinct from
  the live sends caused by individual control gestures.

## Checkpoint 1: Canonical Block State Upsert

Use one clean endpoint:

```http
PUT /osc/block-state
Content-Type: application/json

{
  "expectedStructureRevision": 12,
  "blockId": "A",
  "targets": ["wren:analogsequencer:1"],
  "snapshot": {
    "schemaVersion": 1,
    "app": "analogsequencer",
    "params": {},
    "inputPorts": {}
  }
}
```

The server creates missing roles, clips, and layers on first edit, then replaces
the same independent clips on later edits. A multi-target request is atomic and
returns the updated structure revision. Stale structure revisions return a
conflict without partial mutation.

The old `/osc/block-state/write` and `/osc/block-state/copy` routes, single
`targetId` form, `draft` and `clip` payload aliases, and client-supplied
replacement intent are removed. No compatibility reader or migration is kept.
Existing canonical OSC clips remain valid because this interaction change does
not require a score-schema change.

Until checkpoint 2, the existing Write button calls the upsert endpoint as a
short-lived bridge so the checked-in frontend and backend remain compatible.

## Checkpoint 2: Shared Write Controller And AnalogSequencer Canary

- Replace `serializeDraft` with `serializeState`, `applySnapshot` with a
  display-only callback, and `draftChanged` with an explicit user-edit commit.
- Add a serialized, coalescing write queue. Each immutable job captures its
  block id, checked target ids, complete snapshot, and edit sequence.
- Update AnalogSequencer so slider input continues live sends while pointer-up
  commits one canonical write. Toggles, selects, Clock All, pitch-range
  clipping, and Mutate commit once per completed action.
- Never enqueue writes from server hydration or live Get Data.
- If Chase advances during a gesture, bind the save to the old block, enqueue
  it at pointer-up, and then display the new playing block.
- Verify locally, then perform the live Wren canary.

Checkpoint 2 canary: on Wren block C, target 29 GateTime was changed through
the editor from `0.50` to `0.51` and restored to `0.50`. The restore advanced
the structure revision exactly once (`449` to `450`), while target 30 remained
at `0.50`. Transport state was not changed.

## Checkpoint 3: Remaining OSC Editors

Apply the same contract to ListSequencer, ListVelSequencer, SoftPiano, Plate,
Poland, and TTID. Text and list controls commit on their existing deliberate
completion boundary such as Enter, blur, or row commit.

Checkpoint 3 canary: the converted editors were tested successfully on Wren
after deploying commit `05e02f5`.

## Checkpoint 4: Deprecated Draft Cleanup

- Remove the Write and Reload Written State buttons.
- Remove per-block `drafts`, `savedDrafts`, draft keys, dirty comparisons,
  provisional restoration, and replacement confirmation.
- Remove Dirty Draft, Unwritten Draft, draft counts, and dirty/provisional CSS.
- Delete obsolete write-availability and write-label helpers and tests.
- Retain only transient queued, saving, and failed write information.
- Update the OSC authoring documentation and verify that draft terminology is
  absent from the OSC editor family. Piano Roll drafts are outside this scope.

Checkpoint 4 result: the shared client now has one instant-write path. The
separate Write and Reload controls, per-context caches, dirty/provisional
rendering, compatibility options, obsolete helpers, styles, and tests were
removed. Current OSC authoring documentation describes only canonical
instant-write behavior.

## Acceptance

1. Slider movement performs no canonical write before pointer-up.
2. Pointer-up produces exactly one atomic full-state write.
3. Keyboard and touch completion also save exactly once.
4. Toggles, selects, lists, and batch actions save on completion.
5. Multiple checked instances are written atomically.
6. First edit creates the necessary role, clip, and layer automatically.
7. Later edits replace state without confirmation.
8. Hydration, refresh, focus, block navigation, and Chase never write.
9. A transition during a drag saves to the old block before displaying the new
   block.
10. Revision conflicts never silently lose or redirect an edit.
11. The full automated suite and a live AnalogSequencer Wren canary pass before
    conversion of the remaining editors.
