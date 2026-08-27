# Realtime WebSocket API

ShadowscoreServer exposes a standards-based, role- and capability-gated realtime
gateway at `/realtime`. It shares WebSocket connection infrastructure with the
version-1 collaboration endpoint at `/collab`, but their protocols, identities,
message shapes, and delivery policies remain separate. Observer sessions are
read-only. Registered playback sessions can acknowledge server-initiated score
preparation and activation, publish identity-matched execution witnesses, and
reconcile bounded active state after reconnect. The gateway does not accept
score mutation or transport-control commands.

## Discovery

`GET /session` advertises:

- `endpoints.realtime`: the `ws://` or `wss://` gateway URL;
- `realtime.protocol`: `shadowscore.realtime.v2`;
- `realtime.readOnly`: `false` because the playback role accepts participant
  protocol messages;
- `realtime.roles`: `observer` and `playback`;
- `realtime.playbackParticipantProtocolVersion`: currently `1`;
- `realtime.commands`: playback messages accepted from a registered participant;
- `realtime.topics`: topics available for observation.

Clients must request the WebSocket subprotocol `shadowscore.realtime.v2` during
the HTTP upgrade. A missing or unsupported subprotocol receives HTTP 426. The
server's initial `hello.required` message also lists `available_roles`, granted
role capabilities, and the participant protocol version required by the
playback role.

## Connection Sequence

The server first sends `hello.required` with a server-generated
`connection_id`, the hello deadline, available topics, and available roles. An
observer's first message is:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "hello",
  "request_id": "hello-1",
  "client_id": "ableton-laptop-1",
  "role": "observer",
  "topics": ["transport", "playback"]
}
```

`client_id` is optional for observers. When omitted, the server grants a
generated client ID. When a new connection claims an existing client ID, the
older connection is closed with code 4001. The server responds with `welcome`,
followed by one complete `snapshot` for each accepted topic. Subsequent
publisher changes arrive as `event` messages.

### Playback participant hello

A software playback client requests the `playback` role and includes a
participant declaration:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "hello",
  "request_id": "hello-player-1",
  "client_id": "software-player-1",
  "role": "playback",
  "topics": ["transport", "playback", "participants"],
  "participant": {
    "protocol_version": 1,
    "stable_device_id": "stage-left-laptop",
    "display_name": "Stage Left Software Player",
    "capabilities": ["score:prepare", "score:activate", "execution:witness"],
    "runtime": {
      "name": "shadow-player",
      "version": "1.4.0",
      "platform": "macOS"
    }
  }
}
```

`stable_device_id` defaults to `client_id`; `display_name` and `runtime` are
optional. Participant capabilities are declarations used by the playback
adapter to authorize operations. `welcome.payload.participant` returns the
server participant ID (`realtime:<client_id>`), accepted participant protocol
version, stable device ID, and declared capabilities. A voice must be assigned
to that participant by `clientId` or matching stable `deviceId` before the
participant joins a playback cohort.

## Envelope

Every server message uses this envelope:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "snapshot",
  "topic": "transport",
  "request_id": null,
  "client_id": "ableton-laptop-1",
  "connection_id": "server-generated-uuid",
  "sequence": 42,
  "observed_at": "2026-08-25T17:00:00.000Z",
  "payload": {
    "topic_version": 1,
    "event_type": "snapshot",
    "value": {}
  }
}
```

Sequences are monotonic within a topic for the life of the server process.
Snapshots and topic events are replaceable under backpressure; the newest
complete state wins. Request results, playback commands, and errors are never
silently replaced.

## Topics

| Topic | Contents | Update source |
| --- | --- | --- |
| `score` | Complete score snapshot, then revisioned score changes | Score store |
| `transport` | Canonical musician-facing transport object | Shared 500 ms publisher |
| `playback` | Coherent arrangement and participant execution snapshot | Shared 250 ms publisher |
| `playback.transfers` | RNBO transfer progress and receiver acknowledgement | Transfer lifecycle events |
| `participants` | Normalized RNBO targets, connected software sessions, and assignment resolutions | Registry lifecycle events and bounded RNBO refresh |

The gateway uses the same publishers as the existing HTTP and SSE routes. It
does not independently poll JACK, RNBO, or the score store.

The `participants` topic is inventory and liveness, not playback authority. An
observer session is not registered as a software playback participant. A
playback session is registered but receives prepare or activation operations
only when its assignment and declared capabilities match. Hardware units remain
available through their existing APIs and are projected into this topic through
their RNBO targets.

Each participant descriptor includes `participant_id`, `stable_device_id`,
`kind`, `adapter`, `status`, `available`, `capabilities`, transport-specific
`endpoint` metadata, `last_seen_at`, and `expires_at`. Assignment resolutions
report exact, stable-device, ambiguous, missing, locked-missing, offline, or
unassigned state without rewriting the score assignment.

## Subscription Requests

After `welcome`, subscriptions can be changed with correlated requests:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "subscribe",
  "request_id": "subscribe-7",
  "topics": ["score", "playback.transfers"]
}
```

