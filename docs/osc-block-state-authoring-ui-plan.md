# OSC Block-State Authoring UI Development Plan

Status: implemented and live-verified in the shared OSC editor workflow on
2026-07-16. The
normal editor now uses draft-backed Block State writes, just-in-time role
creation, per-instance/block draft preservation, instance cards, role-level
Ignore recall, and independent Save Copy To transactions. The acceptance gate
was completed against the deployed wren rig; the prototype scenarios remain
useful regression exercises rather than implementation gates.

## Live Verification

Verified on the deployed wren host on 2026-07-16:

- Written block navigation was silent: EDITING changed while PLAYING remained
  independent, CHASE disengaged, the score version and structure revision did
  not change, and all 40 observed live parameter values remained unchanged.
- Exact assignments resolved correctly with two same-app instances on wren,
  while instance focus and readback remained separate from live-send targets.
- A legacy numeric enum value compiled into a complete 40-write recall plan
  without an unsupported-control omission.
- Written state loaded as clean after display normalization, with Replace
  disabled until the displayed draft differs semantically from saved state.
- The user completed the remaining live interaction and audible acceptance
  checks and confirmed the workflow verified.

## Purpose

Simplify initial authoring of mesostructural OSC state without weakening the
instance-specific score model or turning Admin into a required stop in the
normal creative workflow.

ShadowScore currently has two broad kinds of composition data:

1. note/event clips, which are edited directly by clip editors and sent to
   ShadowScore playback clients; and
2. persistent parameter and OSC-list state, which is captured or authored for
   one RNBO instance and recalled as part of a mesostructural block.

This plan concerns only the second category. In the normal UI it should be
called **Block State** rather than exposing OSC clip, role, layer, or snapshot
bookkeeping.

The backend model remains:

```text
focused live instance
  -> logical OSC role
    -> one independent OSC clip per Written block slot
      -> block OSC layer
        -> runtime assignment back to a live instance
```

Two AnalogSequencer instances therefore have two independent Block State slots
inside the same mesostructural block. Copying state between them must create an
independent copy unless the user deliberately chooses an advanced shared-clip
operation.

## Product Boundaries To Preserve

### Playing Is Not Editing

- **PLAYING** identifies the mesostructural block currently being recalled by
  playback.
- **EDITING** identifies the block whose state is displayed and may be saved.
- **CHASE** makes EDITING follow PLAYING.
- Selecting an EDITING block is navigation. It must not send that block's
  complete state to an RNBO client.
- A playing-block transition recalls all Written role layers independently of
  editor focus.

### Focus Is Instance-Specific

- Exactly one instance is in focus for score-state display, capture, and
  destination identity.
- The focused instance's role selects which independent slot is shown within
  each block.
- Changing focus must never make two instances share one OSC clip implicitly.
- Direct live editor gestures remain distinct from block recall and score
  persistence.

### Unspecified Is Not Empty

- A new authoring score defines blocks without predeclaring OSC roles or clips.
- For an Available focused target, the editor presents each block as a
  provisional **Unspecified** slot before any durable role exists.
- First Write creates the just-in-time role and turns that provisional context
  into a durable block/role slot with an assigned clip.
- In an existing score, a durable block/role combination without a clip is also
  **Unspecified**.
- Playback does nothing to an Unspecified slot; it does not recall zeros,
  silence, defaults, or an empty list.
- An explicitly Written state may contain `Clock: 0`, empty persistent lists,
  or other intentional values that must not be mistaken for Unspecified.

### Admin Is For Resolution And Repair

Initial authoring should not require Admin merely because a newly instantiated
RNBO device has not appeared in the score before.

Admin remains the correct surface for:

- loading an existing score whose required destinations are absent;
- resolving offline, stale, ambiguous, or multiply compatible assignments;
- replacing one physical destination with another;
- inspecting advanced clip, role, and routing details; and
- deliberately sharing or restructuring reusable OSC clips.

## Proposed Normal Editor

### 1. Instance Cards

Replace the separate focus selector with visible instance cards at the top of
the editor. Each card shows:

- a focus radio button;
- friendly instance and device labels;
- online and score-mapping status;
- a compact Written-slot count or score-presence indicator; and
- **Ignore recall**, associated directly with that instance's logical role.

