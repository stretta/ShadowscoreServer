# Beat-Derived Macro Playback Plan

## Goal

Make ShadowscoreServer derive macrostructure location from musical beat position
instead of from wall-clock timers or from the assumption that JACK transport is
rolling.

ShadowscoreServer should own form playback: start/stop state, active macro
index, active mesostructural block, and RNBO block handoff. Link, JACK, or RNBO
client readback should provide beat-position evidence. Tempo changes must not
break macrostructure timing.

## Current Problem

Timer mode advances by elapsed milliseconds. That is not reliable when tempo can
change through Ableton Link.

JACK follower mode currently waits for JACK transport state to become rolling.
That is too narrow for the live system:

- Ableton Link shares tempo. It should not be treated as a generic shared phase
  or remote play button unless a specific host API exposes a usable beat-position
  witness.
- RNBO Runner transport controls may start local runner transport without
  starting Ableton Live.
- RNBO `Clock` starts or stops ShadowScore client playback, but it is not proof
  that JACK transport is rolling.
- JACK transport state remains an excellent witness when it is rolling, but it
  should not be the only possible beat-position witness.

## Desired Model

On macro playback start, the server records a musical anchor:

```text
macroStartBeat = currentWitness.absoluteBeat
macroStartIndex = current macro index
macroStartOffsetBeats = cumulative beats before macroStartIndex
```

During playback, the server derives macro location from beat position:

```text
compositionBeat = currentWitness.absoluteBeat - macroStartBeat + macroStartOffsetBeats
macroIndex = macro chain entry containing compositionBeat
beatIntoBlock = compositionBeat - cumulativeBlockStartBeat(macroIndex)
```

Tempo can change because the server is measuring beats, not milliseconds.

## Beat Witness Priority

Use the best currently available witness, with explicit status in API and UI.

1. JACK transport BBT when fresh, valid, and rolling.
2. RNBO Runner or host-specific Link beat position if exposed independently of
   JACK rolling.
3. RNBO client readback such as `current_stage` or `playback_debug`, converted
   to beats using the active timing contract.
4. Server timer only as a degraded fallback, visibly marked as degraded.

The witness must report:

```json
{
  "source": "jack|rnbo-runner|rnbo-client|timer",
  "usable": true,
  "absoluteBeat": 1234.5,
  "tempo": 120,
  "fresh": true,
  "reason": ""
}
```

## Phase 1: Separate Transport Intent From Beat Evidence

Rename and clarify server concepts:

- Macro playback state: stopped or running.
- Client playback state: RNBO `Clock` writes.
- Beat witness state: JACK, RNBO Runner, RNBO client, or timer.
- JACK transport state: rolling, stopped, starting, or unavailable.

The UI should stop implying that "Start JACK follower" starts JACK itself.

Recommended controls:

- Start Macro Playback
- Stop Macro Playback
- Re-anchor Macro Playback
- Advance Now
- Reset to First Block
- Optional: Start JACK Transport, only if backed by JACK API control

## Phase 2: Implement Beat Witness Abstraction

Add a small module that normalizes multiple sources into one beat witness shape.

Inputs:

- Existing `/transport` JACK snapshot state.
- RNBO Runner OSCQuery/HTTP transport fields, if a usable beat position exists.
- RNBO target readback such as `current_stage` and `playback_debug`.
- Server timer fallback.

The witness selector should prefer sources by reliability, freshness, and
configuration. It should explain its choice in snapshots and logs.

## Phase 3: Replace Advance Scheduling With Position Derivation

Change macro playback from "schedule next timeout" to "derive active block from
current beat."

On each witness update:

1. Compute `compositionBeat`.
2. Find the chain entry containing that beat.
3. If the derived macro index differs from `structureState.macroIndex`, update
   the playhead.
4. Send the newly active block transaction to RNBO targets.
5. Send or arm `SetStage 0` only as a phase-alignment action, not as the owner
   of macro form.

Repeated block IDs must remain valid. The macro index, not just block ID, is the
canonical form position.

## Phase 4: RNBO Client Readback Witness

Use client readback as a practical bridge when Link tempo is available but JACK
transport is stopped.

For an assigned target:

```text
beat = currentStage / stagesPerBeat
```

For each active block, use `/playback/timing-contracts` to know
`stagesPerBeat`, pattern length, and block duration in beats.

Open questions:

- Does `current_stage` reset cleanly on `SetStage 0` for every active client?
- Is one assigned client enough as the witness, or should the server compare
  multiple clients and reject skew?
- What readback cadence is stable enough for macro boundary detection?

## Phase 5: JACK Transport Control As Optional Capability

If ShadowscoreServer needs to start or stop JACK transport, do it through a real
JACK client that calls:

- `jack_transport_start()`
- `jack_transport_stop()`
- `jack_transport_locate()`

Expose these as explicit routes:

```text
POST /transport/jack/start
POST /transport/jack/stop
POST /transport/jack/locate
```

Do not route this through RNBO `Clock`, and do not assume Link peers such as
Ableton Live will accept remote play/stop control.

## Phase 6: API And UI Updates

Extend `/macrostructure/playback` with:

```json
{
  "running": true,
  "mode": "beat",
  "witness": {
    "source": "rnbo-client",
    "absoluteBeat": 42.25,
    "tempo": 120,
    "fresh": true
  },
  "compositionBeat": 10.25,
  "activeBlockId": "B",
  "macroIndex": 1,
  "beatIntoBlock": 2.25,
  "beatsRemaining": 13.75
}
```

Update the transport page to show:

- Selected witness source.
- Witness freshness and reason.
- Composition beat.
- Active macro index and block.
- Beat into block.
- Beats remaining.
- Whether JACK transport is rolling, separately from macro playback.

## Verification Plan

Unit tests:

- Derive macro index from absolute beat across multiple block durations.
- Preserve repeated block IDs in the macro chain.
- Handle tempo changes without changing beat-derived macro position.
- Reject stale or unusable witnesses.
- Fall back only when configured.

Live tests on `wren`:

- Start macro playback while Link tempo is available and JACK transport is
  stopped.
- Verify RNBO clients receive `Clock: 1`.
- Verify macro index changes from beat-derived position, not wall-clock timeout.
- Change Link tempo and verify macro boundaries remain beat-accurate.
- Compare server-derived macro position against RNBO `current_stage` readback.
- Verify `/matrix-edit` and `/event-list` show the same active block.

## Non-Goals

- Do not make ShadowscoreServer responsible for pressing play in Ableton Live.
- Do not treat RNBO `Clock` as JACK transport state.
- Do not make timer mode the normal musical authority.
- Do not collapse beat reference, client playback, JACK transport, and macro
  form into one control.
