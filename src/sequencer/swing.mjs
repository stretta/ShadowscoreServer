export const DEFAULT_SWING = 0;
export const DEFAULT_SWING_AMT = 0.5;

export function normalizeSwing(value) {
  if (value === true || value === "On" || value === "on") return 1;
  if (value === false || value === "Off" || value === "off") return 0;
  const number = Number(value);
  if (number === 0 || number === 1) return number;
  throw new Error("Swing must be Off, On, 0, or 1");
}

export function normalizeSwingAmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 1) {
    throw new Error("SwingAmt must be a number from 0.5 through 1");
  }
  return number;
}

export function normalizeBlockSwing(document = {}) {
  return {
    swing: normalizeSwing(document.swing ?? DEFAULT_SWING),
    swingAmt: normalizeSwingAmt(document.swingAmt ?? DEFAULT_SWING_AMT)
  };
}
