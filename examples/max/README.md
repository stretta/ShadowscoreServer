# ShadowScore transport from Max

`shadowscore-transport-client.cjs` is a small Node for Max adapter with roles analogous to Ableton's Live API objects:

| Live API role | ShadowScore message | Result |
| --- | --- | --- |
| `live.path` | `path shadow_score transport` | Resolves the stable `transport` object and reports its descriptor. |
| `live.object` | `get`, `call play`, `call stop`, `call set_tempo {"bpm":76}` | Reads or invokes the authoritative object. |
| `live.observer` | `observe 1` / `observe 0` | Starts or stops revisioned state observation. |

Add a `node.script shadowscore-transport-client.cjs` object, then send:

```text
host wren.local
path shadow_score transport
observe 1
call play
call set_tempo {"bpm":76}
call re_sync
call stop
```

The first outlet prefixes state messages (`playing`, `position_beats`, `position_seconds`, `position_bbt`, `tempo`, `section`, and `sync`) so a patch can route only the properties it needs. `state` also carries the complete JSON object. The server remains authoritative; Max sends intent and renders acknowledged state.
