# Pi Deploy Helper Hardening Plan

`tools/deploy_pi.sh` is the repo-native source-copy update path for installed
Raspberry Pi units such as `wren`. It already syncs the current checkout,
preserves remote runtime state, installs production dependencies, restarts the
role-specific systemd unit, and can run the hardware smoke test. The next pass
should make the helper prove that the deployed code is actually running.

## Current Failure Modes

- A plain `systemctl restart` can leave `shadowscore-server.service` stuck in
  `deactivating`, or return without replacing the old Node process.
- `systemctl status` is useful context, but it does not by itself prove that the
  live process changed.
- Sudo failures currently happen late in the workflow, after the source sync has
  already happened.
- Host deploys can pass file sync and still serve an old route or old bundled
  asset.
- Rsync output can bury the operational facts that matter during a fast test
  deploy.

## Target Behavior

### Restart Proof

- Capture `MainPID`, `ActiveState`, `SubState`, `ActiveEnterTimestamp`, and
  `ExecMainStartTimestamp` before restart.
- Restart the selected unit.
- Poll until the unit reaches `active/running`, or fail with a clear timeout.
- Print the before/after service snapshot.
- For an already-running service, warn if both the PID and start timestamp are
  unchanged after restart.

### Stuck-Service Recovery

- Add an explicit `--force-restart` mode that kills, resets, and starts the
  selected unit instead of doing a normal restart.
- If a normal restart leaves the unit unhealthy, run the same recovery path:
  `systemctl kill -s SIGKILL`, `systemctl reset-failed`, then `systemctl start`.
- Re-run the same active/running proof after recovery.
- If automatic recovery cannot run, print the exact manual commands.

### Sudo Preflight

- Before rsync, check `sudo -n true` when restart is enabled.
- If non-interactive sudo is unavailable, fail early with the manual command
  sequence instead of syncing files and discovering the problem later.
- Keep an escape hatch for unusual manual sessions.
- Allow `SHADOWSCORE_SUDO_PASSWORD` for known lab units that require sudo
  password entry during unattended test deploys.

### Host Route Verification

- For `--role host`, verify live HTTP routes after restart:
  `/healthz`, `/session`, `/matrix-edit`, and `/event-list`.
- Allow rollout-specific route checks with repeatable `--verify-route <path>`.
- Poll route checks briefly so a clean restart has time to bind the port.
- Keep hardware smoke as a separate deeper check.

### Provenance Output

- Print the local git commit and dirty state before deploy.
- If `public/matrix-edit/build-info.json` exists, print its Matrix Edit commit
  and dirty flag.
- After deploy, print enough service and route evidence to answer what is live.

### Rsync Output

- Make normal rsync output concise.
- Keep a verbose mode for diagnosing file-level sync behavior.
- Preserve dry-run behavior.

## Implementation Phases

1. Add the durable plan document and route it from `docs/README.md`.
2. Add restart proof, sudo preflight, recovery, and default host route checks to
   `tools/deploy_pi.sh`.
3. Update README and deployment docs with the new flags and behavior.
4. Mark the deployment TODO complete once restart proof and route verification
   are implemented.
5. Validate locally with syntax/help/dry-run checks.
6. Deploy to `wren` and accept the change only when the helper proves restart,
   route shape, and hardware smoke.

## Validation Checklist

- `bash -n tools/deploy_pi.sh`
- `tools/deploy_pi.sh --help`
- `tools/deploy_pi.sh --alias wren --dry-run`
- Live test on `wren`:
  - service reaches `active/running`
  - service snapshot changes or emits an explicit unchanged warning
  - `/healthz`, `/session`, `/matrix-edit`, and `/event-list` answer
  - hardware smoke passes with `config/shadowscore.host.local.json`
