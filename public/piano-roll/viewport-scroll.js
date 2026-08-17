const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function playheadScrollLeft(options = {}) {
  const mode = options.mode || "off";
  const playheadX = Number(options.playheadX) || 0;
  const scrollLeft = Math.max(0, Number(options.scrollLeft) || 0);
  const viewportWidth = Math.max(1, Number(options.viewportWidth) || 1);
  const contentWidth = Math.max(viewportWidth, Number(options.contentWidth) || viewportWidth);
  const gutterWidth = Math.max(0, Number(options.gutterWidth) || 0);
  const maximum = Math.max(0, contentWidth - viewportWidth);

  if (mode === "centered") {
    return clamp(playheadX - viewportWidth / 2, 0, maximum);
  }
  if (mode === "pages") {
    const visibleLeft = scrollLeft + gutterWidth;
    const visibleRight = scrollLeft + viewportWidth;
    if (playheadX < visibleLeft || playheadX >= visibleRight) {
      return clamp(playheadX - gutterWidth, 0, maximum);
    }
  }
  return clamp(scrollLeft, 0, maximum);
}

export function shouldFollowPlayhead(view) {
  return Boolean(view && Number.isFinite(view.beat) && !view.stale);
}

export function zoomAnchorScrollLeft(options = {}) {
  const oldBeatWidth = Math.max(0.01, Number(options.oldBeatWidth) || 1);
  const newBeatWidth = Math.max(0.01, Number(options.newBeatWidth) || 1);
  const scrollLeft = Math.max(0, Number(options.scrollLeft) || 0);
  const viewportWidth = Math.max(1, Number(options.viewportWidth) || 1);
  const contentWidth = Math.max(viewportWidth, Number(options.contentWidth) || viewportWidth);
  const gutterWidth = Math.max(0, Number(options.gutterWidth) || 0);
  const anchorX = Math.max(gutterWidth, viewportWidth / 2);
  const anchorBeat = Math.max(0, (scrollLeft + anchorX - gutterWidth) / oldBeatWidth);
  const next = gutterWidth + anchorBeat * newBeatWidth - anchorX;
  return clamp(next, 0, Math.max(0, contentWidth - viewportWidth));
}

export function timelineGridStep(subdivisionStep, beatWidth, minimumSpacing = 4) {
  let step = Math.max(0.0001, Number(subdivisionStep) || 1);
  const width = Math.max(0.01, Number(beatWidth) || 1);
  while (step * width < minimumSpacing) step *= 2;
  return step;
}

export function timelineLabelInterval(beatWidth, numerator = 4, minimumSpacing = 34) {
  const width = Math.max(0.01, Number(beatWidth) || 1);
  const beatsPerBar = Math.max(1, Math.round(Number(numerator) || 4));
  if (width >= minimumSpacing) return 1;
  return Math.max(beatsPerBar, Math.ceil(minimumSpacing / (width * beatsPerBar)) * beatsPerBar);
}
