# Adaptive Playback Stage Resolution Plan

## Goal

Improve playback fidelity, starting with ShadowScore-to-RNBO playback, by making stage resolution a server-owned, per-transaction timing decision instead of a fixed global constant.

ShadowScoreServer stores note onsets and durations in beat-space values that can be more detailed than the current RNBO stage grid. RNBO playback still needs integer stage indexes, but the server can choose how much musical time one integer stage represents for each compiled transaction.

The desired outcome is a flexible timing contract:

- Short passages can use higher stage resolution for more faithful onsets and durations.
- Long passages can use lower stage resolution so the full sequence fits within client capacity.
- Expanded RNBO client storage can raise the ceiling without changing the conceptual model.
- The server remains the authority for `stagesPerBeat`, `ClockInterval`, `MaxSteps`, and note stage conversion.
- Other playback clients can advertise different capabilities and receive a best-effort timing contract that fits their limits.

## Current State

The current server compiler uses `config.rnbo.stagesPerBeat`, which defaults to `16`, to convert ShadowScore beats into RNBO stages.

```text
stage = round((beat - selectionStart) * stagesPerBeat)
durationStages = max(1, round(durationBeats * stagesPerBeat))
patternLength = round((selectionEnd - selectionStart) * stagesPerBeat)
```

The transaction protocol already carries `patternLength` and `stagesPerBeat` in `BEGIN_REPLACE`, and server transport writes already derive `MaxSteps` from compiled `patternLength` for assigned targets.

The practical limit to plan around today needs to distinguish stage capacity from note-row storage. `patternLength` / `MaxSteps` define how many integer stage positions the block can play through. `shadowscore_notes` defines how many note rows can be stored and scanned.

Current RNBO client references include:

```text
data shadowscore_notes @size 8192 @type float64
data shadowscore_context @size 64 @type float64
```

With a 10-field note row, `8192` floats can hold `819` complete note rows with two unused floats. Keep the note row at 10 fields for future use and clear field delineation rather than shrinking it to maximize row count. Current playback scripts still need their scan limits checked separately, since some code paths use `MAX_NOTE_ROWS` / `MAX_NOTES` constants below the raw data-object capacity.

The resolution selection algorithm should therefore treat both `maxStages` and `maxNoteRows` as variable target capabilities instead of baking in `1024`.

## Design Principle

Stage indexes stay integer. The flexibility comes from choosing the grid before compiling the transaction.

In other words, RNBO receives integer stages, but ShadowScoreServer chooses the size of a stage.

```text
ShadowScore beat-space timing
  -> server chooses transaction resolution
  -> integer RNBO start_stage and duration_stages
  -> server writes matching ClockInterval and MaxSteps
```

Do not make RNBO playback responsible for floating onset math. Keep the RNBO client simple, deterministic, and counter-based.

## Proposed Timing Contract

Each compiled playback transaction should have a timing contract for the active mesostructural block. RNBO is the first concrete endpoint for this contract, but the contract should be target-specific rather than RNBO-specific:

```js
{
  blockId,
  stagesPerBeat,
  ticksPerStage,
  patternLength,
  maxStages,
  maxNoteRows,
  resolutionMode,
  quantizationError
}
```

`stagesPerBeat` is the conversion grid used for note data.

`ticksPerStage` is the transport interval written to RNBO as `ClockInterval`.

`patternLength` is the compiled loop length and the value written as `MaxSteps`.

`maxStages` is the client stage limit used when choosing timing resolution.

`maxNoteRows` is the client storage/scan limit used when deciding how many note rows can be sent.

`resolutionMode` records whether the server used a fixed, adaptive, maximum-fidelity, or maximum-length policy.

`quantizationError` is optional diagnostic metadata for the timing conversion. It should support two debugging views:

- Overall sloppiness: worst and aggregate onset/duration error after quantization.
- Beat-relative offset: whether converted events are consistently early or late relative to their intended beat positions.

RNBO can convert absolute stage positions back into beat-relative values easily enough, so diagnostics should keep both absolute stage data and beat-relative interpretation available.

The timing contract is not score-global. It belongs to the block/mesostructural level that is currently being compiled and sent. Playback clients only need to know the timing grid for the block they are currently playing.

