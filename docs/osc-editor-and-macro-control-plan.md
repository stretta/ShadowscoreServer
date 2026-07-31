# OSC Editor And Macro Control Plan

## Goal

Build a family of browser-based OSC instrument editors and performance
utilities on top of ShadowscoreServer's existing live hardware and RNBO target
model.

The first concrete instrument editor is Poland. Poland already has the desired
musical UI and should not be redesigned for this effort. The work is to let
that existing UI edit live Poland instances running on local Raspberry Pi
clients through ShadowscoreServer-managed discovery, routing, and OSC send
paths.

The first concrete performance utility is all-local volume control. It should
send a shared volume gesture to every selected local OSC/RNBO-capable instance
without requiring the user to manually track hostnames, IP addresses, instance
ids, or stale endpoint details.

## Product Shape

There are two related tool families that share the same backend substrate.

### Instrument Editors

Instrument editors are bespoke, archetype-aware browser apps. They are musical
interfaces, not generic RNBO parameter dumps.

Examples:

- **Poland**: PPG Wave-style wavetable instrument editor.
- **Element**: Roland Juno-style single-oscillator subtractive synth editor.
- Future instruments: each owns its own visual and musical editing model.

Each editor should keep its own UI language and parameter semantics. For
Poland, this means preserving the existing Poland UI and adding only the target
selection and transport adapter needed to talk to live local instances.

#### Editor Data Model

Every Shadowscore OSC editor follows the same read/write contract while
retaining its instrument-specific controls:

- RNBO parameters are the preferred scalar control type. RNBOOSCQuery exposes
  their current values, so an editor can hydrate them directly from a running
  instance.
- RNBO parameters do not carry lists. Instruments that need list-valued state
  use OSC message inports to set the list and paired OSC message outports to
  acknowledge or query it. RNBOOSCQuery does not remember that list state as a
  parameter, so the patch must implement the query/ACK behavior.
- RNBO's Graph editor is useful for arbitrary parameter editing on one local
  RNBO instance. Shadowscore's OSC editors add ensemble routing: the same edit
  can be sent to selected instances across devices.

The UI keeps reads and writes independent:

- **Get data from** selects exactly one discovered instance. **Get Data** fills
  every displayed parameter from that instance's OSCQuery parameter tree and,
  when present, fills OSC-list fields through their paired ACK outports.
- **Send data to** uses independent target checkboxes. Parameter changes and
  OSC-field sends fan out to one or more checked instances.

Choosing a read source never changes the write targets, and selecting write
targets never changes the read source.

### OSC Utility Tools

OSC utilities are cross-instrument performance and operations tools.

Examples:

- all-local volume
- mute, solo, or trim groups
- panic or all-notes-off
- preset recall across multiple boxes
- calibration/setup commands
- named macros that send different OSC messages to different clients

These tools are not owned by Poland or any other single instrument. They should
live as ShadowscoreServer-hosted utilities that use the same live target
registry as the instrument editors.

## Ownership Boundaries

- **ShadowscoreServer** owns live unit discovery, health, stale endpoint
  reconciliation, target listing, browser hosting, OSC send/broadcast, and macro
  execution.
- **Shadowbox** remains a runtime and physical-control surface for local RNBO
  instances. It may eventually expose selected presets or runtime controls, but
  it is not the primary authoring UI for this plan.
- **Smol/Poland** owns the Poland editor UI, Poland parameter semantics, and
  Poland preset source artifacts.
- **Future instrument repos or packages** own their own editor bundles and
  instrument-specific UI schemas.

The laptop browser is the primary authoring surface. A user should be able to
open a ShadowscoreServer-hosted Poland page from a laptop, choose one or more
live Poland instances on the LAN, edit through the existing Poland UI, and save
or export useful states into Poland-owned preset files for later bundling.

## Target Model

ShadowscoreServer already has the difficult substrate:

- peer registration
- `/hardware/units`
- `/rnbo/targets`
- live target health
- stale endpoint handling through stable hardware identity

This plan adds a more general OSC-control target layer over that substrate.

Conceptual target shape:

