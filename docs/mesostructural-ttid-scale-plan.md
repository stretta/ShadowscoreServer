# Mesostructural TTID and Destructive Scale Transformation Plan

## Implementation Status

Implementation and cross-repository landing are complete. ShadowscoreServer
owns the canonical catalog and conversion module, normalized block schema,
revision-guarded TTID and atomic scale-transform APIs, persisted-score cutover,
OSC snapshot exclusion, block-owned TTID controls, drift visibility,
`ignoreScale`, and ordered runtime distribution. The ShadowScore data-format
reference documents the ownership contract. Matrix Edit now writes block TTID
non-destructively, folds the visible pitch grid to that mask, and reserves pitch
mutation for an explicit focused-document `Quantize to TTID` action. The atomic
scale-transform endpoint remains available as a server API but is no longer the
Matrix Edit scale-selection path.

The deployed `wren` topology was verified on 2026-07-17 with the host
ListSequencer, the remote `finch` ListSequencer, and a Quantizer export; all
three accepted the active block TTID. The registered ShadowScore playback
clients accepted the score transaction, but do not currently advertise a
TTID-tagged parameter. No opted-out percussion target was registered during
the live check, so `ignoreScale` exemption remains covered by automated
distribution and recall tests rather than that unavailable hardware fixture.

## Intent

ShadowScore needs one clear ownership model for scale information shared by
clip-based note material and TTID-capable RNBO instances.

Clip scale data remains descriptive metadata about the notes currently stored
in a clip. TTID is mesostructural runtime state shared by all eligible RNBO
instances during a block. Matrix Edit is the only editor that can deliberately
synchronize both domains because its scale operation destructively transforms
ShadowScore notes. OSC editors can edit runtime TTID without transforming note
material.

This plan assumes a clean schema break. Existing score files, OSC snapshots,
and older editor payloads do not need to remain compatible.

## Ownership Contract

The target mesostructural shape is:

```json
{
  "mesostructure": {
    "A": {
      "scale": {
        "root_note": 0,
        "scale_intervals": [0, 2, 4, 5, 7, 9, 11],
        "scale_name": "Ionian"
      },
      "ttid": 2741,
      "players": {},
      "oscLayers": {}
    }
  }
}
```

The ownership rules are:

- `clip.context.scale` describes the notes currently stored in that clip.
- `mesostructure.*.scale` describes rooted and named harmonic context.
- `mesostructure.*.ttid` is the rootless runtime pitch-class set.
- Matrix Edit writes block TTID directly and uses it as a non-destructive pitch
  fold. Notes excluded by the fold remain stored and reappear when included
  again.
- Matrix Edit changes focused note data only after explicit confirmation through
  `Quantize to TTID`; that action does not infer or write rooted scale metadata.
- OSC editors write block TTID only.
- TTID never belongs to an OSC clip or instance snapshot.
- Direct TTID editing may intentionally diverge from block scale and rendered
  ShadowScore notes. That divergence is visible but is not repaired
  automatically.
- Loading or selecting a block never causes Matrix Edit to transform notes.

## Phase 1: Canonical Scale and TTID Conversion

Add one shared ShadowscoreServer scale module that:

- Uses the established `scales.json` pitch-class sets.
- Converts key plus scale into an absolute pitch-class set.
- Converts that pitch-class set into the HIN/TTID integer.
- Validates TTID as a 12-bit integer from `0` through `4095`.
- Compares block scale with block TTID to detect drift.

Confirm the bit ordering against the existing Max/HIN examples before using the
converter elsewhere. Add golden vectors for chromatic, modal, pentatonic, and
asymmetric scales. Serve the canonical scale catalog to browser editors so
Matrix Edit and OSC editors do not maintain independent tables.

## Phase 2: Direct Score Schema Change

Make `ttid` a required mesostructural field and update:

- Score initialization.
- Mesostructural block normalization and validation.
- Persistence, backup, and restore validation.
- Block creation, duplication, replacement, reset, and removal workflows.
- Structure Editor.
- Collaboration snapshots and WebSocket commands.
- Tests, fixtures, initialization documents, and example scores.

No migration or compatibility layer is required. Old score documents without
the new required shape may be rejected or replaced with newly initialized score
data.

## Phase 3: Block Harmonic-State APIs

Add a narrow, non-destructive endpoint:

```text
PUT /mesostructure/:blockId/ttid
```

It updates only the block TTID and uses the normal score revision guard.

Add a dedicated destructive Matrix Edit endpoint:

```text
POST /mesostructure/:blockId/scale-transform
```

The server performs one atomic mutation:

1. Transform eligible ShadowScore notes.
2. Update every transformed clip's `context.scale`.
3. Update legacy voice data and score context if they remain active parts of
   the model.
4. Update the selected block's `scale`.
5. Derive and write the selected block's `ttid`.
6. Emit one coherent score update.

The endpoint should accept an expected score or structure revision so another
editor cannot cause a partial overwrite.

## Phase 4: Destructive Transformation Scope

Preserve Matrix Edit's current whole-score transformation scope for the first
implementation.

For each clip:

- Use the clip's own `context.scale` as the source scale.
- Transform its notes into the requested scale.
- Replace its `context.scale` with the requested scale.
- Skip clips whose `behavior.followsScale` is `false`.

Legacy voices use score context as their source scale if they remain supported.
The confirmation reports the affected notes and clips, scale-exempt clips,
expected pitch changes, the block receiving the new TTID, and the destructive
nature of the operation.