All roles support `subscribe`, `unsubscribe`, and `ping`. A registered playback
role also supports `playback.ready`, `playback.active`, `playback.execution`,
and `playback.reconciled`, as described below. A repeated `request_id` with
identical content replays its cached result. Reusing an ID with different
content returns an error. Unsupported or write-like message types return a
`read_only_gateway` error.

## Playback Participant Protocol

Playback exchange is server-initiated and fail-closed. A participant cannot
start transport or choose its own score. The server selects assigned software
participants, sends an operation, and waits for an exact acknowledgement on the
same connection. Every client response requires a unique `request_id`; the
gateway returns a correlated `result` or `error` envelope.

| Server message | Required declaration | Client response | Required identity |
| --- | --- | --- | --- |
| `playback.prepare` | `score:prepare` | `playback.ready` | `operation_id`, `block_id`, `score_revision`, `payload_hash` |
| `playback.activate` | `score:activate` | `playback.active` | Prepare identity plus `prepared_operation_id` |
| Active playback | `execution:witness` | `playback.execution` | Active operation identity plus `execution` |
| `playback.reconcile` after reconnect | `execution:witness` | `playback.reconciled` | Retained active identity plus `state` and, when active, `execution` |

`playback.prepare.payload.desired` uses schema
`shadowscore.playback-score.v1`. It contains the canonical score and structure
revisions, ensemble and block IDs, assigned voice IDs, context, block timing and
scale data, and the assigned clips. A READY acknowledgement must echo the
server's operation, block, revision, and SHA-256 payload hash exactly:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "playback.ready",
  "request_id": "ready-17",
  "payload": {
    "operation_id": "prepare-17",
    "block_id": "B",
    "score_revision": 42,
    "payload_hash": "server-supplied-sha256"
  }
}
```

After every participant in that prepare cohort is READY, the server can send
`playback.activate`. The participant activates the exact prepared payload at the
requested `boundary` and `position`, then answers `playback.active` with the
activation `operation_id`, original `prepared_operation_id`, `block_id`,
`score_revision`, and `payload_hash`. Mismatched, missing, late,
replaced-connection, or timed-out acknowledgements fail the coordinated
operation.

### Execution witnesses

ACTIVE acknowledges activation, not execution. A participant declaring
`execution:witness` proves continuing playback with `playback.execution`:

```json
{
  "protocol": "shadowscore.realtime.v2",
  "type": "playback.execution",
  "request_id": "execution-81",
  "payload": {
    "operation_id": "activate-17",
    "prepared_operation_id": "prepare-17",
    "block_id": "B",
    "score_revision": 42,
    "payload_hash": "server-supplied-sha256",
    "execution": {
      "sequence": 81,
      "playing": true,
      "position": {
        "absolute_beat": 18,
        "beat_into_block": 2,
        "seconds": 9
      }
    }
  }
}
```

`execution.sequence` must be a non-negative safe integer and strictly increase
on the connection. `position.absolute_beat` is required and non-negative;
`seconds`, `beat_into_block`, and `block_beat` are optional non-negative
numbers. The server reports a witness as advancing only after both the sequence
and absolute beat increase while `playing` is true. Stale, stationary, or
identity-mismatched witnesses are not execution proof.

### Reconnect reconciliation

Disconnect removes READY state and current execution evidence. If the
participant had an ACTIVE payload, the server retains its exact identity for a
bounded reconciliation window. Reconnecting with the same `client_id` and
`execution:witness` capability can receive `playback.reconcile`. The client must
answer `playback.reconciled` with the echoed operation identity and either:

- `state: "idle"`, which clears the retained active assumption; or
- `state: "active"` plus a valid execution object, which restores ACTIVE state
  and records a fresh execution witness.

The server never infers active execution merely from reconnection. Expired,
wrong-connection, or identity-mismatched reconciliation responses fail closed.

## Limits and Liveness

- Maximum incoming message: 256 KiB.
- Maximum fragment and buffered-chunk counts: 64 each.
- Per-connection application queue: 64 messages or 1 MiB.
- Server heartbeat: ping every 15 seconds; stale after 45 seconds.
- Hello deadline: 5 seconds.
- Binary application messages are rejected.
- Compression is disabled for deterministic resource use.

The server coalesces replaceable topic state for a slow connection. If bounded
queues are still exceeded, it closes the connection instead of allowing
unbounded memory growth.

## Browser Observer Example

```js
const socket = new WebSocket(session.endpoints.realtime, session.realtime.protocol);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    protocol: session.realtime.protocol,
    type: "hello",
    client_id: "browser-monitor",
    role: "observer",
    topics: ["transport", "playback"]
  }));
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  console.log(message.type, message.topic, message.payload);
});
```

Observer clients should use the simpler read-only hello above. Only software
that actually executes assigned score material should request the playback role.