For RNBO, this contract is transmitted through the existing RNBO score and transport surfaces: `patternLength` and `stagesPerBeat` in the score transaction, plus matching `MaxSteps` and `ClockInterval` transport writes. Other clients may receive the same logical contract through a different protocol and should do the best possible rendering within their advertised limits.

## Resolution Selection

The compiler should choose the highest useful resolution that fits the active mesostructural block and target stage capacity, while separately respecting note-row capacity.

Inputs:

- Active block duration in beats.
- Note onset and duration values for the target voice or assigned clip.
- Target/client stage capacity and note-row capacity.
- Preferred minimum tick size or preferred maximum quantization error.
- Optional user/configured minimum and maximum `stagesPerBeat`.

Basic algorithm:

```text
blockBeats = selectionEnd - selectionStart
maxStages = target.capabilities.maxStages || config.rnbo.maxStages || 4096
maxNoteRows = target.capabilities.maxNoteRows || config.rnbo.maxNoteRows || 819

maxFitStagesPerBeat = floor(maxStages / blockBeats)
desiredStagesPerBeat = derive from score timing detail and configured quality target

chosenStagesPerBeat = clamp(
  desiredStagesPerBeat,
  minStagesPerBeat,
  min(maxStagesPerBeat, maxFitStagesPerBeat)
)

patternLength = ceil(blockBeats * chosenStagesPerBeat)
ticksPerStage = ticksPerBeat / chosenStagesPerBeat
```

With the current 480 PPQ transport basis:

```text
ticksPerStage = 480 / stagesPerBeat
```

Only use `stagesPerBeat` values that divide the 480 PPQ transport basis so `ClockInterval` stays integral.

Recommended candidate grid values:

```text
1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480
```

The list can be capped by config and target capability.

## Adaptive Modes

Support a small set of explicit modes rather than one opaque heuristic.

### Fixed

Use `config.rnbo.stagesPerBeat` exactly, preserving current behavior.

This should remain the compatibility mode during rollout.

### Fit

Choose the highest configured candidate resolution that fits the active block inside client capacity.

This mode improves resolution for short sections without needing note-specific analysis.

### Fidelity

Choose the lowest candidate resolution that preserves note onset and duration values within a configured error target.

For example, select the smallest grid where all onsets and durations quantize within `1/480` beat or another configured threshold. If no candidate fits, choose the best fitting candidate and report quantization error.

### Hybrid

Use fidelity mode when possible, then fall back to fit mode when the section is too long or the target cannot support the desired grid.

This is likely the best default after compatibility testing.

## Playback Target Capabilities

Add a playback target capability surface so the server does not assume every client has the same capacity or timing model. RNBO targets will use this first, but the shape should also support future ShadowScore playback clients with different limits.

Suggested fields:

```js
{
  maxStages: 4096,
  maxNoteRows: 819,
  noteDataFloatCount: 8192,
  noteRowWidth: 10,
  contextDataFloatCount: 64,
  supportsAdaptiveResolution: true,
  contractTransport: "rnbo-osc",
  bestEffort: true,
  supportedClockIntervals: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480]
}
```

These are `ClockInterval` values in PPQ ticks. The corresponding `stagesPerBeat` values are `480 / ClockInterval`, and should likewise stay on the 480 integer grid.

Initial implementation can read this from config. Later, registration agents can advertise it per hardware unit, RNBO target, or non-RNBO playback client.

## Server Implementation Plan

### Phase 1: Make Timing Explicit

- Introduce an internal `compileTimingContract(score, config, target)` helper.
- Move `stagesPerBeat`, `patternLength`, and `ClockInterval` derivation into that helper.
- Keep default behavior fixed at `16` stages per beat.
- Return timing metadata from `compileScoreTransaction()`.
- Extend tests to assert unchanged current behavior.

### Phase 2: Capacity-Aware Fixed/Fit Modes

- Add config:

```json
{
  "rnbo": {
    "resolution": {
      "mode": "fixed",
      "defaultStagesPerBeat": 16,
      "maxStages": 4096,
      "maxNoteRows": 819,
      "candidateStagesPerBeat": [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480]
    }
  }
}
```

- Implement `mode: "fit"` behind config.
- Ensure `patternLength <= target.maxStages`.
- Ensure `ClockInterval` is derived from the chosen resolution, not copied from stale transport config.
- Log the selected resolution and capacity decision when sending score data.

### Phase 3: Fidelity Heuristic