The focused card determines which instance-specific Block State slots appear
below. Focus owns score capture and display only. Separate checkboxes retain
live multi-target sends; changing those checkboxes must not change which role
or block slot is read, displayed, or written.

An online target that has not yet entered the score remains selectable and is
shown as **Available** rather than forcing the user into Admin. Ignore Recall is
visible but inactive on an Available card because there is no score recall path
to mute until first Write creates the role.

### 2. Block-State Strip

Show every mesostructural block as a selectable state tile. Each tile shows at
least:

- block id or label;
- **Written** or **Unspecified** for the focused instance;
- PLAYING indication when applicable; and
- EDITING selection.

Current behavior is:

- with CHASE on, EDITING equals PLAYING and follows every playing-block change;
- selecting a non-playing tile disengages CHASE and makes that tile EDITING;
- turning CHASE off without selecting another tile leaves EDITING on its
  current block;
- with CHASE off, selecting a tile changes EDITING without changing PLAYING,
  sending OSC, or recalling state; and
- turning CHASE on immediately returns EDITING to PLAYING.

Choosing a different EDITING block is treated as an explicit request to stop
following PLAYING. The automatic CHASE-off transition is the selected workflow.

Proposed selection behavior:

| Slot state | Proposed result |
| --- | --- |
| Written | Load the saved state into editor controls using Max-style `set` semantics. Send no OSC and perform no score mutation. |
| Unspecified | Select the slot as EDITING without mutating the score. Display a complete focused-instance hydration as a provisional draft and enable the separate Write action. |

Changing instance focus while a block remains selected applies the same
Written-versus-Unspecified display rule to the newly focused instance's slot.
It never writes merely because focus changed.

### 3. Live Editing And Save

Block selection itself is silent. Deliberate control gestures may still send
immediately to selected live targets. The UI must make it clear that this is a
live override of the currently sounding client, not a recall of the EDITING
block.

The primary persistence action should name both destinations:

```text
Save B State for AnalogSequencer 2
```

Write availability is derived from the focused block slot and editor draft:

- **Unspecified** plus a complete draft: enable **Write B State**;
- **Written** plus a clean draft: disable Write and show that B is saved;
- **Written** plus a semantically different draft: enable **Replace B State**;
- no focused instance or an incomplete draft: disable Write and explain what is
  missing.

Dirty comparison is always against the focused instance's Written clip in the
EDITING block. It is never computed from another checked live-send target.

Write persists the complete displayed draft. It does not recapture the focused
client and does not send the draft before saving. A draft must be complete
before Write is enabled.

Provide one compact **Clear State…** action with three explicit scopes:

- this instance in the EDITING block;
- every instance in the EDITING block; and
- every instance in every block.

The dialog defaults to the narrowest available scope, reports the number of
Written slots affected, and requires an additional confirmation for either
multi-instance scope. Clear makes those slots Unspecified by removing their
block-layer references atomically. It sends no OSC and preserves OSC clips,
role assignments, and Ignore Recall settings.

### 4. Copy Between Instances

Provide an explicit action that does not require changing focus:

```text
Save Copy To... -> AnalogSequencer 3
```

The operation must:

- leave the source instance and block in focus;
- send no OSC and cause no recall;
- create a new independent destination clip rather than assigning the source
  clip id to both roles;
- write within the same selected mesostructural block by default; and
- require explicit replacement confirmation when the destination slot is
  already Written.

After the copy, focusing the destination instance loads its new independent
state through the ordinary Written-slot behavior.

To copy current live source state, the user first performs explicit instance
readback to refresh the displayed draft. Save Copy To always copies that draft,
so its source remains predictable.

## Initial Authoring And Just-In-Time Onboarding

The first usable AnalogSequencer path should be:

1. Start from a score containing its mesostructural blocks but no predeclared
   OSC roles or clips.
2. Instantiate an AnalogSequencer in RNBO.
3. Open the AnalogSequencer editor and see the discovered instance card marked
   Available.
4. Focus that card and live-edit it without visiting Admin.
5. Select an Unspecified block slot; this changes editing context but does not
   mutate the score.
6. Choose **Write State**. Atomically create or choose a logical role, map it to
   the focused target, save the complete displayed draft into an independent
   OSC clip, and assign the clip to the selected block.
7. Continue writing distinct states into any block defined by the score.

