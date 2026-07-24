# OSC Block State Authoring UI

Status: implemented instant-write contract as of 2026-07-24.

## Model

Each persistent OSC editor control represents canonical Block State. Checked
instances are both live-send destinations and save destinations; there is no
live-only audition mode for persistent controls.

The shared panel separates three concepts:

- **PLAYING**: the block currently selected by the score playhead;
- **EDITING**: the block whose canonical OSC state is displayed and changed;
- **Recall Now**: an explicit full-state send of the saved block state.

When Chase is enabled, EDITING follows PLAYING. A block transition during a
range gesture waits until that gesture completes, saves it to the block where
it began, and then displays the newly playing block.

## Save Boundaries

- Range controls send their live value during movement and atomically save the
  complete editor state on pointer-up.
- Keyboard and touch `change` events use the same completion path.
- Toggles and selects save immediately after their completed change.
- Text, numeric, and list controls save on their existing deliberate boundary,
  such as Enter, blur, or a row Send action.
- Batch actions such as Mutate and pitch-range clipping save once after the
  batch completes.
- Refresh, Read Instance, focus changes, block selection, score hydration, and
  Chase hydration never save.
- Momentary commands such as RTZ, Panic, Reset, Probe, Get, and SetStage are
  never stored in Block State.

Every save uses one atomic request:

```http
PUT /osc/block-state
Content-Type: application/json

{
  "expectedStructureRevision": 450,
  "blockId": "C",
  "targets": ["wren:analogsequencer:29"],
  "snapshot": {
    "schemaVersion": 1,
    "app": "analogsequencer",
    "params": {},
    "inputPorts": {}
  }
}
```

The server creates missing roles, clips, and layers on the first edit and
replaces the independent target clips on later edits. A multi-target request is
all-or-nothing. A stale structure revision is refreshed and retried once; a
remaining failure stays visible and retryable without redirecting the edit.

## Shared Panel

The panel provides:

- focused instance and checked destination summary;
- instance cards with mapping, Written-state count, and Ignore Recall;
- PLAYING, EDITING, and Chase controls;
- one slot per block, labeled **Written** or **Unspecified**;
- **Recall Now**;
- **Copy Checked…** and **Clear State…** operations; and
- advanced reusable-clip assignment and duplication tools.

There is no separate Write or Reload action. Successful ordinary edits show
queued, saving, or saved status. Failed writes show the error and retain the
immutable failed job for retry.

## Live And Canonical Semantics

An individual control gesture sends the changed control to checked live
instances and saves the complete canonical state for those same instances.
This prevents a device from sounding different from the score merely because a
separate save gesture was omitted.

**Recall Now** remains explicit because it sends the entire saved state, which
is different from the per-control live traffic caused by editing. `ignoreRecall`
continues to suppress automatic block recall without preventing the editor from
authoring canonical state.

## Acceptance

1. Pointer movement does not save before pointer-up.
2. Pointer-up creates one semantic state write.
3. Keyboard and touch completion save once.
4. Discrete and list controls save at their deliberate completion boundary.
5. Multiple checked instances are saved atomically.
6. First edit onboards the required score resources.
7. Hydration and navigation never write.
8. A Chase transition never redirects an in-progress gesture.
9. Failed and stale writes never silently lose or retarget state.
10. The OSC editor family contains no separate unsaved-state workflow.
