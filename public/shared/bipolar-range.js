export function bipolarRangeState(minValue, maxValue, currentValue) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const value = Number(currentValue);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || min >= 0 || max <= 0 || max <= min) {
    return null;
  }

  const percent = (candidate) => Math.min(100, Math.max(0, ((candidate - min) / (max - min)) * 100));
  const zero = percent(0);
  const selected = percent(value);
  return {
    zero,
    value: selected,
    fillStart: Math.min(zero, selected),
    fillEnd: Math.max(zero, selected)
  };
}

export function updateBipolarRange(input) {
  if (typeof HTMLInputElement === "undefined" || !(input instanceof HTMLInputElement) || input.type !== "range") return false;
  const state = bipolarRangeState(input.min, input.max, input.value);
  input.classList.toggle("ss-bipolar-range", Boolean(state));
  if (!state) {
    input.style.removeProperty("--ss-range-zero");
    input.style.removeProperty("--ss-range-value");
    input.style.removeProperty("--ss-range-fill-start");
    input.style.removeProperty("--ss-range-fill-end");
    return false;
  }
  input.style.setProperty("--ss-range-zero", `${state.zero}%`);
  input.style.setProperty("--ss-range-value", `${state.value}%`);
  input.style.setProperty("--ss-range-fill-start", `${state.fillStart}%`);
  input.style.setProperty("--ss-range-fill-end", `${state.fillEnd}%`);
  return true;
}

export function installBipolarRanges(root = document) {
  const update = (input) => updateBipolarRange(input);
  root.querySelectorAll?.('input[type="range"]').forEach(update);
  root.addEventListener?.("input", (event) => update(event.target));

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        update(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('input[type="range"]')) update(node);
        node.querySelectorAll?.('input[type="range"]').forEach(update);
      }
    }
  });
  observer.observe(root.documentElement ?? root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["min", "max", "value"]
  });
  return observer;
}

if (typeof document !== "undefined") {
  installBipolarRanges(document);
}