The existing `/osc/onboard` transaction proves the atomic mapping, clip
creation, and layer-assignment shape, but it currently captures the target.
Draft-backed authoring needs that transaction extended or complemented so Write
can validate and persist the complete displayed snapshot without recapturing or
sending it. The editor also needs a just-in-time policy for choosing or creating
the logical role. Durable role creation and onboarding happen on Write, never
on tile or focus selection.

Safe resolution order:

1. Reuse the role already mapped to the exact target.
2. Consider an exactly-one compatible unassigned role, subject to the open
   mapping-policy question below.
3. If the score has no compatible role and is in initial authoring, create a
   stable app-plus-ordinal role on first write.
4. Never guess among multiple compatible or unresolved roles. Keep live editing
   available, but direct the user to an inline choice or Admin for score
   mapping.

Focusing an Available target should not by itself mutate the score. The first
write to an Unspecified slot is the earliest operation that necessarily needs
a durable role and assignment.

## Existing-Score Resolution

When opening an existing score:

- mapped online roles appear on their instance cards normally;
- an expected but offline role remains visible as missing score data in Admin;
- a compatible new target may be suggested but is not silently substituted
  when the match is ambiguous;
- Unspecified slots remain editable after a safe mapping is made;
- Written data remains intact while its destination is offline; and
- **Ignore recall** follows the score role, not a volatile RNBO instance number.

The editor may offer a safe one-click binding only when one live target and one
compatible unresolved role form an unambiguous pair. Admin remains the complete
resolver.

## Central State Tension

Silent Written-slot selection creates a deliberate separation:

```text
PLAYING client state != displayed EDITING draft
```

This is correct for navigation, but it affects saving. Suppose block A is
PLAYING, block B is EDITING, and B was loaded into the UI with `set`. Moving one
control live changes only that control on the client. The client's other values
may still belong to A, while the displayed draft's other values belong to B.

The considered save contracts are not equivalent:

1. **Capture live instance**: preserves the existing instance-authoritative
   backend contract, but may save a hybrid of A and edited B values.
2. **Save displayed draft**: saves exactly what the user sees for B, but changes
   the established rule that score state is captured from the instance rather
   than serialized from the editor.
3. **Send full draft, then capture**: aligns the instance and draft before
   capture, but effectively recalls or auditions B and can disturb PLAYING A.

The selected contract is **Save displayed draft**. The rejected alternatives
remain documented because live capture is still useful for initializing or
refreshing a draft, while full-send-then-capture would collapse EDITING into a
playback/audition action.

## Open Questions For Review And Testing

### Q1. Save Persists The Displayed Draft — Decided

Write saves exactly the complete draft shown for the focused instance and
EDITING block. It neither recaptures the focused client nor sends the complete
draft before saving. This remains correct when the focused instance is not one
of the checked live-send targets.

Live instance readback initializes an Unspecified provisional draft or
explicitly refreshes the editor. Once displayed, the draft is the source for
Write and Replace State.

Regression test: play A, edit B with CHASE off, leave the focused target
unchecked for live sends, save B, then recall B and confirm that the complete
displayed draft—not the focused client's A state—was persisted.

### Q2. Selecting Unspecified Does Not Write — Decided

Tile selection changes editing context only. An Unspecified slot displays a
complete focused-instance hydration as a provisional draft. A separate Write
button is enabled because the slot has no assigned clip. No role, clip, layer,
or score revision changes until Write is pressed.

For a Written slot, Write remains disabled while the displayed draft matches
the saved clip and becomes **Replace State** only when the editor is dirty.

### Q3. Focus And Multi-Target Sends Remain Separate — Decided

The focus radio owns score capture, display, role identity, and block-slot
selection. Separate checkboxes retain live multi-target sends. Checked targets
never influence which instance's state is displayed or which role is written.
Named broadcast actions such as RTZ All and Clock All remain separate.

### Q4. Existing Unresolved Roles Require Resolution — Decided

First Write reuses only a role already mapped to the exact target. If a
compatible unresolved role exists, the write remains non-mutating and directs
the user to resolve the assignment. A new app-plus-ordinal role is created only
when there is no unresolved compatible role; other same-app roles already
mapped to distinct online instances do not block just-in-time onboarding.

### Q5. Save Copy To Copies The Displayed Draft — Decided