```json
{
  "id": "finch:poland:main",
  "unitId": "finch",
  "deviceId": "finch",
  "label": "Finch Poland",
  "app": "poland",
  "instance": "main",
  "kind": "rnbo",
  "status": "online",
  "host": "192.168.68.101",
  "port": 1234,
  "baseAddress": "/rnbo/inst/1",
  "capabilities": ["volume", "preset", "poland-edit"]
}
```

Rules:

- UI clients select stable target ids, not raw IP/port/path tuples.
- Endpoint fields are current routing details and may change.
- Stable hardware identity is used to recover when clients disappear and return.
- A target can be visible but unavailable, stale, ambiguous, or offline.
- Instrument editors can filter by `app`, such as `poland` or `element`.
- Utility tools can filter by capability, such as `volume`.

## HTTP API Draft

Add focused routes rather than expanding score-owned assignment routes.

### List OSC Targets

```http
GET /osc/targets
GET /osc/targets?app=poland
GET /osc/targets?capability=volume
```

Returns normalized live and recently known OSC-controllable targets.

### Manually Configured OSCQuery Devices

Admin can supplement local and peer discovery with a directly configured
OSCQuery endpoint. A saved device is re-queried and its RNBO instances enter
the same normalized target lists as discovered instances.

```http
GET    /oscquery/devices
POST   /oscquery/devices/probe
POST   /oscquery/devices
PATCH  /oscquery/devices/:deviceId
DELETE /oscquery/devices/:deviceId
POST   /oscquery/devices/:deviceId/refresh
```

The configured record stores the OSCQuery URL, OSC destination host and port,
and a friendly name. It does not store a frozen instance inventory. The server
continues to derive parameters, message inports, metadata, and editor
classification from the live OSCQuery tree.

The response should include enough status for browser clients to distinguish:

- online and sendable
- offline but known
- stale endpoint
- ambiguous multi-instance target
- not capable of the requested command

### Send One OSC Message

```http
POST /osc/send
```

Request:

```json
{
  "targets": ["finch:poland:main", "heron:poland:main"],
  "address": "/poland/volume",
  "args": [0.7]
}
```

The server resolves each stable target id to the current endpoint and sends the
message. The response reports per-target success or failure.

### Broadcast By Query

```http
POST /osc/broadcast
```

Request:

```json
{
  "where": {
    "capability": "volume",
    "status": "online"
  },
  "address": "/volume",
  "args": [0.5]
}
```

This is the core path for all-local volume and other shared gestures.

### Macro Routes

```http
GET /osc/macros
POST /osc/macros
POST /osc/macros/run
POST /osc/macros/:macroId/run
POST /osc/block-state/capture
```

Macro shape:

```json
{
  "id": "soft-start-room",
  "label": "Soft Start Room",
  "steps": [
    {
      "target": "finch:poland:main",
      "address": "/poland/volume",
      "args": [0.4]
    },
    {
      "target": "heron:element:main",
      "address": "/element/filter/cutoff",
      "args": [900]
    }
  ]
}
```

Fixed-target steps remain supported. Semantic steps can instead store a live
selector and resolve every matching target at execution time:

```json
{
  "where": {
    "capability": "ttid-edit",
    "status": "online",
    "parameter": "ScalarTranspose"
  },
  "param": "ScalarTranspose",
  "args": [3]
}
```

`POST /osc/macros/run` executes or dry-runs an inline macro without saving the
macro definition. This is the control path for gestural utilities such as
ensemble transpose. Execution is live and non-persistent. The separate
`POST /osc/block-state/capture` action captures complete state from explicitly
selected live targets into role-specific snapshots for one EDITING block.

## Editor Hosting Model

Host editor bundles from ShadowscoreServer under stable routes.

Examples:

- `/editors/poland`
- `/editors/element`
- `/tools/osc-volume`
- `/tools/osc-macros`

Each editor bundle should be allowed to keep its own build system and source
repo. The server-hosted copy is a distribution artifact, similar in spirit to
the Matrix Edit bundle.

For Poland:

1. Keep the existing Poland UI intact.
2. Add or wrap a transport adapter that can send edits through
   ShadowscoreServer.
3. Add a target chooser fed by `/osc/targets?app=poland`.
4. Preserve Poland-owned preset export and bundle workflows.

