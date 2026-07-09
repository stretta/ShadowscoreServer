# Beat-Derived Macro Playback To Do

Follow-up items from the beat-derived macro playback rollout and live `wren`
deployment.

## Transport Status Page

- [x] Show one timing contract entry per playback client on `/transport/status`.
  The API already returns one contract per target from `/playback/timing-contracts`;
  the page renders the full contract set in the timing-contracts panel.
- [x] Include each contract's target id, assigned voice, block id,
  `stagesPerBeat`, `ticksPerStage`, `patternLength`, note count, and available
  state.
- [x] Visually flag contracts that disagree on timing-critical fields when
  disagreement is unexpected.

## Beat Witness Readback

- [ ] Confirm live RNBOOSCQuery exposes current `current_stage` values, not just
  outport paths, for the assigned clients on `wren`.
- [x] If live `current_stage` values are absent from OSCQuery snapshots, add an
  explicit readback path for RNBO client stage values before relying on
  `rnbo-client` as a witness source in performance.
  The OSCQuery adapter already reads `current_stage.VALUE` into target
  `currentStage`; if `wren` does not expose live VALUE updates, this item should
  be reopened as a dedicated polling or client-report path.
- [x] Decide whether RNBO-client witness comparison should use absolute client
  stage, block-local stage, or a server-maintained phase anchor when JACK is
  stopped.
  Current implementation compares absolute client stage converted to beats via
  each target timing contract, rejects assigned-client skew above
  `transport.rnboClient.maxSkewBeats`, and anchors macro playback from the
  selected witness beat at start/re-sync.

## Deployment

- [x] Fix non-interactive sudo restart in `tools/deploy_pi.sh` for `wren`, or
  document the required manual force-restart path.
  The deploy helper now preflights sudo, supports password-fed sudo via
  `SHADOWSCORE_SUDO_PASSWORD`, supports `--force-restart`, and prints manual
  recovery commands when sudo is unavailable.
- [x] After deploys, verify the live process start time and route shape, not only
  file sync and service status.
  `tools/deploy_pi.sh` now compares service snapshots around restart, polls for
  `active/running`, and verifies default host routes plus any `--verify-route`
  additions.
