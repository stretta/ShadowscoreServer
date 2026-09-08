import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const deployScript = join(repoRoot, "tools", "deploy_pi.sh");

test("deploy preflights the destination and rsync plan before applying a snapshot", async (t) => {
  const fixture = await deployFixture({ remotePathState: "project" });
  cleanupFixture(t, fixture);
  const result = runDeploy(fixture, "--sync-only");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Sync destination preflight: existing ShadowscoreServer tree/);
  assert.match(result.stdout, /Running read-only rsync preflight/);
  assert.match(result.stdout, /Sync preflight passed; applying source snapshot/);

  const calls = await readCalls(fixture.rsyncLog);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("--dry-run"));
  assert.ok(calls[0].includes("--itemize-changes"));
  assert.ok(!calls[1].includes("--dry-run"));
});

test("deploy keeps source snapshots separate from remote runtime state", async (t) => {
  const fixture = await deployFixture({ remotePathState: "project" });
  cleanupFixture(t, fixture);
  const result = runDeploy(fixture, "--sync-only");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = await readCalls(fixture.rsyncLog);
  for (const call of calls) {
    assertFilterPair(call, "/data/***");
    assertFilterPair(call, "/config/*.local.json");
  }
});

test("deploy refuses an occupied non-project destination before rsync", async (t) => {
  const fixture = await deployFixture({ remotePathState: "unsafe" });
  cleanupFixture(t, fixture);
  const result = runDeploy(fixture, "--sync-only");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to sync with --delete/);
  await assert.rejects(readFile(fixture.rsyncLog, "utf8"), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(fixture.sshLog, "utf8"), /mkdir -p/);
});

test("deploy dry-run performs only the read-only rsync preflight", async (t) => {
  const fixture = await deployFixture({ remotePathState: "missing" });
  cleanupFixture(t, fixture);
  const result = runDeploy(fixture, "--dry-run", "--sync-only");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = await readCalls(fixture.rsyncLog);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--dry-run"));
  assert.ok(calls[0].includes("--itemize-changes"));
});

async function deployFixture({ remotePathState }) {
  const root = await mkdtemp(join(tmpdir(), "shadowscore-deploy-test-"));
  const source = join(root, "snapshot");
  const bin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  const rsyncLog = join(root, "rsync.log");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"shadowscore-server"}\n');
  await writeExecutable(join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in
  *"if [ ! -e "*) printf '%s\\n' "$FAKE_REMOTE_PATH_STATE" ;;
esac
`);
  await writeExecutable(join(bin, "rsync"), `#!/bin/sh
{
  printf '%s\\n' CALL
  for argument do printf '%s\\n' "$argument"; done
} >> "$FAKE_RSYNC_LOG"
`);
  return { root, source, bin, sshLog, rsyncLog, remotePathState };
}

function cleanupFixture(t, fixture) {
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
}

function runDeploy(fixture, ...args) {
  return spawnSync("bash", [
    deployScript,
    "--host", "127.0.0.1",
    "--path", "/home/pi/ShadowscoreServer",
    "--local-path", fixture.source,
    "--no-verify-routes",
    "--no-smoke",
    ...args
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FAKE_REMOTE_PATH_STATE: fixture.remotePathState,
      FAKE_SSH_LOG: fixture.sshLog,
      FAKE_RSYNC_LOG: fixture.rsyncLog
    }
  });
}

async function readCalls(path) {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const calls = [];
  for (const line of lines) {
    if (line === "CALL") calls.push([]);
    else calls.at(-1).push(line);
  }
  return calls;
}

function assertFilterPair(call, pattern) {
  const rules = call.flatMap((argument, index) => argument === "--filter" ? [call[index + 1]] : []);
  assert.ok(rules.includes(`protect ${pattern}`), `missing protect rule for ${pattern}`);
  assert.ok(rules.includes(`hide ${pattern}`), `missing hide rule for ${pattern}`);
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, { mode: 0o755 });
}
