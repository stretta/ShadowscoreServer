# Authoritative Transport API

This is the stable client-facing reference for the ShadowScore transport object.
It describes the current server implementation and takes precedence over the
historical transport development plans.

The server owns transport intent and acknowledged state. Browser controls, Max
patches, Shadowbox hardware, and other clients all use the same object API; they
must render the returned or observed state rather than assuming that a command
succeeded locally.

## Endpoints

The default server port is `8790`.

```text
GET  /api/v1/objects/resolve?path=transport
GET  /api/v1/objects/transport
POST /api/v1/objects/transport
GET  /api/v1/objects/transport/events
```

`path=shadow_score%20transport` resolves the same object as `path=transport`.
The resolve response contains the object ID, type, properties, and supported
methods.

## Read authoritative state

```sh
curl http://127.0.0.1:8790/api/v1/objects/transport
```

The response is:

```json
{
  "ok": true,
  "object": {
    "object_id": "transport",
    "path": "shadow_score transport",
    "type": "ShadowScoreTransport",
    "revision": 42,
    "observed_at": "2026-08-19T12:00:00.000Z",
    "authority": "server",
    "clock_source": "jack",
    "is_playing": true,
    "position_beats": 18,
    "position_seconds": 9,
    "position_fraction": 0.28125,
    "position_bbt": "5.3.000",
    "duration_beats": 64,
    "duration_seconds": 32,
    "tempo": 120,
    "time_signature_numerator": 4,
    "time_signature_denominator": 4,
    "active_section": "B",
    "macro_index": 1,
    "beat_into_section": 2,
    "arrangement": {},
    "block_launcher": {},
    "sync": {},
    "capabilities": {}
  }
}
```

`arrangement.sections` describes the macro timeline. `block_launcher.blocks`
lists every mesostructural block, its macro occurrence indices, and whether it
can be launched without leaving the authoritative arrangement. Its active and
requested fields distinguish the currently sounding block from a queued launch.
`sync` reports assigned,
online, and fresh player counts, phase error/skew, tolerances, a state and
reason, and whether re-sync is recommended. `capabilities.can_locate` is true
when the current arrangement has playable duration.

The snapshot is an observation, not proof of audible output. For performance
verification, also require transaction-matched ACTIVE payloads, advancing phase
witnesses, and the relevant physical audio-path evidence.

## Call an operation

POST a direct `operation` name and an `args` object. `request_id` and
`client_id` are optional correlation fields. The field name is `request_id`,
not `requestId`.

```sh
curl -sS http://127.0.0.1:8790/api/v1/objects/transport \
  -H 'content-type: application/json' \
  -d '{
    "request_id": "shadowbox-173",
    "client_id": "shadowbox-stage-left",
    "operation": "locate_fraction",
    "args": { "fraction": 0.5 }
  }'
```

Do not use the obsolete development-plan envelope containing
`operation: "call"`, `name`, or `arguments`.

A successful call returns the operation result and a fresh acknowledged object:

```json
{
  "ok": true,
  "request_id": "shadowbox-173",
  "operation": "locate_fraction",
  "result": {},
  "object": {}
}
```

`request_id` is echoed for correlation; clients should not treat it as a
server-side idempotency key. Non-2xx responses contain an `error` message.

### Operations

| Operation | `args` | Behavior |
| --- | --- | --- |
| `play` | optional revision controls | Starts the available assigned-player cohort and forces Arrangement Run; unavailable assignments are reported as degraded voices. |
| `stop` | optional target/revision controls | Stops assigned players while preserving the arrangement location. |
| `return_to_start` | optional `targetId` and revision controls | Resets the form and writes player stage zero. |
| `locate_beats` | `beats` from `0` through `duration_beats` | Coordinated locate to an absolute composition beat. |
| `locate_fraction` | `fraction` from `0` through `1` | Coordinated locate across the complete arrangement. |
| `set_tempo` | positive `bpm` (or `tempo`) | Changes runtime live tempo and flushes it to the configured authority. |
| `previous_section` | optional revision controls | Cues the previous macro occurrence, wrapping at the start. |
| `next_section` | optional revision controls | Cues the next macro occurrence, wrapping at the end. |
| `launch_meso_block` | `block_id`; optional `macro_index` and revision controls | In Arrangement Run, queues an arranged meso block for the section boundary. In Hold, activates it now when players are stopped or on the next beat while player clocks continue. |
| `set_arrangement_mode` | `mode`: `run` or `hold` | Runs automatic macro advancement or holds the current block while player playback continues. The selected mode persists across player stop/start. |
| `re_sync` | optional target/revision controls | Restarts the coordinated phase at the preserved position. |

Revision controls, where accepted, are `expectedVersion`,
`expectedScoreRevision`, and `expectedStructureRevision` inside `args`.

`launch_meso_block` is random access within the macro arrangement. If a block
appears more than once, `macro_index` selects a specific matching occurrence;
otherwise the first occurrence is used. Blocks that are not present in the
arrangement remain visible in `block_launcher.blocks` with `launchable: false`
and are rejected with HTTP 409 if called directly.

Clients implementing a Blocks workflow should call `set_arrangement_mode` with
`mode: "hold"` when entering that workflow. While held, player clocks continue
but the macrostructure does not advance; `launch_meso_block` is the only form
movement, quantized to the next beat when players are running. A subsequent
`play` may include `arrangement_mode: "hold"` to preserve
that behavior after player playback has been stopped. Returning to a linear
workflow should call `set_arrangement_mode` with `mode: "run"`.

### Coordinated locate

`locate_beats` and `locate_fraction` are implemented transport operations. A
locate resolves the requested composition position to a macro occurrence and
section offset. If playback is running, the server stops the coordinated
transport, activates the destination block on all required clients, stores the
new form position, and restarts with a phase reset at the requested offset. If
playback is stopped, it activates the destination and writes the corresponding
stage without starting playback.

The exact right edge (`fraction: 1` or `beats: duration_beats`) resolves to the
last playable instant rather than wrapping to the beginning. Invalid ranges or
an arrangement with no playable duration are rejected. A participating client
that does not reach ACTIVE causes the locate to fail instead of reporting
success. Known-unavailable assignments remain pending and do not prevent the
available cohort from locating.

## Observe state

`GET /api/v1/objects/transport/events` is a Server-Sent Events stream. It sends
an immediate `snapshot` event followed by revisioned `snapshot` events at the
authoritative publisher cadence. The JSON in each `data:` line is the transport
object itself, not the `{ "ok": true, "object": ... }` GET wrapper.

```js
const events = new EventSource("/api/v1/objects/transport/events");
events.addEventListener("snapshot", (event) => {
  const transport = JSON.parse(event.data);
  renderAcknowledgedTransport(transport);
});
```

The stream can also emit an `error` event whose data contains an `error`
message. Clients should reconnect using normal SSE behavior and replace their
state with the next complete snapshot.

## Integration boundary

New Shadowbox integrations should resolve or address the `transport` object,
send the direct operation envelope above, and consume acknowledged POST state
or SSE snapshots. The older `/transport/*` routes remain compatibility and
operator routes; `/transport/external` has distinct hardware-intent semantics
and is not the canonical object-call envelope.

The working Max adapter is
[`../examples/max/shadowscore-transport-client.cjs`](../examples/max/shadowscore-transport-client.cjs).
