export function rnboPlaybackCapabilities(config, override = {}) {
  override = override && typeof override === "object" && !Array.isArray(override) ? override : {};
  const resolution = config.rnbo?.resolution ?? {};
  const noteDataFloatCount = clampInt(override.noteDataFloatCount ?? resolution.noteDataFloatCount, 8192, 1, 2147483647);
  const noteRowWidth = clampInt(override.noteRowWidth ?? resolution.noteRowWidth, 10, 1, 1024);
  const maxNoteRows = clampInt(
    override.maxNoteRows ?? resolution.maxNoteRows ?? Math.floor(noteDataFloatCount / noteRowWidth),
    Math.floor(noteDataFloatCount / noteRowWidth),
    1,
    2147483647
  );

  return {
    maxStages: clampInt(override.maxStages ?? resolution.maxStages, 4096, 1, 2147483647),
    maxNoteRows,
    noteDataFloatCount,
    noteRowWidth,
    contextDataFloatCount: clampInt(override.contextDataFloatCount ?? resolution.contextDataFloatCount, 64, 1, 2147483647),
    supportsAdaptiveResolution: override.supportsAdaptiveResolution !== false,
    contractTransport: String(override.contractTransport ?? "rnbo-osc"),
    bestEffort: override.bestEffort !== false,
    supportedClockIntervals: clockIntervals(override.supportedClockIntervals ?? resolution.supportedClockIntervals)
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
