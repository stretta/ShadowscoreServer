# Realtime WebSocket API

ShadowscoreServer exposes a standards-based, read-only realtime gateway at
`/realtime`. It shares standards-based WebSocket connection infrastructure with
the version-1 collaboration endpoint at `/collab`, but their application
protocols, identities, message shapes, and delivery policies remain separate.
`/realtime` does not yet accept score, transport, or playback commands.

## Discovery

`GET /session` advertises:

- `endpoints.realtime`: the `ws://` or `wss://` gateway URL;
- `realtime.protocol`: `shadowscore.realtime.v2`;
- `realtime.roles`: currently `observer`;
- `realtime.topics`: the topics available to that role.

Clients must request the WebSocket subprotocol `shadowscore.realtime.v2` during
the HTTP upgrade. A missing or unsupported subprotocol receives HTTP 426.

## Connection Sequence

The server first sends `hello.required` with a server-generated
`connection_id`, the hello deadline, and the available topics. The client's
first message must then be:

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

`client_id` is optional. When omitted, the server grants a generated client ID.
When a new connection claims an existing stable client ID, the older connection
is closed with code 4001. Client-supplied roles and capabilities are requests;
the `welcome` response contains the granted values.

The server responds with `welcome`, followed by one complete `snapshot` for
each accepted topic. Subsequent publisher changes arrive as `event` messages.

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
complete state wins. Request results and errors are never silently replaced.

## Topics

| Topic | Contents | Update source |
| --- | --- | --- |
| `score` | Complete score snapshot, then revisioned score changes | Score store |
| `transport` | Canonical musician-facing transport object | Shared 500 ms publisher |
| `playback` | Coherent arrangement and participant execution snapshot | Shared 250 ms publisher |
| `playback.transfers` | RNBO transfer progress and receiver acknowledgement | Transfer lifecycle events |

The gateway uses the same publishers as the existing HTTP and SSE routes. It
does not independently poll JACK, RNBO, or the score store.

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

Supported request types are `subscribe`, `unsubscribe`, and `ping`. A repeated
`request_id` with identical content replays its cached result. Reusing an ID
with different content returns an error. Write-like message types return a
`read_only_gateway` error.

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

## Browser Example

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

The future playback-participant protocol will build on this gateway only after
the RNBO participant coordinator has been separately extracted and proven.
