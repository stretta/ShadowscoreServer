import Bonjour from "bonjour-service";

export function createOscQueryBonjourDiscovery(options = {}) {
  const now = options.now ?? (() => Date.now());
  const bonjour = options.bonjour ?? new Bonjour(undefined, (error) => {
    options.onError?.(error);
  });
  const services = new Map();
  let browser;

  return {
    start() {
      if (browser) return;
      browser = bonjour.find({ type: "oscjson", protocol: "tcp" });
      browser.on("up", remember);
      browser.on("srv-update", remember);
      browser.on("txt-update", remember);
      browser.on("down", forget);
    },
    refresh() {
      browser?.expire?.();
      browser?.update?.();
    },
    snapshot() {
      return Array.from(services.values())
        .map((service) => structuredClone(service))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    close() {
      browser?.stop?.();
      browser = undefined;
      bonjour.destroy?.();
      services.clear();
    }
  };

  function remember(service) {
    const candidate = normalizeOscQueryService(service, now());
    if (candidate) services.set(candidate.id, candidate);
  }

  function forget(service) {
    const candidate = normalizeOscQueryService(service, now());
    if (candidate) services.delete(candidate.id);
  }
}

export function normalizeOscQueryService(service, observedAtMs = Date.now()) {
  const serviceName = stringField(service?.name);
  const id = slug(serviceName.replace(/^rnbo:/i, ""));
  if (!id) return null;
  const advertisedHost = normalizeHost(service?.host);
  const addresses = Array.isArray(service?.addresses)
    ? service.addresses.map(stringField).filter(Boolean)
    : [];
  const ipv4 = addresses.find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) ?? "";
  const host = advertisedHost || `${id}.local`;
  const port = validPort(service?.port, 5678);
  return {
    id,
    name: id,
    serviceName,
    host,
    address: ipv4,
    addresses,
    port,
    oscQueryUrl: `http://${urlHost(host)}:${port}`,
    graphEditorUrl: `http://${urlHost(host)}:3000`,
    shadowscoreUrl: `http://${urlHost(host)}:8790`,
    observedAt: new Date(observedAtMs).toISOString(),
    source: "bonjour-oscquery"
  };
}

function normalizeHost(value) {
  const host = stringField(value).replace(/\.$/, "");
  if (!host || host === "localhost") return "";
  return host.includes(".") || host.includes(":") ? host : `${host}.local`;
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function slug(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