- Inspect note onsets and durations for the active section/target.
- Calculate quantization error for candidate grids, including both overall sloppiness and beat-relative offset.
- Select the best candidate that fits capacity and satisfies the error target.
- Include diagnostic metadata in compile results for tests and debug output.

### Phase 4: Transport and Live Sync

- Update score-change transport resend logic to use the compiled timing contract:
  - `MaxSteps = patternLength`
  - `ClockInterval = ticksPerStage`
  - `Tempo = configured/current tempo`
- Send only the timing contract for the currently active block/mesostructural unit.
- Keep `Clock`, `SetStage`, `Stage`, and direct reset controls out of routine score-change resends.
- Confirm start/stop still sends `Clock` last where applicable.

### Phase 5: Matrix Edit Alignment

- Load the server-selected timing contract for the active section/voice.
- Display the grid in transaction stage units, not a fixed `16` stages per beat.
- Make the current-stage wiper use the same contract.
- Preserve user-facing beat durations while editing, but convert through the active contract when rendering and saving.

Status: first cut implemented in Matrix Edit source and exported into the server bundle. Matrix Edit reads `/playback/timing-contracts`, maps contracts by assigned voice, uses the selected contract for stage interval and frame length, and falls back to the legacy `16` stages-per-beat / `1024` stages behavior when no contract is available.

### Phase 6: RNBO Client Expansion

- Expand RNBO client stage capacity to `4096`, while keeping the note row width at 10 fields.
- Update the server target capability for expanded clients.
- Validate that larger `MaxSteps`, larger `patternLength`, and higher-resolution note starts survive live transmission and playback.
- Keep old clients working by advertising or configuring their lower capacity.

Status: server capability plumbing implemented. Configured, discovered, local, and registered RNBO targets now carry normalized playback capabilities. Expanded clients can advertise `maxStages: 4096` and larger note-row capacity, while older clients can advertise lower limits such as `maxStages: 1024`; timing contracts are compiled per target. The RNBO patch/client-side expansion and live playback validation remain separate follow-up work.

Update: wren live validation passed with a normal server score mutation sending `patternLength: 4096`, `noteCount: 819`, and `transmittedRowCount: 819` to the local RNBO client; a receiver query for stage `4095` returned the row-818 test note. Peer registration agents on heron, raven, and finch have been updated so, once their new RNBO exports are running, the flock advertises `4096` stages and `819` note rows. Peers without advertised capabilities intentionally remain legacy `1024` / `512`.

## Test Plan

Unit tests:

- Fixed mode preserves current `16` stages per beat behavior.
- Fit mode chooses higher resolution for short sections.
- Fit mode backs off resolution for long sections.
- Fidelity mode chooses a grid that minimizes onset and duration error.
- Compiler never emits `patternLength` above target capacity.
- `ClockInterval` matches the chosen `stagesPerBeat`.
- `MaxSteps` equals compiled `patternLength`.

Integration tests:

- Assigned target transport writes use compiled `MaxSteps` and derived `ClockInterval`.
- Score resend does not include `Clock`, `SetStage`, or direct stage controls.
- Matrix Edit renders notes and current-stage overlays using the same resolution contract as RNBO playback.

Live tests:

- A short section with off-grid onsets plays closer to source timing at higher resolution.
- A long section automatically reduces resolution and still loops correctly.
- Expanded RNBO clients accept and play sequences up to `4096` stages.
- Older `1024`-stage clients continue to receive fitting transactions.

## Inspection Surface

Expose target-specific compiled timing contracts through `GET /playback/timing-contracts`, and advertise that URL from `/session.endpoints.playbackTimingContracts`.

Keep `/score` limited to persistent musical/compositional data. Timing contracts are derived runtime artifacts because they depend on active block state, target capabilities, and resolution mode.

For RNBO targets, the inspection response should include the target id, assigned voice id, selected timing contract, note count, and transmitted row count. Future playback clients can use the same endpoint shape with a different `targetType` and `contractTransport`.

## Recommended First Cut

Implement the helper and config shape first, but keep `mode: "fixed"` as the default. Then add `mode: "fit"` and test it locally without changing live behavior. Once fit mode is proven, add fidelity scoring and expose the selected timing contract in debug/session output.

This keeps the first change low-risk while setting up the architecture for adaptive resolution and larger RNBO clients.
