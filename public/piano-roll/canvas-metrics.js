const DEFAULT_MAX_DIMENSION = 16384;
const DEFAULT_MAX_PIXELS = 16000000;

export function canvasMetrics(cssWidth, cssHeight, options = {}) {
  const width = Math.max(1, Number(cssWidth) || 1);
  const height = Math.max(1, Number(cssHeight) || 1);
  const requestedScale = Math.max(0.01, Number(options.devicePixelRatio) || 1);
  const maxDimension = Math.max(1, Number(options.maxDimension) || DEFAULT_MAX_DIMENSION);
  const maxPixels = Math.max(1, Number(options.maxPixels) || DEFAULT_MAX_PIXELS);
  const scale = Math.min(
    requestedScale,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / (width * height))
  );

  return {
    cssWidth: width,
    cssHeight: height,
    scale,
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
}
