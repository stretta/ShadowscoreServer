# Editor Revision And Draft Framework Plan

## Goal

Create a durable browser-side framework for keeping ShadowScore editors in sync
with server-owned score state without each editor page inventing its own stale
data and local-draft rules.

The immediate symptom is that Structure Editor, Matrix Edit, and Event List can
depend on overlapping score data. A page may optimistically show an edit, then
receive a server refresh or event from another page and replace the local UI
with stale or unrelated state. The long-term fix is a shared state layer that
knows which data is canonical, which data is locally drafted, and which derived
views are stale.

## Current Problems

- Each editor independently opens `/events`, reads `/score` or `/session`, and
  decides when to refresh.
- Dirty local form state is page-local. Incoming server snapshots can still
  replace the underlying `state.score` that later renders or saves depend on.
- Revision tracking is exposed by the server, but each editor must decide how
  to compare revisions and which UI to rebuild.
- Dependencies are implicit. For example, Matrix Edit depends on block duration,
  clip assignment, timing contracts, RNBO targets, and clip contents, but owns
  only the clip/grid editing workflow.
- Save failures and stale writes do not yet have one shared recovery pattern.

## Ownership Boundaries

Define editor ownership explicitly. Each editor may read broad score context,
but it should declare the resources it edits.

- Structure Editor owns mesostructure blocks, macrostructure, block duration,
  player-to-clip assignment, and active structure editing controls.
- Matrix Edit owns the selected clip's performance-grid edits when editing
  through a block/player projection.
- Event List owns exact clip event data and clip attributes.
- Admin owns reset, restore, new-score, and assignment preset operations.
- The server owns canonical score, structure, revisions, and normalization.

This ownership model should become code-level metadata in the shared client
state layer, not only documentation.

## Shared Client State Layer

Add a small shared browser module, initially under `public/shared/`, for static
server-hosted editors:

```text
public/shared/shadowscore-client-state.js
```

Later, Matrix Edit can either consume the same static module from the server or
move the module into a source package that exports to both `matrixedit` and
`ShadowscoreServer`.

The module should own:

- Server URL normalization
- Initial `/session`, `/score`, and `/structure` load
- `/events` connection and snapshot handling
- `scoreRevision` and `structureRevision` tracking
- Local draft storage keyed by resource
- Effective score projection: server snapshot plus local draft overlays
- Conflict and stale-dependency flags
- Save helpers with expected revision fields
- Subscription callbacks for page rendering

## Resource Keys

Use stable resource keys so draft, conflict, and save behavior can be generic.

Examples:

```text
mesostructure:A
macrostructure
clip:a-player-1
clip:a-player-1:notes
assignment:player-1
context:grid
structureState
```

Each draft record should include:

```js
{
  key: "mesostructure:A",
  value: {},
  baseScoreRevision: 11070,
  baseStructureRevision: 4,
  dirty: true,
  conflict: false,
  staleDependencies: []
}
```

## Update Policy

All editor pages should use the same incoming-update rules.

1. If no local draft exists for the changed resource, apply the server update.
2. If a local draft exists for the changed resource, keep the draft and mark a
   conflict when the server revision has advanced past the draft base revision.
3. If an incoming server update changes a dependency of the current editor,
   mark that dependency stale and refresh derived UI from the effective score.
4. If the server changes unrelated data, update the canonical snapshot quietly.
5. If the selected resource disappears, keep the draft visible if it is dirty;
   otherwise select the nearest valid resource.
6. If a reset, restore, or new-score event arrives, mark all drafts conflicted
   unless the current editor explicitly discards them.

Editors should render `effectiveScore()` instead of raw server snapshots.

## Save Policy

Every save should include the revision values the draft was based on:

```json
{
  "expectedVersion": 11070,
  "expectedScoreRevision": 11070,
  "expectedStructureRevision": 4
}
```

Server endpoints should reject stale writes with structured errors:

```json
{
  "ok": false,
  "error": "stale structure revision",
  "currentVersion": 11072,
  "currentScoreRevision": 11072,
  "currentStructureRevision": 5
}
```

Client recovery should be shared:

1. Fetch current score/session state.
2. Preserve the local draft.
3. Mark the draft conflicted.
4. Let the editor show save/revert/rebase choices.

## Server Work

The server already exposes `scoreRevision` and `structureRevision` on key read
surfaces. The next server pass should add explicit expected-revision validation
for writes where revision precision matters.

Required surfaces:

- `/mesostructure/:blockId`
- `/macrostructure`
- `/clips/:clipId`
- `/context`
- `/admin/restore`
- Collaboration/WebSocket command equivalents

The server should continue to return the full normalized score after successful
writes so the shared client state can adopt the canonical result immediately.

