#!/usr/bin/env node
import os from "node:os";
import { configuredRnboTargets, discoverRnboTargets } from "./adapters/rnbo-oscquery.mjs";
import { loadConfig } from "./config.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadConfig();
  await runRegistrationAgent(config, { once: process.argv.includes("--once") }).catch((error) => {
    console.error(`[registration-agent] ${messageForError(error)}`);
    process.exit(1);
  });
}

export async function runRegistrationAgent(config, options = {}) {
  const sessionHostUrl = stripTrailingSlash(config.registration?.sessionHostUrl);

  if (!sessionHostUrl) {
    throw new Error("config.registration.sessionHostUrl is required");
  }

  const unitId = config.server?.hostIdentity || os.hostname();
  const intervalMs = clampMs(config.registration?.heartbeatIntervalMs, 10000, 1000, 3600000);

  await register(config, sessionHostUrl, unitId);

  if (options.once) {
    return;
  }

  setInterval(() => {
    void heartbeat(sessionHostUrl, unitId).catch(async (error) => {
      console.error(`[registration-agent] heartbeat failed: ${messageForError(error)}`);
      await register(config, sessionHostUrl, unitId).catch((registerError) => {
        console.error(`[registration-agent] re-register failed: ${messageForError(registerError)}`);
      });
    });
  }, intervalMs);
}

async function register(config, sessionHostUrl, unitId) {
  const targets = await readLocalTargets(config, unitId);
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

async function heartbeat(sessionHostUrl, unitId) {
  await postJson(`${sessionHostUrl}/hardware/units/${encodeURIComponent(unitId)}/heartbeat`, {});
  console.log(`[registration-agent] heartbeat ${unitId}`);
}

export async function readLocalTargets(config, unitId = config.server?.hostIdentity || os.hostname()) {
  const discovered = await discoverRnboTargets(config);
  const targets = discovered.length > 0 ? discovered : configuredRnboTargets(config);
  const registrationHost = registrationTargetHost(config, unitId);
  return targets.map((target) => {
    const host = isLoopbackHost(target.host) ? registrationHost : target.host;
    return {
      ...target,
      host,
      hardwareUnitId: unitId,
      hardwareUnitName: config.server?.advertisedName || unitId
    };
  });
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

function registrationTargetHost(config, unitId) {
  return stringField(config.rnbo?.oscQuery?.oscHost)
    || stringField(config.rnbo?.registrationHost)
    || `${unitId}.local`;
}

function isLoopbackHost(host) {
  const value = stringField(host).toLowerCase();
  return !value || value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
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
