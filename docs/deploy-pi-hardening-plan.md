# Pi Deploy Helper Hardening Plan

`tools/deploy_pi.sh` is the repo-native source-copy update path for installed
Raspberry Pi units such as `wren`. It syncs the current checkout, preserves
remote runtime state, installs production dependencies, restarts the
role-specific systemd unit, verifies service and route readiness, and can run
the hardware smoke test. The helper's main contract is to prove that the
deployed code is actually running.

## Failure Modes This Guards Against

- A plain `systemctl restart` could leave `shadowscore-server.service` stuck in
  `deactivating`, or return without replacing the old Node process.
- `systemctl status` is useful context, but it does not by itself prove that the
  live process changed.
- Sudo failures should be detected before the source sync when restart is
  enabled.
- Host deploys should not pass unless the current host routes answer after
  restart.
- Rsync output should not bury the operational facts that matter during a fast
  test deploy.

## Implemented Behavior

### Restart Proof

- Captures `MainPID`, `ActiveState`, `SubState`, `ActiveEnterTimestamp`, and
  `ExecMainStartTimestamp` before restart.
- Restarts the selected unit.
- Polls until the unit reaches `active/running`, or fails with a clear timeout.
- Prints the before/after service snapshot.
- For an already-running service, warns if both the PID and start timestamp are
  unchanged after restart.

### Stuck-Service Recovery

- Provides an explicit `--force-restart` mode that kills, resets, and starts the
  selected unit instead of doing a normal restart.
- If a normal restart leaves the unit unhealthy, runs the same recovery path:
  `systemctl kill -s SIGKILL`, `systemctl reset-failed`, then `systemctl start`.
- Re-runs the same active/running proof after recovery.
- If automatic recovery cannot run, prints the exact manual commands.

### Sudo Preflight

- Before rsync, checks sudo when restart is enabled.
- If sudo is unavailable, fails early with the manual command
  sequence instead of syncing files and discovering the problem later.
- Keeps `--no-sudo-preflight` as an escape hatch for unusual manual sessions.
- Allows `SHADOWSCORE_SUDO_PASSWORD` for known lab units that require sudo
  password entry during unattended test deploys.

### Host Route Verification

- For `--role host`, verifies live HTTP routes after restart:
  `/healthz`, `/session`, `/matrix-edit`, and `/event-list`.
- Allows rollout-specific route checks with repeatable `--verify-route <path>`.
- Polls route checks briefly so a clean restart has time to bind the port.
- Keeps hardware smoke as a separate deeper check.

### Provenance Output

- Prints the local git commit and dirty state before deploy.
- If `public/matrix-edit/build-info.json` exists, prints its Matrix Edit commit
  and dirty flag.
- After deploy, prints enough service and route evidence to answer what is live.

### Rsync Output

- Makes normal rsync output concise.
- Keeps `--verbose-rsync` for diagnosing file-level sync behavior.
- Preserves dry-run behavior.

## Completed Implementation

1. Durable plan document is routed from `docs/README.md`.
2. `tools/deploy_pi.sh` includes restart proof, sudo preflight, recovery, and
   default host route checks.
3. README and deployment docs describe the new flags and behavior.
4. The deployment TODO is marked complete.
5. Local validation uses syntax/help/dry-run checks.
6. Live deploy acceptance requires restart proof, route shape, and hardware
   smoke.

## Validation Checklist

- `bash -n tools/deploy_pi.sh`
- `tools/deploy_pi.sh --help`
- `tools/deploy_pi.sh --alias wren --dry-run`
- Live test on `wren`:
  - service reaches `active/running`
  - service snapshot changes or emits an explicit unchanged warning
  - `/healthz`, `/session`, `/matrix-edit`, and `/event-list` answer
  - hardware smoke passes with `config/shadowscore.host.local.json`