## Phase 1: Shared Store Skeleton

Create `public/shared/shadowscore-client-state.js`.

Implement:

- `createShadowScoreClientState({ serverUrl })`
- `load()`
- `connectEvents()`
- `close()`
- `subscribe(listener)`
- `snapshot()`
- `effectiveScore()`
- `beginDraft(key, value)`
- `updateDraft(key, value)`
- `revertDraft(key)`
- `adoptServerScore(score)`

Keep the first implementation framework-free and browser-native.

## Phase 2: Structure Editor Migration

Replace the Structure Editor's page-local `blockDraft` and event merge logic
with the shared store.

Structure Editor should use:

- `beginDraft("mesostructure:A", block)`
- `updateDraft("mesostructure:A", blockFromForm())`
- `effectiveScore()` for block list, block editor, and chain selectors
- `saveDraft("mesostructure:A")` once implemented

The current draft-preservation patch is a stopgap and should disappear once
the shared store owns draft overlays.

Verification:

1. Open Structure Editor on `wren`.
2. Edit block duration without saving.
3. Trigger an external server update.
4. Confirm the draft remains visible.
5. Save the block.
6. Confirm the server returns the new revision and the draft clears.

## Phase 3: Matrix Edit Migration

Move Matrix Edit revision polling and event handling into the shared state
layer.

Matrix Edit should subscribe to:

- Effective selected block
- Selected block assignment
- Selected clip
- Structure revisions
- Timing-contract dependency invalidation

When `structureRevision` changes, Matrix Edit should not manually decide which
selectors to rebuild. It should receive a store notification that the selected
block, clip assignment, or timing dependency is stale, then rerender from the
effective score.

Verification:

1. Open Matrix Edit on block A.
2. Change block A duration from Structure Editor.
3. Confirm Matrix Edit updates its block duration/projection after revision
   refresh.
4. Change player-to-clip assignment from Structure Editor.
5. Confirm Matrix Edit updates the selected clip picker without losing an
   active clip edit draft.

## Phase 4: Event List Migration

Event List should use the shared store for clip ownership.

It should:

- Own `clip:<clipId>` or `clip:<clipId>:notes`
- Treat Structure Editor assignment changes as dependencies, not local edits
- Preserve unsaved clip edits if block assignment changes elsewhere
- Mark conflicts if another editor changes the same clip while Event List has a
  dirty draft

Verification:

1. Edit a clip in Event List without saving.
2. Change the block assignment containing that clip from Structure Editor.
3. Confirm the clip draft remains intact.
4. Save or revert explicitly.

## Phase 5: Conflict UI

Add a small, consistent conflict/stale state display across editors.

Minimum UI language:

- `Unsaved local changes`
- `Server changed this item`
- `Dependencies changed`
- `Save anyway`
- `Reload server version`
- `Revert local draft`

Do not block performance-oriented workflows with modal prompts except for
destructive discard actions.

## Phase 6: Tests

Server tests:

- Expected score revision accepts current writes.
- Expected score revision rejects stale writes.
- Expected structure revision rejects stale structure writes.
- Restore/reset/new-score advance revisions and conflict with stale writes.

Client/static tests:

- Structure Editor imports shared state module.
- Matrix Edit uses shared revision/draft primitives after migration.
- Event List uses shared revision/draft primitives after migration.
- Page-local ad hoc draft merge helpers are removed.

Browser/live checks on `wren`:

- Structure Editor draft survives external score events.
- Matrix Edit repopulates block/clip UI after structure changes.
- Event List clip draft survives assignment changes.
- Smoke test still passes after deploy.

## Rollout Order

1. Land shared store with tests and no editor migration.
2. Migrate Structure Editor, replacing the current `blockDraft` stopgap.
3. Add expected revision validation for structure endpoints.
4. Migrate Matrix Edit's revision polling/event handling.
5. Add expected revision validation for clip/context endpoints.
6. Migrate Event List.
7. Add conflict UI and live verification docs.

## Open Questions

- Should Matrix Edit consume the shared module from server-hosted static assets,
  or should the module live in `matrixedit` source and export into the server
  bundle?
- Should `structureRevision` include playhead-only changes, or should playhead
  stay separate from structural shape changes?
- Do assignment changes belong to `structureRevision`, `scoreRevision`, or a
  third `assignmentRevision` once Structure Editor owns them more directly?
- Should save conflicts offer an automatic rebase for simple block duration or
  clip note changes, or should the first version require explicit user choice?

## Near-Term Stopgap

Until this framework lands, the Structure Editor uses a page-local `blockDraft`
overlay so incoming server snapshots do not overwrite an unsaved block edit.
That should be treated as temporary compatibility code, not the final pattern.
