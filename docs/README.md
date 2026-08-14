# ShadowscoreServer Documentation

Start with the current guides:

- [`../README.md`](../README.md): project overview, run commands, editing model,
  current HTTP API, development notes, and deployment entry points.
- [`operator-guide.md`](operator-guide.md): session-day host, peer, editor,
  transport, score, and recovery workflow.
- [`score-initialization-api.md`](score-initialization-api.md): declarative,
  dry-run-first creation of player, clip, block, macro, and OSC-role skeletons.
- [`deployment/shadowbox-hardware.md`](deployment/shadowbox-hardware.md):
  Raspberry Pi install/update path, systemd services, smoke tests, and
  pre-session hardware checklist.
- [`deploy-pi-hardening-plan.md`](deploy-pi-hardening-plan.md):
  deploy helper restart proof, recovery, route verification, and validation
  checklist.
- [`mesostructural-osc-snapshot-plan.md`](mesostructural-osc-snapshot-plan.md):
  instance-captured OSC clips, mesostructural role-to-clip layers, live resource
  mapping/onboarding, ordered recall, score initialization, timing results, and
  the deferred staging/commit proposal. The OSC payload contract is in
  [`osc-snapshot-contract.md`](osc-snapshot-contract.md), and the RNBO-side
  transaction is in
  [`rnbo-osc-snapshot-staging-protocol.md`](rnbo-osc-snapshot-staging-protocol.md).
  The stopped-transport live baseline is repeatable with
  `tools/measure-osc-snapshot.mjs`.
- [`osc-block-state-authoring-ui-plan.md`](osc-block-state-authoring-ui-plan.md):
  current instant-write authoring contract for instance cards, Written and
  Unspecified block states, just-in-time onboarding, independent cross-instance
  copying, clearing, and explicit full-state recall.
- [`osc-instant-write-model-plan.md`](osc-instant-write-model-plan.md):
  implementation history and acceptance criteria for the canonical OSC
  instant-write migration.

Design and implementation notes:

- [`mesostructural-ttid-scale-plan.md`](mesostructural-ttid-scale-plan.md):
  block-owned TTID, non-destructive Matrix Edit folding, explicit focused-note
  quantization, the retained whole-score scale-transform API, OSC snapshot
  exclusion, runtime distribution, drift visibility, and client scale opt-out.
- [`structure-and-clip-work-plan.md`](structure-and-clip-work-plan.md):
  historical/current notes for Structure Editor, Event List, Matrix Edit, clip
  APIs, saved scores, and migration.
- [`matrix-edit-meso-block-projection-plan.md`](matrix-edit-meso-block-projection-plan.md):
  Matrix Edit projection framing and verification scenarios.
- [`transport-and-matrix-ui-ux-plan.md`](transport-and-matrix-ui-ux-plan.md):
  DAW-like transport facade, Matrix Edit simplification, and ownership
  boundaries for setup versus performance.
- [`arrange-navigation-and-block-tempo-plan.md`](arrange-navigation-and-block-tempo-plan.md):
  grouped navigation, the combined Arrange surface, block-owned written tempo
  with live follow policy, distinct player/form controls, graphical block
  arrangement, duplicate naming, and disclosed transport events.
- [`smooth-editor-wiper-and-playback-observation-plan.md`](smooth-editor-wiper-and-playback-observation-plan.md):
  display-rate browser wiper interpolation, shared Matrix/Piano Roll playback
  observation, and server-owned RNBO polling consolidation.
- [`piano-roll-clip-editor-plan.md`](piano-roll-clip-editor-plan.md):
  historical first-version plan for note-duration resizing, explicit Save, and
  shared Matrix Edit foundations. The explicit-Save behavior has been
  superseded by autosave with recoverable drafts and Revert.
- [`piano-roll-orchestration-plan.md`](piano-roll-orchestration-plan.md):
  current condensed-score model and the implemented atomic **Move to...**
  workflow across player clips.
- [`shadowscore-user-facing-style-plan.md`](shadowscore-user-facing-style-plan.md):
  Smol-derived visual direction, shared UI tokens, page-by-page application
  notes, and styling rollout plan for server-hosted user-facing pages.
- [`adaptive-rnbo-stage-resolution-plan.md`](adaptive-rnbo-stage-resolution-plan.md):
  timing-contract and target-capability design for RNBO playback.
- [`scalable-rnbo-score-transport-plan.md`](scalable-rnbo-score-transport-plan.md):
  compact score replacement plan for scaling RNBO sends beyond full-row clears.
- [`rnbo-connection-hardening-pass.md`](rnbo-connection-hardening-pass.md):
  four-Pi baseline, canary rollout, ACK, debounce, and mixed-fleet hardening
  strategy for the RNBO score connection.
- [`phase-aligned-rnbo-playback-and-editor-state-plan.md`](phase-aligned-rnbo-playback-and-editor-state-plan.md):
  shared playback snapshot, editor convergence, staged RNBO preparation, and
  JACK-boundary activation rollout.
- [`live-score-editing-and-client-application-plan.md`](live-score-editing-and-client-application-plan.md):
  canonical autosave, dependency-aware client preparation, Saved/Prepared/Active
  UI semantics, and explicit next-beat application for live block editing.
- [`beat-derived-macro-playback-plan.md`](beat-derived-macro-playback-plan.md):
  beat-witness model and macro playback design.
- [`wren-jack-transport-macro-playback-plan.md`](wren-jack-transport-macro-playback-plan.md):
  live `wren` JACK transport rollout notes.
- [`shadowbox-hardware-ensemble-plan.md`](shadowbox-hardware-ensemble-plan.md):
  original hardware ensemble architecture and phase tracking.
- [`editor-revision-draft-framework-plan.md`](editor-revision-draft-framework-plan.md):
  historical proposed shared revision/draft framework. Current editor behavior
  is described by the README and the live-score editing plan.
- [`osc-editor-and-macro-control-plan.md`](osc-editor-and-macro-control-plan.md):
  OSC instrument editor, live target, broadcast volume, and macro-control plan.
- [`mesostructural-osc-snapshot-plan.md`](mesostructural-osc-snapshot-plan.md):
  clean replacement plan for instance-captured OSC clips, block OSC layers,
  logical instance routing, onboarding, recall, and beat-aware transitions.
- [`osc-snapshot-contract.md`](osc-snapshot-contract.md): finalized version 1
  semantic snapshot schema, persistent-control rules, and sequencer Clock
  behavior.
- [`implementation-plan.md`](implementation-plan.md): historical implementation
  milestones and an early model/API snapshot; it is not the current endpoint
  reference.

The plan documents are useful context, but they are not the front-door operator
manual. Prefer the README, operator guide, and deployment guide when setting up
or running a session.