The target chooser should be surrounding application chrome or a small
integration layer. It should not force changes to the Poland editing surface
unless Poland itself needs them.

## Preset Workflow

The desired authoring loop is:

1. A laptop browser opens the Poland editor from ShadowscoreServer.
2. The editor lists live Poland instances discovered through the server.
3. The user selects one or more instances.
4. Existing Poland controls send OSC to the selected live targets.
5. The user saves an interesting state as a Poland preset.
6. The preset is written or exported into Poland/Smol-owned source artifacts.
7. A later Poland build bundles those presets.
8. Shadowbox can eventually expose the bundled presets as runtime choices.

This keeps authoring and runtime roles separate:

- laptop browser: rich editing and preset design
- ShadowscoreServer: routing brain and OSC broker
- Shadowbox: runtime control surface and local performance access

## Implementation Phases

Status as of the current implementation pass:

- Phase 1 through Phase 7 are implemented in ShadowscoreServer.
- The implemented routes and hosted pages have been deployed to `wren.local`.
- Live verification used the three online Poland instances on `wren`, `heron`,
  and `raven`.
- Follow-on work remains for deeper Poland preset export, richer macro/group
  semantics, and adding Element as the next editor.

### Phase 1: Target Inventory - Complete

- Add an internal `osc-targets` service that derives normalized targets from
  existing hardware units and RNBO target state.
- Expose `GET /osc/targets`.
- Include status, app, instance, label, endpoint, and capability fields.
- Start with explicit or convention-based app detection for Poland rather than
  solving every future instrument shape.
- Add tests for online, offline, stale, and filtered target responses.

Implemented notes:

- Added normalized OSC control targets derived from local RNBO discovery and
  peer registration.
- Added Poland target detection from RNBOOSCQuery metadata and parameter shape.
- Extended peer registration with `oscTargets` so editor/control targets stay
  separate from score playback targets.

### Phase 2: OSC Send Path - Complete

- Add `POST /osc/send`.
- Reuse the existing OSC adapter where possible.
- Resolve stable target ids at send time.
- Return per-target delivery results.
- Reject sends to stale or offline targets unless the request explicitly allows
  best-effort behavior.
- Add tests for single target, multi-target, missing target, and offline target
  behavior.

Implemented notes:

- Added `POST /osc/send` and `POST /osc/broadcast`.
- Added named parameter sends via `param` or `parameter`, resolving each
  target's concrete OSC parameter address at send time.
- Live verification resolved `VolA` for `wren`, `heron`, and `raven`.

### Phase 3: Poland Integration - Complete

- Export or copy the existing Poland editor bundle into ShadowscoreServer.
- Serve it under `/editors/poland`.
- Add a minimal integration layer:
  - fetch `/osc/targets?app=poland`
  - select one or more targets
  - route Poland's existing OSC edits through `/osc/send`
- Preserve Poland UI behavior and visual design.
- Verify against one live Poland instance, then multiple live instances.

Implemented notes:

- Added `/editors/poland`.
- Reused the existing Poland control grouping and labels from the Smol/Poland
  UI instead of presenting a generic parameter dump.
- Added target selection fed by `/osc/targets?app=poland&status=online`.
- Live verification showed the page on `wren.local` and all three Poland
  targets online.

### Phase 4: All-Local Volume Tool - Complete

- Add a simple `/tools/osc-volume` browser page.
- List all online targets with `volume` capability.
- Provide:
  - master volume
  - per-target enable/disable
  - optional per-target trim
- Send via `/osc/broadcast` or `/osc/send`.
- Verify that the same gesture can address all current local instances without
  manual endpoint editing.

Implemented notes:

- Added `/tools/osc-volume`.
- Added master volume, per-target enable/disable, and per-target trim.
- The tool scans online OSC targets with editable parameters and lets the user
  map the canonical volume gesture to the actual parameter each target should
  receive.
- `VolA` and `VolB` remain useful Poland candidates, but they are no longer
  hard-coded as the only user-facing concept.

### Phase 5: Macro Tool - Complete

- Add macro persistence in a small server-owned JSON file or existing local
  data directory.
