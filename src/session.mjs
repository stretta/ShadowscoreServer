export function createSessionSnapshot(score, config, request) {
  const baseUrl = publicBaseUrl(config, request);
  const assignments = score.assignments ?? {};

  return {
    ensembleId: score.ensembleId,
    scoreVersion: score.version,
    server: {
      role: config.server?.role ?? "host",
      advertisedName: config.server?.advertisedName ?? "",
      hostIdentity: config.server?.hostIdentity ?? "",
      url: baseUrl
    },
    endpoints: {
      app: `${baseUrl}/`,
      admin: `${baseUrl}/admin`,
      score: `${baseUrl}/score`,
      events: `${baseUrl}/events`,
      collab: websocketUrl(baseUrl, "/collab")
    },
    voices: Object.keys(score.voices).map((voiceId) => ({
      id: voiceId,
      version: score.voices[voiceId].version,
      assignment: assignments[voiceId] ?? emptyAssignment()
    })),
    assignments,
    hardwareUnits: [],
    rnbo: {
      enabled: Boolean(config.rnbo?.enabled),
      host: config.rnbo?.host ?? "",
      port: config.rnbo?.port ?? null,
      address: config.rnbo?.address ?? "",
      targets: config.rnbo?.targets ?? []
    }
  };
}

function publicBaseUrl(config, request) {
  if (config.http?.publicUrl) {
    return stripTrailingSlash(config.http.publicUrl);
  }
  const host = request?.headers?.host ?? `${config.http?.host ?? "127.0.0.1"}:${config.http?.port ?? 8790}`;
  return `http://${host}`;
}

function websocketUrl(baseUrl, path) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function emptyAssignment() {
  return {
    assignee: "",
    deviceId: "",
    clientId: null,
    label: "",
    color: "",
    locked: false
  };
}
