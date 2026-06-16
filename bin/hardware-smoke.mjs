#!/usr/bin/env node
import net from "node:net";
import { loadConfig } from "../src/config.mjs";

const cliOptions = readCliOptions(process.argv.slice(2));

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadConfig();
  const result = await runHardwareSmoke(config, cliOptions);
  printReport(result);
  process.exitCode = result.ok ? 0 : 1;
}

export async function runHardwareSmoke(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs ?? 1500);
  const baseUrl = stripTrailingSlash(options.baseUrl || config.http?.publicUrl || `http://127.0.0.1:${config.http?.port ?? 8790}`);
  const rnboOscQueryUrl = stripTrailingSlash(options.rnboOscQueryUrl || config.rnbo?.oscQuery?.url || "http://127.0.0.1:5678");

  const checks = [];
  checks.push(await checkHttpJson("healthz", `${baseUrl}/healthz`, fetchImpl, timeoutMs, (payload) => payload.ok === true));
  checks.push(await checkHttpJson("session", `${baseUrl}/session`, fetchImpl, timeoutMs, (payload) => Array.isArray(payload.voices) && payload.voices.length > 0));
  checks.push(await checkHttpJson("rnbo targets", `${baseUrl}/rnbo/targets`, fetchImpl, timeoutMs, (payload) => Array.isArray(payload.targets)));
  checks.push(await checkTcpPort("http port", config.http?.host ?? "127.0.0.1", config.http?.port ?? 8790, timeoutMs, options.netConnect));

  if (config.rnbo?.oscQuery?.enabled) {
    checks.push(await checkHttpJson("RNBOOSCQuery", rnboOscQueryUrl || "http://127.0.0.1:5678", fetchImpl, timeoutMs, (payload) => Boolean(payload)));
  } else {
    checks.push(skipCheck("RNBOOSCQuery", "disabled in config"));
  }

  if (config.server?.role === "peer") {
    checks.push(await checkPeerRegistration(config, fetchImpl, timeoutMs));
  } else {
    checks.push(skipCheck("peer registration", "host role"));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    baseUrl,
    checks
  };
}

export function evaluateChecks(checks) {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    failed: checks.filter((check) => check.status === "fail").map((check) => check.name)
  };
}

async function checkHttpJson(name, url, fetchImpl, timeoutMs, validate) {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    if (!response.ok) {
      return failCheck(name, `${url} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!validate(payload)) {
      return failCheck(name, `${url} returned unexpected JSON`);
    }
    return passCheck(name, url);
  } catch (error) {
    return failCheck(name, `${url} failed: ${messageForError(error)}`);
  }
}

async function checkTcpPort(name, host, port, timeoutMs, netConnect = net.connect) {
  const connectHost = normalizeBindHost(host);
  return new Promise((resolve) => {
    const socket = netConnect({ host: connectHost, port, timeout: timeoutMs });
    let settled = false;

    const finish = (check) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(check);
    };

    socket.once("connect", () => finish(passCheck(name, `${connectHost}:${port}`)));
    socket.once("timeout", () => finish(failCheck(name, `${connectHost}:${port} timed out`)));
    socket.once("error", (error) => finish(failCheck(name, `${connectHost}:${port} failed: ${messageForError(error)}`)));
  });
}

async function checkPeerRegistration(config, fetchImpl, timeoutMs) {
  const sessionHostUrl = stripTrailingSlash(config.registration?.sessionHostUrl);
  const unitId = config.server?.hostIdentity;
  if (!sessionHostUrl) {
    return failCheck("peer registration", "registration.sessionHostUrl is empty");
  }
  if (!unitId) {
    return failCheck("peer registration", "server.hostIdentity is empty");
  }
  const url = `${sessionHostUrl}/hardware/units`;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    if (!response.ok) {
      return failCheck("peer registration", `${url} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    const units = payload.hardwareUnits ?? [];
    const found = units.some((unit) => unit.id === unitId || unit.hostIdentity === unitId);
    return found ? passCheck("peer registration", `${unitId} visible on host`) : failCheck("peer registration", `${unitId} is not visible on host`);
  } catch (error) {
    return failCheck("peer registration", `${url} failed: ${messageForError(error)}`);
  }
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readCliOptions(argv) {
  return {
    baseUrl: readFlag(argv, "--base-url"),
    rnboOscQueryUrl: readFlag(argv, "--rnbo-oscquery-url"),
    timeoutMs: readFlag(argv, "--timeout-ms")
  };
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function printReport(result) {
  console.log(`ShadowscoreServer hardware smoke: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`Server: ${result.baseUrl}`);
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "ok" : check.status;
    console.log(`- ${marker}: ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }
}

function passCheck(name, detail = "") {
  return { name, status: "pass", detail };
}

function failCheck(name, detail) {
  return { name, status: "fail", detail };
}

function skipCheck(name, detail) {
  return { name, status: "skip", detail };
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function normalizeBindHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