- Add macro list/create/run routes.
- Add a browser macro launcher.
- Support simple ordered steps first.
- Add dry-run validation before execution so stale targets are visible.

Implemented notes:

- Added macro persistence and routes:
  - `GET /osc/macros`
  - `POST /osc/macros`
  - `POST /osc/macros/:macroId/run`
- Added `/tools/osc-macros`.
- Added dry-run validation.
- Added macro steps that can use `param` instead of raw `address`, allowing
  each target to resolve its own concrete RNBO parameter path.
- Live verification saved and dry-ran `poland-vola-zero`, resolving:
  - `wren:poland:main` to `/rnbo/inst/1/params/VolA`
  - `heron:poland:main` to `/rnbo/inst/9/params/VolA`
  - `raven:poland:main` to `/rnbo/inst/10/params/VolA`

### Phase 6: Generalize Editor Registration - Complete

- Add an editor manifest convention:

```json
{
  "id": "poland",
  "label": "Poland",
  "route": "/editors/poland",
  "targetFilter": {
    "app": "poland"
  }
}
```

- Use this to list available editors on an index page.
- Add Element as the second instrument editor once Poland proves the shape.

Implemented notes:

- Added `config.editors`.
- Added `GET /editors/manifest`.
- Added `/editors` as a hosted editor index.
- Registered Poland as the first manifest entry.
- Updated the dashboard to link to `/editors`.

### Phase 7: Semantic Ensemble Transpose - Complete

- Extend macro steps with dynamic `where` selectors while preserving existing
  fixed-target macros.
- Resolve current online targets by capability and exact standardized
  parameter name at dry-run or execution time.
- Add absolute live controls for `ChromaticTranspose` and `ScalarTranspose` to
  `/tools/osc-macros`.
- Validate each target's published parameter range before sending and report
  expanded target results individually.
- Keep live execution non-persistent: it changes running RNBO instances without
  changing TTID or score-owned OSC snapshots.
- Add an explicit block selector and capture action. Capture reads each
  compatible instance's complete live state and atomically writes its
  role-specific snapshot only to the selected EDITING block.
- Browser MIDI input and HTTPS deployment are intentionally deferred.
- Fixed static route precedence so `/editors/poland` remains more specific
  than `/editors`.

## Test And Verification Plan

Automated tests:

- target normalization from registered units and RNBO targets
- target filtering by app and capability
- stale/offline target status
- `/osc/send` request validation
- per-target send result reporting
- macro validation and run ordering
- semantic macro target expansion and per-target range validation
- atomic multi-target capture into one EDITING block

Live verification:

- Start ShadowscoreServer on the host unit.
- Confirm `/healthz`.
- Confirm `/hardware/units` sees local peers.
- Confirm `/rnbo/targets` sees live RNBO instances.
- Confirm `/osc/targets?app=poland` lists the expected Poland instances.
- Use the Poland editor from a laptop browser to edit one live target.
- Select multiple Poland targets and confirm a shared edit reaches both.
- Use the volume tool to change all local capable instances.
- Power-cycle or restart a peer and confirm stale endpoint behavior is visible
  and then repaired through normal registration.

## Open Questions

- How should a Poland RNBO instance advertise that it is Poland: target label,
  metadata, patcher name convention, explicit registration payload, or OSCQuery
  metadata?
- Should preset export write directly into the Smol/Poland source tree, download
  a file in the browser, or stage the preset in ShadowscoreServer for later
  import?
- Should `/osc/broadcast` expand target groups at request time only, or can a
  group be saved as a durable object?
- Which volume address should be canonical across instruments, and do some
  instruments need address mapping?
- Should macro execution be fire-and-forget, return only transport success, or
  support acknowledgement/readback when the target exposes it?

## Non-Goals

- Do not redesign the Poland UI.
- Do not make Shadowbox the primary authoring UI for instrument editors.
- Do not replace OSCQuery or RNBO Runner discovery with a frozen manual target
  inventory. Directly configured OSCQuery endpoints may supplement automatic
  discovery, but their live instance lists still come from OSCQuery.
- Do not store raw IP/port/path tuples as the primary user-facing selection.
- Do not make generic slider walls the main editor experience for archetypal
  instruments.