Save Copy To uses the same complete displayed draft selected in Q1 and creates
an independent destination clip. A user who wants current live instance state
must first use explicit instance readback to refresh the draft. Test replacement
of both Unspecified and Written destination slots.

### Q6. Ignore Recall Mutes Recall Data — Decided

Ignore Recall is a data-routing mute for the instance's score role. Automatic
and manual block recall send no saved Block State data to that client while it
is enabled. The score data, role mapping, and block layers remain intact, and
recall reports the role as ignored rather than failed.

It is not an audio mute and does not duplicate the separate live-send
checkboxes: direct editor gestures and explicit instance readback remain
available. Card placement should make the muted recall path visible while the
instance can still be live-edited.

### Q7. What Terminology Belongs In The Normal UI?

Proposed vocabulary:

- Instance
- PLAYING
- EDITING
- CHASE
- Block State
- Written
- Unspecified
- Save State
- Save Copy To
- Ignore recall

Keep OSC clip ids, logical roles, layers, capture diagnostics, and manual clip
assignment under advanced tools or Admin.

### Q8. Score Roles Are Created Just In Time — Decided

Initial authoring scores declare blocks but do not predeclare OSC roles. An
Available target can be focused and shown against provisional Unspecified block
contexts without mutating the score. First Write creates its stable
app-plus-ordinal role, assignment, independent clip, and selected block layer in
one transaction.

Loaded scores may already contain durable roles whose assignments need
resolution. Those existing-score roles are preserved and follow the Q4 safety
policy rather than being replaced by new just-in-time roles.

### Q9. Explicit Tile Selection Disengages CHASE — Decided

Selecting a non-playing block is an explicit decision to edit away from
PLAYING. The editor therefore turns CHASE off automatically and makes the
selected block EDITING. Turning CHASE on again immediately returns EDITING to
PLAYING and resumes following block changes.

### Q10. Preserve And Color-Code Dirty Drafts — Decided

Dirty drafts are preserved per instance-and-block rather than discarded on
navigation. Store them by logical role plus block, using a temporary target-id
key before just-in-time onboarding creates the role. Returning to the same
instance and block restores its draft and dirty state without sending OSC.

Expose draft state on both block tiles and instance cards. Color supports quick
scanning, but every state also needs a text label or icon for accessibility:

- **Written / Saved**: stable saved-state treatment;
- **Dirty**: warning/amber treatment plus a Dirty label or dot;
- **Unspecified**: neutral treatment;
- **Unspecified + Draft**: distinct provisional treatment plus an Unwritten
  Draft label; and
- an instance card may show a dirty-draft count when unsaved drafts exist in
  blocks other than the one currently displayed.

Prototype test: dirty B for instance 1, switch to C and then instance 2, return
to instance 1/B, and confirm that the draft and its visible dirty indication
survive every context change.

## Prototype Scenarios

Run these before freezing the interaction contract:

1. **Fresh single instance**: create a score, instantiate one AnalogSequencer,
   write distinct states to A, B, and C without opening Admin.
2. **Fresh multiple instances**: instantiate three AnalogSequencers and confirm
   each block exposes three independent states with no accidental clip sharing.
3. **Written navigation**: switch blocks while stopped and while another block
   is PLAYING; confirm selection sends no OSC.
4. **Unspecified navigation**: switch focus and blocks rapidly; confirm no score
   mutation occurs until the separately enabled Write action is pressed.
5. **CHASE**: confirm PLAYING changes update EDITING controls with `set`, while
   CHASE-off editing remains independent.
6. **Live override**: edit B while A plays and determine whether the audible
   effect and subsequent save are predictable.
7. **Copy**: copy B from instance 1 to instance 2, replace an existing
   destination after confirmation, and prove later edits remain independent.
8. **Ignore recall**: manually edit an ignored instance and confirm playback
   leaves it untouched while normal live editor gestures still work.
9. **Offline return**: save a score, remove one instance, reload the score, and
   resolve the returning or replacement instance through Admin.
10. **Ambiguous mapping**: present two compatible instances for one unresolved
    role and prove the editor never guesses.
11. **List-based editor**: repeat the workflow with ListSequencer so ACK-backed
    text/list hydration and incomplete capture are not hidden by the simpler
    AnalogSequencer case.

Record for each scenario:

- whether block selection emitted OSC;
- whether score revision changed;
- which role and clip id changed;
- whether the live instance, displayed draft, and saved state agree;
- whether the user predicted the result before executing the action; and
- whether recovery required Admin.

