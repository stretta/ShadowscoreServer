# Beat-Derived Macro Playback To Do

Follow-up items from the beat-derived macro playback rollout and live `wren`
deployment.

## Transport Status Page

- [ ] Show one timing contract entry per playback client on `/transport/status`.
  The API already returns one contract per target from `/playback/timing-contracts`;
  the page currently renders only the first contract.
- [ ] Include each contract's target id, assigned voice, block id,
  `stagesPerBeat`, `ticksPerStage`, `patternLength`, note count, and available
  state.
- [ ] Visually flag contracts that disagree on timing-critical fields when
  disagreement is unexpected.

## Beat Witness Readback

- [ ] Confirm live RNBOOSCQuery exposes current `current_stage` values, not just
  outport paths, for the assigned clients on `wren`.
- [ ] If live `current_stage` values are absent from OSCQuery snapshots, add an
  explicit readback path for RNBO client stage values before relying on
  `rnbo-client` as a witness source in performance.
- [ ] Decide whether RNBO-client witness comparison should use absolute client
  stage, block-local stage, or a server-maintained phase anchor when JACK is
  stopped.

## Deployment

- [ ] Fix non-interactive sudo restart in `tools/deploy_pi.sh` for `wren`, or
  document the required manual force-restart path.
- [ ] After deploys, verify the live process start time and route shape, not only
  file sync and service status.
