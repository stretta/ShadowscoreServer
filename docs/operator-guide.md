# ShadowscoreServer Operator Guide

This guide is for running a ShadowScore ensemble session from an installed
ShadowscoreServer host.

## Session Roles

- The host unit runs ShadowscoreServer and owns the active score.
- Peer units register their local RNBO targets with the host.
- Structure Editor is the main form and assignment surface.
- Event List is the canonical clip editor.
- Matrix Edit is the live block-context performance workspace.
- Admin is for lab operations: score backup/restore, saved scores, assignment
  presets, resets, migration tools, and RNBO resend.

## Start Of Session

On the host unit, confirm the server is running:

```sh
systemctl is-active shadowscore-server.service
curl http://127.0.0.1:8790/healthz
```

From a laptop or tablet on the same network, open:

```text
http://<host>.local:8790/
http://<host>.local:8790/event-list
http://<host>.local:8790/matrix-edit
http://<host>.local:8790/admin
http://<host>.local:8790/transport/status
```

The root page is Structure Editor. Use `/structure-editor` if an explicit route
is clearer for the situation.

## Verify Hardware

Check the session and target maps:

```sh
curl http://<host>.local:8790/session
curl http://<host>.local:8790/hardware/units
curl http://<host>.local:8790/rnbo/targets
curl http://<host>.local:8790/playback/timing-contracts
```

The useful reading is:

- `/hardware/units` shows which peer boxes are online.
- `/rnbo/targets` shows the actual OSC targets the host can write to.
- `/playback/timing-contracts` shows per-target stage capacity, note-row
  capacity, selected `ClockInterval`, `MaxSteps`, and active-block compilation
  diagnostics.

If a peer advertises an unreachable RNBO host, use Admin's observed-host repair
control. The API form is:

```sh
curl -X POST http://<host>.local:8790/hardware/units/<unitId>/targets/<targetId>/use-observed-host
```

## Prepare The Score

Use Structure Editor for:

- selecting the active block;
- editing block durations;
- assigning clips to players;
- setting macrostructure tempo and block order.

Use Event List for:

- creating, renaming, and deleting clips;
- editing clip duration, time signature, playback type, and behavior flags;
- editing the clip's note event list.

Use Matrix Edit for:

- selecting a block;
- selecting the player/clip to work on;
- entering notes in the context of the other assigned clips;
- watching active-block playback when the edited block matches the playing
  block.

Matrix Edit is not the canonical place for clip attributes or structure changes.
Those belong to Event List and Structure Editor respectively.

## Score Operations

Admin exposes the usual session operations:

- New Score creates a fresh score from the configured ensemble defaults.
- Save Current Score writes a named JSON score under `data/scores/`.
- Load restores a saved score through the normal normalization path.
- Download Backup downloads the current active score JSON.
- Restore Backup uploads a score JSON and normalizes it into the active session.
- Import voice notes to clips migrates legacy `voices[player].notes` into
  looped clips without deleting the original voice notes.
- Resend RNBO retransmits the current active-block score transaction.

The matching API routes are:

```text
POST /admin/scores/new
POST /admin/scores
POST /admin/scores/:scoreId/load
GET /admin/backup
POST /admin/restore
POST /admin/import-legacy-voice-notes
POST /admin/rnbo/resend
```

## Playback And Transport

The transport status page is:

```text
http://<host>.local:8790/transport/status
```

Use it to inspect JACK bridge freshness, beat witness state, active block,
macro playback mode, and remaining beats.

Common control routes:

```text
POST /macrostructure/playback/start
POST /macrostructure/playback/stop
POST /macrostructure/advance
POST /macrostructure/reset
POST /macrostructure/phase-reset
POST /transport/jack/start
POST /transport/jack/stop
POST /transport/jack/locate
```

`/macrostructure/playback/start` starts macro playback and writes `Clock: 1` to
assignment-bound targets. Pass `{ "phaseReset": true }` when a start should also
write `SetStage: 0`. `/macrostructure/phase-reset` writes `SetStage: 0` without
starting or stopping playback.

## Quick Recovery

If browsers are open but the score looks stale:

```sh
curl http://<host>.local:8790/session
curl http://<host>.local:8790/score
```

If peers disappear:

```sh
curl http://<host>.local:8790/hardware/units
systemctl status shadowscore-registration-agent.service
```

If RNBO playback keeps old notes after a clear or score change:

```sh
curl -X POST http://<host>.local:8790/admin/rnbo/resend
curl http://<host>.local:8790/playback/timing-contracts
```

If transport state looks stale:

```sh
curl http://<host>.local:8790/transport
journalctl -u shadowscore-jack-transport-bridge.service -n 80 --no-pager
```

When diagnosing, keep these boundaries separate: server score state, peer
registration, RNBO target visibility, transport beat evidence, and actual audio
output.

