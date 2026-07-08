export function rnboPlaybackCapabilities(config, override = {}) {
  const configured = config.rnbo?.capabilities && typeof config.rnbo.capabilities === "object" && !Array.isArray(config.rnbo.capabilities)
    ? config.rnbo.capabilities
    : {};
  override = override && typeof override === "object" && !Array.isArray(override) ? override : {};
  const resolution = config.rnbo?.resolution ?? {};
  const noteDataFloatCount = clampInt(override.noteDataFloatCount ?? configured.noteDataFloatCount ?? resolution.noteDataFloatCount, 8192, 1, 2147483647);
  const noteRowWidth = clampInt(override.noteRowWidth ?? configured.noteRowWidth ?? resolution.noteRowWidth, 10, 1, 1024);
  const maxNoteRows = clampInt(
    override.maxNoteRows ?? configured.maxNoteRows ?? resolution.maxNoteRows ?? Math.floor(noteDataFloatCount / noteRowWidth),
    Math.floor(noteDataFloatCount / noteRowWidth),
    1,
    2147483647
  );

  return {
    maxStages: clampInt(override.maxStages ?? configured.maxStages ?? resolution.maxStages, 4096, 1, 2147483647),
    maxNoteRows,
    noteDataFloatCount,
    noteRowWidth,
    contextDataFloatCount: clampInt(override.contextDataFloatCount ?? configured.contextDataFloatCount ?? resolution.contextDataFloatCount, 64, 1, 2147483647),
    supportsAdaptiveResolution: boolCapability(override, configured, "supportsAdaptiveResolution", true),
    supportsBeginReplaceClear: boolCapability(override, configured, "supportsBeginReplaceClear", false),
    activeRowCountCommit: boolCapability(override, configured, "activeRowCountCommit", false),
    compactScoreReplace: boolCapability(override, configured, "compactScoreReplace", false),
    contractTransport: String(override.contractTransport ?? configured.contractTransport ?? "rnbo-osc"),
    bestEffort: boolCapability(override, configured, "bestEffort", true),
    supportedClockIntervals: clockIntervals(override.supportedClockIntervals ?? configured.supportedClockIntervals ?? resolution.supportedClockIntervals)
  };
}

export function legacyRnboPlaybackCapabilities(config, override = {}) {
  return rnboPlaybackCapabilities(config, {
    maxStages: 1024,
    maxNoteRows: 512,
    ...override
  });
}

function clockIntervals(values) {
  const intervals = Array.isArray(values) && values.length > 0
    ? values
    : [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 32, 40, 48, 60, 80, 96, 120, 160, 240, 480];
  return [...new Set(intervals.map((value) => clampInt(value, 1, 1, 480)).filter((value) => 480 % value === 0))]
    .sort((a, b) => a - b);
}

function clampInt(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function boolCapability(override, configured, name, fallback) {
  if (override[name] !== undefined) {
    return override[name] === true;
  }
  if (configured[name] !== undefined) {
    return configured[name] === true;
  }
  return fallback;
}
