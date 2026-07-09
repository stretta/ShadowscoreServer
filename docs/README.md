# ShadowscoreServer Documentation

Start with the current guides:

- [`../README.md`](../README.md): project overview, run commands, editing model,
  current HTTP API, development notes, and deployment entry points.
- [`operator-guide.md`](operator-guide.md): session-day host, peer, editor,
  transport, score, and recovery workflow.
- [`deployment/shadowbox-hardware.md`](deployment/shadowbox-hardware.md):
  Raspberry Pi install/update path, systemd services, smoke tests, and
  pre-session hardware checklist.
- [`deploy-pi-hardening-plan.md`](deploy-pi-hardening-plan.md):
  deploy helper restart proof, recovery, route verification, and validation
  checklist.

Design and implementation notes:

- [`structure-and-clip-work-plan.md`](structure-and-clip-work-plan.md):
  historical/current notes for Structure Editor, Event List, Matrix Edit, clip
  APIs, saved scores, and migration.
- [`matrix-edit-meso-block-projection-plan.md`](matrix-edit-meso-block-projection-plan.md):
  Matrix Edit projection framing and verification scenarios.
- [`transport-and-matrix-ui-ux-plan.md`](transport-and-matrix-ui-ux-plan.md):
  DAW-like transport facade, Matrix Edit simplification, and ownership
  boundaries for setup versus performance.
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
- [`beat-derived-macro-playback-plan.md`](beat-derived-macro-playback-plan.md):
  beat-witness model and macro playback design.
- [`wren-jack-transport-macro-playback-plan.md`](wren-jack-transport-macro-playback-plan.md):
  live `wren` JACK transport rollout notes.
- [`shadowbox-hardware-ensemble-plan.md`](shadowbox-hardware-ensemble-plan.md):
  original hardware ensemble architecture and phase tracking.
- [`editor-revision-draft-framework-plan.md`](editor-revision-draft-framework-plan.md):
  proposed shared revision/draft framework for editor clients.
- [`osc-editor-and-macro-control-plan.md`](osc-editor-and-macro-control-plan.md):
  OSC instrument editor, live target, broadcast volume, and macro-control plan.
- [`implementation-plan.md`](implementation-plan.md): implementation milestone
  history and model notes.

The plan documents are useful context, but they are not the front-door operator
manual. Prefer the README, operator guide, and deployment guide when setting up
or running a session.