Block-local destructive transforms are deferred. Reusable clips would require
explicit copy-on-write semantics before a block-local operation could be safe.

## Phase 5: Remove TTID From OSC Snapshots

Classify any parameter with `meta.editor === "ttid"` as mesostructural state,
regardless of whether its RNBO parameter is named `Scale`, `ttid`, or something
else.

Apply that rule during:

- Live capture.
- Snapshot validation and normalization.
- Browser editor draft serialization.
- Snapshot recall compilation.

Strip TTID from current OSC clip data as part of the schema update and reject
newly imported OSC clips that attempt to own it. Update all fixtures to contain
no TTID snapshot values.

Other instance parameters remain ordinary snapshot state, including root,
transpose, mode, Clock, and OSC lists.

## Phase 6: Block-Owned Browser TTID Controls

Update the shared OSC editor infrastructure, dedicated TTID editor, and List
Sequencer editor so TTID controls:

- Hydrate from the selected mesostructural block.
- Write through the block TTID endpoint.
- Optionally send the new value immediately to selected live targets for
  auditioning.
- Never hydrate TTID from a source RNBO instance.
- Never serialize TTID into a device OSC snapshot.

Non-TTID controls retain the existing contract: get state from one selected
instance, send state to one or more selected instances, and save persistent
state into the selected block's OSC layer.

Put the TTID behavior in shared editor code so future Quantizer and other
TTID-capable editors inherit it automatically.

## Phase 7: Matrix Edit Changes

Matrix Edit's current TTID controls:

- Hydrate from the selected block's TTID.
- Expose the twelve pitch-class bits directly, with compact rooted scale presets
  as a convenience for producing a TTID mask.
- Write TTID through the revision-guarded block TTID endpoint.
- Fold non-member pitch rows out of the grid without deleting or rewriting their
  notes.
- Report how many focused notes are hidden by the fold.
- Require a separate, explicit confirmation before `Quantize to TTID` moves the
  focused clip or legacy voice notes to their nearest allowed pitches.
- Refresh from the committed score response after a TTID write.

Changing TTID may immediately affect TTID-capable runtime clients, but it never
transforms stored Matrix Edit notes. The server's atomic scale-transform API is
retained for explicit whole-score conversion workflows outside this control.

## Phase 8: Drift Visibility

Compare the selected block's TTID with the value derived from its rooted scale.
When they differ, show a non-blocking warning in relevant editors:

> Runtime TTID differs from the rendered ShadowScore scale. Use Matrix Edit to
> synchronize both.

Do not automatically repair the mismatch. Direct OSC-editor TTID changes are
valid and intentionally non-destructive.

## Phase 9: Client Scale Exemption

Add a distinct `ignoreScale` policy. Do not reuse `ignoreRecall`, which controls
the entire device snapshot.

A scale-exempt client:

- Does not receive automatic block TTID.
- Does not participate in runtime note-value manipulation.
- Still receives ordinary parameters, OSC lists, and other snapshot state.

Support the opt-out through RNBO target metadata and persistent target or
assignment configuration. Expose the setting in Admin where appropriate. By
default, a discovered TTID-capable client receives active-block TTID unless it
explicitly opts out.

## Phase 10: Runtime TTID Distribution

Create a shared harmonic-state distribution service triggered by:

- Playback start.
- Entry into a mesostructural block.
- Manual resend.
- A TTID edit to the active block.

For each event:

1. Read the active block's TTID.
2. Discover online targets with `ttid-edit` capability.
3. Resolve each target's actual TTID parameter from metadata.
4. Exclude scale-ignored clients.
5. Send the common TTID.
6. Record successes, skips, and failures.

At block entry, preserve this order:

1. Shared block TTID.
2. Device snapshot parameters.
3. OSC lists and late state.
4. `Clock` last.

## Phase 11: Documentation

Update:

- The canonical ShadowScore data-format reference.
- ShadowscoreServer data-model and implementation documentation.
- The OSC snapshot contract.
- Mesostructural recall documentation.
- Matrix Edit TTID fold and explicit quantization documentation.
- Admin and client scale-exemption documentation.

Document the asymmetric authority model and the possibility of intentional
drift after a TTID change made from an OSC editor.

## Phase 12: Verification and Landing

### Checkpoint 1: Schema and conversion

- Required block scale and TTID fields.
- Canonical scale catalog.
- HIN/TTID golden vectors.
- Persistence, initialization, and validation tests.

### Checkpoint 2: Snapshot ownership

- TTID removed from capture, drafts, validation, and recall.
- Other scale-related device parameters preserved.

### Checkpoint 3: Runtime distribution

- Playback-start and block-entry delivery.
- Metadata-driven TTID parameter discovery.
- TTID delivery before Clock.
- `ignoreScale` behavior without suppressing ordinary recall.
- Diagnostics for skipped, offline, and failed targets.

### Checkpoint 4: Matrix Edit

- Per-clip source-scale conversion.
- Updated clip scale metadata.
- Atomic block scale and TTID update.
- No destructive hydration from block TTID.
- Drift warnings.

Land cross-repository work in this order:

1. Update the ShadowScore format documentation.
2. Implement and commit ShadowscoreServer schema and backend changes.
3. Implement and commit Matrix Edit source changes.
4. Export the clean Matrix Edit build into ShadowscoreServer.
5. Verify bundle provenance.
6. Deploy to `wren`.
7. Test with a ShadowScore client, List Sequencer, another TTID-capable export,
   and an opted-out percussion client.
