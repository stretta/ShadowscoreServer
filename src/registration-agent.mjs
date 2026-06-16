#!/usr/bin/env node
import os from "node:os";
import { configuredRnboTargets, discoverRnboTargets } from "./adapters/rnbo-oscquery.mjs";
import { loadConfig } from "./config.mjs";

const config = await loadConfig();
const once = process.argv.includes("--once");
const sessionHostUrl = stripTrailingSlash(config.registration?.sessionHostUrl);

if (!sessionHostUrl) {
  console.error("[registration-agent] config.registration.sessionHostUrl is required");
  process.exit(1);
}

const unitId = config.server?.hostIdentity || os.hostname();
const intervalMs = clampMs(config.registration?.heartbeatIntervalMs, 10000, 1000, 3600000);

await register();

if (once) {
  process.exit(0);
}

setInterval(() => {
  void heartbeat().catch(async (error) => {
    console.error(`[registration-agent] heartbeat failed: ${messageForError(error)}`);
    await register().catch((registerError) => {
      console.error(`[registration-agent] re-register failed: ${messageForError(registerError)}`);
    });
  });
}, intervalMs);

async function register() {
  const targets = await readLocalTargets();
  const body = {
    id: unitId,
    role: "peer",
    advertisedName: config.server?.advertisedName || unitId,
    hostIdentity: config.server?.hostIdentity || unitId,
    sessionHostUrl,
    heartbeatTtlMs: config.registration?.heartbeatTtlMs,
    targets
  };
  const response = await postJson(`${sessionHostUrl}/hardware/register`, body);
  console.log(`[registration-agent] registered ${unitId} with ${targets.length} target(s)`);
  return response;
}

async function heartbeat() {
  await postJson(`${sessionHostUrl}/hardware/units/${encodeURIComponent(unitId)}/heartbeat`, {});
  console.log(`[registration-agent] heartbeat ${unitId}`);
}

async function readLocalTargets() {
  const discovered = await discoverRnboTargets(config);
  const targets = discovered.length > 0 ? discovered : configuredRnboTargets(config);
  return targets.map((target) => ({
    ...target,
    hardwareUnitId: unitId,
    hardwareUnitName: config.server?.advertisedName || unitId
  }));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function clampMs(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
