export function createSessionSnapshot(score, config, request, runtime = {}) {
  const baseUrl = publicBaseUrl(config, request);
  const assignments = score.assignments ?? {};
  const targets = runtime.rnboTargets ?? config.rnbo?.targets ?? [];
  const hardwareUnits = runtime.hardwareUnits ?? [];

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
      matrixEdit: `${baseUrl}/matrix-edit`,
      eventList: `${baseUrl}/event-list`,
      structureEditor: `${baseUrl}/`,
      structurePlayhead: `${baseUrl}/structure/playhead`,
      macroPlayback: `${baseUrl}/macrostructure/playback`,
      admin: `${baseUrl}/admin`,
      structure: `${baseUrl}/structure`,
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
    assignmentPresets: Object.entries(config.ensemble?.assignmentPresets ?? {}).map(([id, preset]) => ({
      id,
      label: preset.label ?? id
    })),
    hardwareUnits,
    macroPlayback: runtime.macroPlayback?.snapshot?.() ?? {
      running: false,
      activeBlockId: score.structureState?.activeBlockId ?? "",
      macroIndex: score.structureState?.macroIndex ?? 0,
      nextAdvanceAt: null,
      currentBlockDurationMs: 0
    },
    rnbo: {
      enabled: Boolean(config.rnbo?.enabled),
      host: config.rnbo?.host ?? "",
      port: config.rnbo?.port ?? null,
      address: config.rnbo?.address ?? "",
      oscQuery: {
        enabled: Boolean(config.rnbo?.oscQuery?.enabled),
        url: config.rnbo?.oscQuery?.url ?? ""
      },
      targets
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
    rnboTargetId: "",
    rnboHost: "",
    rnboPort: null,
    rnboAddress: "",
    label: "",
    color: "",
    locked: false
  };
}
