/**
 * The green-to-yellow-to-red scale, shared by the browser page, the card and
 * the badge.
 *
 * It lives in `lib/core` rather than in the client folder because the server
 * renders the same colours into the SVG exports; two copies would drift.
 *
 * A total footprint has no natural "max", so the scale is logarithmic instead
 * of linear: 250 g is the green end, 5 kg the red end, and every order of
 * magnitude in between moves the hue. The two thresholds are deliberately
 * product choices, not measurements: 250 g is roughly 1.5 km by car, 5 kg
 * roughly 29 km. Below the first the tint stays green; above the second it
 * stays red.
 *
 * The hue is interpolated in two segments so the midpoint is genuinely yellow
 * (interpolating 152 deg to 2 deg directly would pass through olive at 78).
 */

export const GREEN_AT = 250;
export const RED_AT = 5_000;

/** 0 at or below the green threshold, 1 at or above the red one. */
export function heatLoad(grams) {
  if (!Number.isFinite(grams) || grams <= GREEN_AT) return 0;
  const span = Math.log10(RED_AT / GREEN_AT);
  const load = Math.log10(grams / GREEN_AT) / span;
  return Math.min(1, Math.max(0, load));
}

/** Hue/saturation/lightness for a 0..1 load, in two segments through yellow. */
export function heatRamp(load) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0));
  let hue;
  let saturation;
  let lightness;

  if (clamped <= 0.5) {
    const u = clamped * 2;
    hue = 152 + (48 - 152) * u;
    saturation = 45 + (80 - 45) * u;
    lightness = 40 + (50 - 40) * u;
  } else {
    const u = (clamped - 0.5) * 2;
    hue = 48 + (2 - 48) * u;
    saturation = 80 + (65 - 80) * u;
    lightness = 50;
  }

  return { hue, saturation, lightness };
}

/** @returns {{load: number, band: 'low'|'moderate'|'high', color: string}} */
export function heatTone(grams) {
  const load = heatLoad(grams);
  const { hue, saturation, lightness } = heatRamp(load);
  const band = load < 0.33 ? 'low' : load < 0.66 ? 'moderate' : 'high';
  return {
    load,
    band,
    color: `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`,
  };
}

/**
 * The stripes' colour: one period against the median of the periods shown.
 *
 * A stripe at an eighth of the median is the green end, one at eight times it
 * the red end; the log2 ratio keeps a quiet week from disappearing next to a
 * busy one. Below a quarter of the median the stripe keeps a floor of colour so
 * an empty day still reads as a stripe rather than a gap.
 *
 * @returns {{load: number, color: string}} `load` is 0..1 for callers that want
 *   to modulate opacity or the whale's mood alongside the hue.
 */
export function ratioTone(value, median, { green = 0.125, red = 8 } = {}) {
  const baseline = Number.isFinite(median) && median > 0 ? median : 0;
  if (baseline === 0) return { load: 0, color: heatTone(value).color };
  const ratio = Math.max(Number.isFinite(value) ? value : 0, baseline * green * 0.999) / baseline;
  const span = Math.log2(red / green);
  const load = Math.min(1, Math.max(0, Math.log2(ratio / green) / span));
  const { hue, saturation, lightness } = heatRamp(load);
  return {
    load,
    color: `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`,
  };
}

/** The whale's mood: a coarser read of the same load, for faces and motion. */
export function whaleMood(load) {
  const value = Number.isFinite(load) ? load : 0;
  if (value < 0.18) return 'calm';
  if (value < 0.42) return 'content';
  if (value < 0.7) return 'warm';
  return 'hot';
}
