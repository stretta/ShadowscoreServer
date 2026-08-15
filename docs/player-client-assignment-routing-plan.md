# Player, Client, and Assignment Routing Plan

## Goal

Preserve stable score players while making runtime clients disposable,
discoverable, assignable, and safely reattachable.

The score should not assume that a particular hardware unit is always present.
Players are stable musical lanes in the score. Clients are runtime output
capabilities that can appear, disappear, restart, or change their RNBO instance
paths. Assignments are the routing layer that says which client target should
render a given player's musical material.

## Model

- **Player**: a stable score identity, such as `player-1` or `player-2`.
  Players own musical role, clip assignments, labels, colors, lock state, and
  edit context.
- **Client**: a runtime output device or process, such as `heron`, `bob`,
  `bill`, `glenda`, a browser, or an RNBO target. Clients may come and go.
- **Assignment**: the routing from a score player to a currently advertised
  client target.

The durable assignment identity should be the client identity, not the volatile
RNBO endpoint. For example, `deviceId` or `hardwareUnitId` should be treated as
the stable client identity, while `rnboTargetId`, host, port, and address are
the current transport endpoint.

```json
{
  "deviceId": "heron",
  "rnboTargetId": "heron:rnbo-inst-7:shadowscore",
  "rnboHost": "192.168.68.101",
  "rnboPort": 1234,
  "rnboAddress": "/rnbo/inst/7/messages/in/shadowscore"
}
```

## Current Problem

The existing surfaces mostly support the right model already:

- peer registration advertises hardware units and RNBO targets
- `/hardware/units`, `/rnbo/targets`, and `/session` expose runtime clients
- Admin and Matrix Edit can list RNBO targets and write player assignments
- score assignment state can persist player-to-target routing

The fragile part is that endpoint details are stored directly in the player
assignment. When a client returns with a new RNBO instance path, a new IP, or a
new target id, the score can still point at stale endpoint details even though
the same logical client is online again.

## Development Work

### 1. Reconcile Assignments On Peer Registration

Status: implemented. `POST /hardware/register` now reconciles score
assignments whose stable `deviceId` matches the registered unit.

When `POST /hardware/register` receives a peer unit:

1. Normalize and store the registered hardware unit as it does today.
2. Find score assignments where `assignment.deviceId === unit.id`.
3. If the unit advertises exactly one ShadowScore RNBO target, refresh that
   assignment's endpoint fields:
   - `rnboTargetId`
   - `rnboHost`
   - `rnboPort`
   - `rnboAddress`
4. Preserve the player's musical state and presentation fields:
   - clips and mesostructure assignments
   - `assignee`
   - `deviceId`
   - `clientId`
   - `label`
   - `color`
   - `locked`
5. Emit the normal score change events so Admin, Matrix Edit, and SSE/WebSocket
   clients update without a manual refresh.

This makes a returning client reattach by stable identity even if its concrete
RNBO endpoint changed from, for example, `heron:rnbo-inst-9:shadowscore` to
`heron:rnbo-inst-7:shadowscore`.

### 2. Add Safe Reconciliation Rules

Status: implemented for registration-time rebinding. Ambiguous multi-target
clients are marked on the assignment and exact endpoint matches are no-ops.

Automatic reconciliation should be conservative:

- Do not auto-rebind if `assignment.locked === true`.
- Do not auto-bind a player that has no stable `deviceId`.
- Do not auto-select if a unit advertises multiple ShadowScore RNBO targets.
  Mark the assignment as ambiguous and require manual selection.
- If a client disappears, keep the player assignment intact, but expose the
  target as offline/unavailable.
- If a registered client target exactly matches an existing assignment, treat it
  as a no-op.

### 3. Make Peer Provisioning Repeatable

Status: implemented as `npm run configure-peer`.

Add a command or deploy helper path that writes a peer-local config without
manual editing:

```sh
npm run configure-peer -- --id heron
```

The command should create or update `config/shadowscore.peer.local.json` with:

- `server.role: "peer"`
- `server.hostIdentity`
- `server.advertisedName`
- coordinator discovery settings, with `registration.sessionHostUrl` reserved
  for an explicit static override
- `rnbo.port: 1234`
- RNBO host identity derived from `server.hostIdentity`, with an explicit
  address override only when requested

It should be usable for arbitrary client names, not only bird names:

```sh
npm run configure-peer -- --id bob
```

Future work: optionally extend `tools/deploy_pi.sh --role peer` so deployment
can provision or update this config and restart
`shadowscore-registration-agent.service`.

### 4. Improve Admin And Matrix Edit Assignment UX

Status: implemented. Admin and Matrix Edit now separate player lanes from live
client targets, show routing status, group targets by hardware identity,
preserve stale offline selections visibly, and expose a manual Admin routing
refresh action through `POST /assignments/reconcile`.

Admin and Matrix Edit should make the model obvious:

- show stable players as score lanes
- show live clients as runtime output destinations
- distinguish "assigned but offline" from "unassigned"
- group live targets by hardware/client identity
- allow assigning any live target to any player
- add a "refresh/rebind by device identity" action for stale assignments

The RNBO Clients menu should list every live target advertised through
`/session` or `/rnbo/targets`. Choosing a target should update only the routing
for the selected player, not change the player's score identity.

### 5. Optional Presets

Known rigs can still have assignment presets, but presets should be optional
policy, not the base model.

Examples:

- `birds`: `finch`, `heron`, `raven`, `wren`
- `classroom-a`: `bob`, `bill`, `glenda`, `wren`

Applying a preset should set stable `deviceId` values for players. Runtime
registration then reconciles endpoint details as clients appear.

## Test Plan

Add focused tests for:

- peer registration updates stale RNBO endpoint fields when `deviceId` matches
- locked assignments do not auto-rebind
- assignments with no `deviceId` do not auto-bind
- multiple ShadowScore targets from one client are left ambiguous
- disappearing clients preserve assignment state but appear offline
- exact target matches are no-ops
- the peer config generator writes the expected local config
- `/session` and `/rnbo/targets` expose enough state for Admin and Matrix Edit
  to show live assignable clients

## Operator Documentation

Update operator-facing docs after implementation:

- Player equals stable score lane.
- Client equals runtime output capability.
- Assignment equals player-to-client routing.
- Peer registration agents should run continuously.
- New clients can be named freely, for example `bob`, `bill`, or `glenda`.
- If a client returns with the same identity, the host should reattach it when
  safe.

## Implementation Order

1. Add assignment reconciliation in the peer registration path.
2. Add tests for rebind, locked, no-device, and ambiguous cases.
3. Add the peer config generator or deploy helper.
4. Update Admin and Matrix Edit display states if needed.
5. Update README/operator docs.
6. Deploy to `wren` and verify with live peer registration plus
   `/rnbo/targets`, `/hardware/units`, and `/playback/timing-contracts`.
