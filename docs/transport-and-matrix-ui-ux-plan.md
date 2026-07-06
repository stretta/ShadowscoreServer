# Transport And Matrix UI/UX Implementation Plan

## Goal

Give performers a simple DAW-like operating model while preserving the current
server-owned playback, routing, and editor architecture.

The user-facing rule is:

- Play makes the piece go.
- Stop makes the piece stop.
- Matrix Edit is the live meso-block workspace.
- Setup and routing details are visible when needed, but hidden during normal
  performance.

Internally, Play and Stop may coordinate JACK, macrostructure playback, beat
witness selection, RNBO transport-control writes, `Clock`, phase alignment, and
client readiness. The performer should not have to operate those as separate
primary controls.

## Settled Open Questions

### Which Surface Owns Clip Contents?

Event List remains the canonical clip editor. Matrix Edit may edit clip data
through a projected block-time view, but it should not become the place where
clip identity and exact event semantics are explained.

### Which Surface Owns Section And Clip Assignment?

Structure Editor owns musical structure:

- sections and meso blocks
- block duration
- player-to-clip assignment inside each block
- loop or one-shot behavior
- macrostructure ordering

The intended workflow language is "player 1 in section A", not "edit clip
xyz".

### Which Surface Owns Player To Client Routing?

Admin, or a future dedicated Players/Devices page, owns player-to-client and
player-to-RNBO-target routing.

Matrix Edit may show route health for the selected player and link to the
routing surface, but it should not be the canonical place to assign hardware
clients.

### What Does Matrix Edit Own?

Matrix Edit owns the live meso-block performance workspace:

- chase on or off
- playing block
- editing block
- selected player
- assigned clip summary
- projected notes/material for that player and block
- wiper visibility when playing and editing match
- clear mismatch/offline/empty states

### What Does Transport Own?

The transport UI owns musician intent, not low-level mechanism. The primary
surface should expose Play and Stop, with a few familiar secondary commands.
Lower-level transport diagnostics remain available on the transport status page
or in advanced drawers.

## Target User Experience

### Normal Performance

The primary transport area should look and behave like a small DAW transport:

- Play
- Stop
- Return to A or Return to Start
- Previous Section
- Next Section
- active section
- compact sync/source indicator
- compact readiness indicator

The page should avoid exposing separate primary controls for JACK transport,
macrostructure playback, RNBO `Clock`, phase reset, or target writes. Those are
policy decisions behind Play and Stop.

### Matrix Edit Header

The normal Matrix Edit header should be reduced to:

- Chase toggle
- Playing block indicator
- Editing block selector
- Player selector
- Assigned clip summary
- Route health indicator
- Transport Play/Stop or a compact shared transport component

Advanced setup controls should move behind a disclosure area or another page:

- RNBO target selection
- raw endpoint details
- timing-contract diagnostics
- grid/debug fields that are not part of normal performance
- low-level transport source details

### Setup Mode

Setup should be an explicit mode or page, not the default Matrix Edit posture.
It should answer:

- Which players exist?
- Which hardware clients are online?
- Which client is assigned to each player?
- Which sections assign which clips to which players?
- Which assignments are missing, stale, offline, or ambiguous?

## Transport Facade

Add or formalize a single user-facing transport command layer:

```text
POST /transport/play
POST /transport/stop
POST /transport/return-to-start
POST /transport/previous-section
POST /transport/next-section
```

These routes should call existing lower-level services rather than duplicating
playback logic.

### Play Policy

`POST /transport/play` should:

1. Resolve the intended starting macro/block position.
2. Select or confirm the best available beat witness.
3. Start macrostructure playback in the appropriate mode.
4. Send client transport-control writes needed to make assigned clients play.
5. Send `Clock` on where the current client contract still requires it.
6. Apply phase alignment, such as `SetStage 0`, when starting or re-anchoring.
7. Return a single aggregate status snapshot.

If JACK transport can be started through a real JACK capability, Play may start
it according to configuration. If it cannot, Play should not pretend that JACK
started; it should report the witness/source state clearly.

### Stop Policy

`POST /transport/stop` should:

1. Stop macrostructure playback.
2. Send client transport-control writes needed to stop assigned clients.
3. Send `Clock` off where the current client contract still requires it.
4. Optionally stop JACK transport only when configured and supported.
5. Preserve the current musical location unless the command is explicitly
   Return to Start.
6. Return a single aggregate status snapshot.

### Aggregate Status

Expose one compact status shape for UI consumption:

```json
{
  "playing": true,
  "activeBlockId": "A",
  "macroIndex": 0,
  "beatIntoBlock": 1.5,
  "sync": {
    "source": "jack",
    "fresh": true,
    "label": "JACK"
  },
  "clients": {
    "assigned": 6,
    "online": 6,
    "ready": true
  },
  "warnings": []
}
```

Advanced routes such as `/transport/status`, `/macrostructure/playback`,
`/playback/timing-contracts`, `/hardware/units`, and `/rnbo/targets` should
remain available for diagnosis.

## Matrix Edit Simplification

### Primary Header Layout

The first viewport should privilege performance state:

