# Score Initialization API

Phase G provides a dry-run-first public transaction for creating a complete
score skeleton without hand-editing persisted JSON.

The request owns structural intent only:

- `players`: stable player ids plus optional labels, colors, and assignees;
- `clips`: reusable note clips with notes, loop duration, playback type,
  context, and behavior;
- `blocks`: mesostructural ids, written tempos, durations, required rooted scale context,
  required 12-bit `ttid`, and player-to-clip assignments;
- `macrostructure`: ordered block occurrences;
- `oscRoles`: stable logical ids, app capabilities, labels, and recall policy.

The canonical block harmonic shape is:

```json
{
  "scale": {
    "root_note": 0,
    "scale_intervals": [0, 2, 4, 5, 7, 9, 11],
    "scale_name": "Ionian"
  },
  "ttid": 2741
}
```

Initialization normalizes omitted new-score harmonic values to this C Ionian
default and omitted written tempo to 120 BPM. Every stored block contains all
three fields. OSC roles may independently set `ignoreRecall` and `ignoreScale`.

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