## Development Checkpoints After Review

### Checkpoint A: Pure Workflow Model

- Encode focus, PLAYING, EDITING, CHASE, Written, Unspecified, and ignored state
  transitions as pure tested functions.
- Add no UI mutation beyond a developer harness.
- Verify draft-backed Write without capture or OSC sends.
- Exercise independent dirty drafts across instance and block context changes.

Exit: the selected interaction rules are testable without a browser or live
rig.

### Checkpoint B: AnalogSequencer Canary

- Replace its focus selector and destination presentation with instance cards.
- Move Ignore recall onto the mapped instance card.
- Implement silent Written selection and the chosen Unspecified behavior.
- Implement draft-backed Write and Replace State.
- Preserve direct live editing and named broadcast actions selected in Q3.

Exit: initial AnalogSequencer authoring works without Admin and without losing
PLAYING-versus-EDITING clarity.

### Checkpoint C: Just-In-Time Mapping

- Reuse exact assignments and safely resolve or create roles according to Q4
  and Q8.
- Keep onboarding atomic on capture or mapping failure.
- Show Available, Mapped, Ignored, Offline, and Needs Assignment states on
  cards.

Exit: a newly instantiated AnalogSequencer can acquire independent states in
any existing block, while ambiguous existing-score mappings remain untouched.

### Checkpoint D: Independent Copy

- Add **Save Copy To** using the displayed draft selected in Q5.
- Clone rather than alias the destination OSC clip.
- Add revision checks and explicit Written-destination replacement.

Exit: state can move between two instances in one block without recall, focus
loss, or later shared mutation.

### Checkpoint E: Editor-Family Rollout

- Apply the accepted shared workflow to ListSequencer and ListVelSequencer
  first, including ACK/list capture diagnostics.
- Roll out to Plate, Poland, SoftPiano, and TTID.
- Keep app-specific controls and momentary exclusions intact.

Exit: Block State authoring means the same thing across all bundled OSC
editors.

### Checkpoint F: Admin Resolution Pass

- Remove initial-authoring steps made redundant by editor onboarding.
- Preserve and clarify existing-score resolution, offline roles, ambiguity,
  lock policy, clip inspection, and advanced sharing.
- Add direct links from unresolved editor cards to the exact Admin resource.

Exit: users visit Admin to resolve a score-to-rig mismatch, not to perform the
first ordinary write.

## Automated Coverage

- Written selection updates the editor draft without OSC sends or score writes.
- Unspecified selection never mutates the score and enables Write only with a
  complete draft.
- focus changes address the newly focused role without modifying another
  instance's layer;
- exact target reuse is idempotent;
- ambiguous role mapping remains non-mutating;
- Ignore recall follows the role and does not disable direct editor gestures;
- copy creates a new clip id and independent payload;
- Write persists the complete displayed draft even when the focused target is
  unchecked for live sends;
- replacing a Written copy destination requires the expected revision and an
  explicit replacement intent;
- PLAYING recall remains independent of focus and recalls every sendable
  Written role;
- Unspecified slots remain no-ops;
- no normal workflow assigns one clip id to two instance roles accidentally;
- incomplete list capture never creates or replaces a slot silently;
- reload preserves roles, independent clips, layers, and unresolved routing;
  and
- dirty drafts never leak between instance/block contexts and follow the
  selected Q10 navigation policy.

## Acceptance Criteria

The workflow is ready for editor-family rollout when a user can:

1. instantiate an AnalogSequencer and begin score authoring without Admin;
2. predict which instance and block a save will affect;
3. navigate Written states without changing the sounding client;
4. distinguish PLAYING from EDITING throughout the workflow;
5. create intentional state for an Unspecified slot without confusing it with
   empty data;
6. author different state for several same-app instances in one block;
7. copy state between those instances without recall or shared mutation;
8. ignore playback recall while retaining deliberate live editing; and
9. load an existing score and use Admin only when assignments genuinely need
   resolution.

## Explicitly Parked Work

- RNBO-side staging and atomic commit;
- automatic recall lead/lookahead;
- sample-accurate server activation;
- changing the semantic OSC snapshot payload contract;
- combining OSC roles with ShadowScore player assignments; and
- redesigning note/event clip editors.