```text
[Chase]  Playing: A  Editing: A  Player: 1  Clip: a-player-1  [route ok]
[Play] [Stop] [Return to A]
```

When playing and editing differ:

```text
[Chase off]  Playing: B  Editing: A  Player: 1  Clip: a-player-1
Playback is on B; editing A. Wiper hidden.
```

### Wiper Rule

The wiper should only move when the playing block and editing block are the
same. If they differ, Matrix Edit should make the mismatch visible and hide or
freeze the wiper.

### Empty And Misconfigured States

Matrix Edit should show direct, user-readable states:

- Player has no clip assigned in this block.
- Player is assigned to a client that is offline.
- Player has no client route.
- Client route is ambiguous and needs setup.
- Editing block differs from playing block.

Each state should offer a direct navigation path to the owning surface:

- missing clip assignment -> Structure Editor
- missing or stale client route -> Admin or Players/Devices
- canonical clip edits -> Event List

## Phased Implementation

### Phase 1: Document Current Surface Ownership In UI Copy

Update labels and helper text so the surfaces stop implying overlapping
ownership:

- Event List: canonical clip data.
- Structure Editor: sections, blocks, and player-to-clip assignments.
- Admin/Players: player-to-client routing.
- Matrix Edit: meso-block performance workspace.

Acceptance criteria:

- No Matrix Edit label implies it is the canonical hardware assignment page.
- Structure Editor uses section/player language.
- Admin routing labels distinguish players from clients.

### Phase 2: Add Transport Facade Routes

Add the `/transport/play` and `/transport/stop` routes first, with the
secondary routes following after the main path is stable.

Acceptance criteria:

- Play starts macrostructure playback and assigned client playback through the
  existing transport writer paths.
- Stop stops macrostructure playback and assigned client playback.
- Routes return aggregate status.
- Existing lower-level routes still work.

### Phase 3: Add Shared Transport Status Component

Create a small shared UI component or rendering helper used by the transport
page and Matrix Edit.

Acceptance criteria:

- Primary UI shows Play, Stop, active block, sync source, and route readiness.
- Low-level source details move behind an advanced disclosure or status page.
- Status distinguishes stopped, playing, degraded sync, and unavailable clients.

### Phase 4: Simplify Matrix Edit Header

Replace the current normal-operation header with the focused performance header.

Acceptance criteria:

- Chase, editing block, player, assigned clip, route health, and transport are
  visible without scrolling.
- Configuration controls are hidden during normal operation.
- Existing advanced controls remain accessible.
- Wiper behavior still follows the playing/editing block rule.

### Phase 5: Move Routing Edits Out Of Matrix Edit

Make Matrix Edit route selection read-mostly, with navigation to the canonical
routing surface for changes.

Acceptance criteria:

- Matrix Edit shows selected player route status.
- Changing player-to-client routing happens in Admin or Players/Devices.
- Matrix Edit can refresh after routing changes without reload.
- Missing/stale route states link to the routing surface.

### Phase 6: Add Setup/Performance Mode Boundary

Introduce an explicit performance/setup split if the simplified header still
needs too much hidden state.

Acceptance criteria:

- Performance mode can be used with only Play/Stop, Chase, block, and player.
- Setup mode exposes routing and configuration.
- The app remembers the last useful mode without surprising a performer during
  playback.

### Phase 7: Live Verification

Verify on a real host after local tests:

1. Reset or load a known score with multiple sections and players.
2. Confirm Admin or Players/Devices shows online clients and player routes.
3. Confirm Structure Editor owns player-to-clip assignments.
4. Open Matrix Edit and confirm the simplified header.
5. Press Play and verify macrostructure playback, client playback, and Clock or
   transport-control writes.
6. Toggle Chase and verify the editing block follows the active block.
7. Turn Chase off, edit a different block, and verify the wiper hides.
8. Press Stop and verify macrostructure and assigned clients stop.
9. Break one client route and verify Matrix Edit shows a route health state,
   not raw endpoint confusion.

## Implementation Notes

- Preserve the existing beat-witness architecture. The UI simplification should
  not make JACK, Link, RNBO, and timer behavior less explicit internally.
- Preserve score-owned Matrix Edit resolution. Do not derive edit grid
  resolution from RNBO timing contracts.
- Keep source-first Matrix Edit workflow: edit Matrix Edit source, test it,
  export into this repo, then verify `public/matrix-edit/build-info.json`.
- Keep `/transport/status` as the diagnostic page for advanced transport
  details.
- Prefer additive routes and UI simplification before removing existing
  controls.

## Suggested First Code Slice

Start with a narrow vertical slice:

1. Add `/transport/play` and `/transport/stop` as wrappers around the existing
   macrostructure and client transport paths.
2. Return the aggregate status shape from both routes.
3. Update Matrix Edit to call these routes for Play and Stop.
4. Hide raw transport/configuration controls behind an Advanced disclosure.
5. Verify locally, then verify live on the target host.

This gives performers the simplified model immediately while leaving deeper
ownership moves, such as a dedicated Players/Devices page, for a follow-up
phase.
