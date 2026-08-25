# Score Initialization API

Phase G provides a dry-run-first public transaction for creating a complete
score skeleton without hand-editing persisted JSON.

The Setup page exposes the same transaction as a three-step **New Score**
wizard. It can generate players from a manual count or from selected online
ShadowScore playback clients, then creates one independent clip for every
player/block cell. Initial material defaults to empty parts; optional sparse
test notes can be placed in the first block or in every block. Client-derived
players are structurally created first, mapped to their selected live targets
second, and updated through the normal playback-update route when transport
permits. Generated clips can be `1`, `0.5`, or `0.25` times the duration of
their containing block without changing the block duration.

The request owns structural intent only:

- `players`: stable player ids plus optional labels, colors, and assignees;
- `clips`: reusable note clips with notes, loop duration, playback type,
  context, and behavior;
- `blocks`: mesostructural ids, written tempos, durations, required rooted scale context,
  required 12-bit `ttid`, shared `swing` / `swingAmt`, and player-to-clip assignments;
- `macrostructure`: ordered block occurrences;
- `oscRoles`: stable logical ids, app capabilities, labels, and recall policy.

The canonical block harmonic shape is:

```json
{
  "scale": {
    "root_note": 0,
    "scale_intervals": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "scale_name": "Chromatic"
  },
  "ttid": 4095,
  "swing": 0,
  "swingAmt": 0.5
}
```

Initialization normalizes omitted new-score harmonic values to this C Chromatic
default, omitted written tempo to 120 BPM, and omitted Swing to Off with an
amount of `0.5`. Swing amount accepts `0.5` through `1`, where `0.5` is straight
timing. Every stored block contains these fields. OSC roles may
independently set `ignoreRecall` and `ignoreScale`.

Legacy requests that still provide `macrostructure.tempo` use it only to fill
missing block tempos. The normalized score removes that legacy field.

Live `deviceId`, RNBO target, and OSC target fields are rejected. Rig discovery
and OSC onboarding fill those mappings after the skeleton exists. Likewise,
the initial score contains no OSC clips or layers. Every block/role combination
is therefore an implicit Unspecified slot until state is written from an
editor.

## Preview

Send the request document to:

```text
POST /admin/scores/initialize/preview
```

The response contains:

- `dryRun: true`;
- `base`: current version, score revision, and structure revision;
- `summary`: ids and counts, including `emptyOscLayerSlotCount`;
- `score`: the exact normalized score that would replace the current score.

Preview never mutates the active score.

## Apply

Send the same request to:

```text
POST /admin/scores/initialize
```

Add `expectedVersion`, `expectedScoreRevision`, and
`expectedStructureRevision` from the preview's `base` object. A stale revision
rejects the operation without partial mutation. Successful creation replaces
the score in one store transaction and emits `admin.score.initialized`. The
score is marked as an exact-player initialization so persistence reconciliation
does not re-add configured default players after restart.

## Example Request

[`../config/score-initialization.four-player.json`](../config/score-initialization.four-player.json)
creates four players, 24 independent one-bar loop clips, six one-bar sections,
a six-entry macro order, three unmapped AnalogSequencer roles, and 18 implicit
Unspecified OSC slots.

## Wizard Request

The preview and apply routes also accept a compact wizard document:

```json
{
  "wizard": {
    "name": "Seven by six",
    "playerCount": 7,
    "blockCount": 6,
    "blockBars": 1,
    "clipDurationMultiplier": 0.5,
    "tempo": 120,
    "material": "empty"
  }
}
```

`material` is `empty`, `first-block`, or `all-blocks`.
`clipDurationMultiplier` is `1`, `0.5`, or `0.25` and defaults to `1`. Instead of
`playerCount`, callers may provide `players` with stable ids, labels, and
colors. Wizard-generated clips include placeholder provenance in `behavior`,
use the selected fraction of their block duration, and are never shared between blocks.
Apply requests add the revision fields returned by preview alongside the
`wizard` object.
