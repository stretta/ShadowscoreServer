# ShadowscoreServer Operator Guide

This guide is for running a ShadowScore ensemble session from an installed
ShadowscoreServer host.

## Session Roles

- The host unit runs ShadowscoreServer and owns the active score.
- Peer units register their local RNBO targets with the host.
- Players are stable score lanes. Clients are runtime output devices or
  processes, and assignments route a player to a live client target.
- Arrange (`/structure-editor`) is the main form and assignment surface.
- Event List is the canonical clip editor.
- Matrix Edit is the live block-context performance workspace.
- Piano Roll is the autosaving time, duration, pitch, velocity, and condensed-score
  orchestration editor. Recoverable drafts and Revert remain available.
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
http://<host>.local:8790/piano-roll
http://<host>.local:8790/admin
http://<host>.local:8790/transport/status
http://<host>.local:8790/editors
http://<host>.local:8790/editors/element
http://<host>.local:8790/editors/vantor
http://<host>.local:8790/editors/drumbox
http://<host>.local:8790/editors/triggersequencer
http://<host>.local:8790/editors/plate
http://<host>.local:8790/tools/osc-volume
http://<host>.local:8790/tools/osc-macros
```

The root page is the ShadowScore view index. Use `/structure-editor` for
Arrange directly, or the root index for links to all bundled editing views and
discovered RNBO graph editors.

The root page also shows the discovered ensemble tree. On the intended session
authority, choose **Make this tree coordinator** to claim all online discovered
Shadowscore units. On an individual unit, choose **Join** beside the intended
authority to move only that unit. The choice persists without a restart. An
offline unit is not rewritten; join it after it returns.

## Verify Hardware

Check the session and target maps:

```sh
curl http://<host>.local:8790/session
curl http://<host>.local:8790/coordinator
curl http://<host>.local:8790/hardware/units
curl http://<host>.local:8790/rnbo/devices
curl http://<host>.local:8790/rnbo/targets
curl http://<host>.local:8790/rnbo/transfers
curl http://<host>.local:8790/osc/targets
curl http://<host>.local:8790/playback/timing-contracts
```

The useful reading is:

- `/coordinator` shows this unit's persisted authority selection and the
  Shadowscore-capable units discovered through RNBOOSCQuery Bonjour services.
- `/hardware/units` shows which peer boxes are online.
- `/rnbo/devices` shows RNBO graph editors, including boxes that do not yet
  have a ShadowScoreClient instance loaded.
- `/rnbo/targets` shows the actual ShadowScore OSC targets the host can write to.
- `/rnbo/transfers` collects each target's outgoing rows, receiver-confirmed
  prefix, retry attempt, READY transaction, and ACTIVE transaction. Admin shows
  the same state live; `/rnbo/transfers/events` is its server-sent event stream.
- `/osc/targets` shows RNBO and instrument-control targets exposed to editor
  and macro tools, including filters such as `?app=poland&status=online`.
- `/playback/timing-contracts` shows per-target stage capacity, note-row
  capacity, selected `ClockInterval`, `MaxSteps`, and active-block compilation
  diagnostics.

If a peer advertises an unreachable RNBO host, use Admin's observed-host repair
control. The API form is:

```sh
curl -X POST http://<host>.local:8790/hardware/units/<unitId>/targets/<targetId>/use-observed-host
```

To provision or refresh a peer-local config without manual editing:

```sh
npm run configure-peer -- --id heron
npm run configure-peer -- --id bob
```

This writes `config/shadowscore.peer.local.json` with peer role metadata,
continuous registration settings, local RNBO port `1234`, and the RNBO host
identity used when the peer advertises loopback RNBO targets. Those targets use
`<id>.local` unless `--ip` is supplied as an explicit override. Omit `--host` for
normal operation: the peer discovers the single advertised Shadowscore host
that declares itself coordinator. Supplying `--host` is an explicit static
override and disables coordinator discovery.

When a peer returns with the same `deviceId`, the host reattaches assignment
endpoint fields automatically if the peer advertises exactly one ShadowScore
RNBO target. Locked assignments, assignments without `deviceId`, and peers
with multiple ShadowScore targets are left for manual selection; multiple
targets are marked `ambiguous` in the assignment metadata.

In Admin, use **Refresh routing** after peers reconnect if saved player
assignments still point at stale RNBO endpoints. The action keeps player
identity intact and only refreshes output routing for assignments with a
matching stable `deviceId`.

## Prepare The Score

Use Arrange for:

- selecting the active block;
- editing block durations, written tempos, and shared sequencer Swing/SwingAmt;
- assigning clips to players;
- setting the ordered macrostructure block occurrences.

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
Those belong to Event List and Arrange respectively.

Use Piano Roll for:

- moving note onset and pitch while seeing note duration directly;
- resizing a note from its right edge;
- note-specific velocity edits and keyboard nudges;
- reviewing loop aliases, reference clips, and the live playback wiper;
- autosaving completed gestures while retaining recoverable per-clip drafts and
  Revert; and
- Alt-clicking, right-clicking, or using the keyboard context menu on any visible
  player note to **Move to...** another player. The move is atomic and can create
  and assign a missing destination part in the current block.

Piano Roll is a first-class clip editor for performance timing. Event List
remains the exact-review surface for full clip attributes and advanced note
fields such as probability, deviation, and release velocity. Arrange owns block
duration and player-to-clip assignment and remains served at
`/structure-editor`.

Use `/editors` and its twelve bundled instrument editors, including
SingleHalfKrell and the Block Attributes editor, plus
`/tools/osc-volume` and `/tools/osc-macros`, for instrument-control surfaces.
Persistent control gestures send to the checked live instances and save their
complete canonical block state at the gesture's commit boundary. There is no
separate Write/Reload draft workflow. **Recall Now** remains the explicit
full-state send. Swing and SwingAmt belong to the selected block and distribute
across compatible sequencers; they are not saved independently in each OSC
clip. ListSequencer list controls and ListVelSequencer rows can be rotated in
the browser, and ListVelSequencer row mute buttons write the export's available
mute parameters.

Block TTID also controls ShadowScore playback pitch interpretation. When RNBO
transactions are compiled, notes in clips that follow scale are quantized to
the destination block's TTID without rewriting the stored notes or rooted scale
metadata. Clips with `behavior.followsScale: false` keep their stored pitches.

## Score Operations

Admin exposes the usual session operations:

- New Score replaces the canonical score from the configured ensemble defaults
  and immediately activates the empty replacement on RNBO clients. If the UI
  reports that players could not be updated, the new canonical score was still
  created; restore or reload the intended score before retrying client recovery.
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

Primary performance control routes:

```text
POST /transport/players/play
POST /transport/players/stop
POST /transport/arrangement/run
POST /transport/arrangement/hold
POST /transport/return-to-start
POST /transport/tempo
POST /transport/tempo/follow-block
POST /transport/tempo/use-block
```

Players Play/Stop controls assigned client sound, resolved OSC sequencer
clocks, and JACK transport. Starting also distributes the active block's shared
TTID and Swing state.
Arrangement Run/Hold controls whether form advances without conflating that
choice with whether players sound. Return to Start resets form position and
client stage. The older `/transport/play`, `/transport/stop`, and lower-level
macro/JACK routes remain available for compatibility and diagnostics.

Canonical score edits do not silently change the active RNBO client tables.
When a changed active block should sound, use **Apply next beat** while running
or **Update players now** while stopped. Their API routes are:

```text
GET  /playback/updates
POST /playback/updates/apply-next-beat
POST /playback/updates/update-now
```

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

If Wren remains in `deactivating (stop-sigterm)` during a deploy, check whether
the RNBO graph editor on port `3000` has a transport view open. That view can
hold the server's `/transport/events` SSE connection open. Before the
2026-07-20 shutdown fix, Node waited for that long-lived connection inside
`server.close()` and systemd did not restart the service until its 90-second
stop timeout sent SIGKILL. The server now closes collaboration, SSE, and other
open HTTP connections before flushing persistence, so an open graph editor
must not delay shutdown. Diagnose the old symptom with:

```sh
systemctl status shadowscore-server.service
systemctl show shadowscore-server.service -p ActiveState -p SubState -p MainPID -p TimeoutStopUSec
```

Treat this separately from a transport playback failure: during the shutdown
stall, port `8790` refuses connections while the old Node PID remains visible
in `stop-sigterm`.

If `tools/deploy_pi.sh` syncs files but cannot complete the non-interactive
service restart, re-run with `SHADOWSCORE_SUDO_PASSWORD` for known lab units or
use `--force-restart` for the kill/reset/start recovery path. From an
interactive shell, the manual recovery is:

```sh
ssh pi@<host>.local
sudo systemctl kill -s SIGKILL shadowscore-server.service
sudo systemctl reset-failed shadowscore-server.service
sudo systemctl start shadowscore-server.service
systemctl show shadowscore-server.service --property=MainPID --property=ActiveEnterTimestamp --value
curl http://<host>.local:8790/healthz
curl http://<host>.local:8790/session
curl http://<host>.local:8790/matrix-edit
curl http://<host>.local:8790/event-list
```

When diagnosing, keep these boundaries separate: server score state, peer
registration, RNBO target visibility, transport beat evidence, and actual audio
output.
