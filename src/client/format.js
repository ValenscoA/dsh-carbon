/**
 * Formatting for the carbon page.
 *
 * The split is deliberate: grams get a unit-aware shape (`{value, unit}`) so
 * the hero can style the unit separately, while everything else returns a
 * finished string. Locale is explicit so a language switch re-formats numbers
 * instead of waiting for a reload.
 */

/** @returns {{value: string, unit: 'g'|'kg'}} */
export function formatGrams(value) {
  if (!Number.isFinite(value) || value <= 0) return { value: '0', unit: 'g' };
  if (value >= 1000) {
    const kg = value / 1000;
    return { value: kg.toFixed(kg >= 100 ? 0 : 2), unit: 'kg' };
  }
  if (value >= 10) return { value: value.toFixed(value >= 100 ? 0 : 1), unit: 'g' };
  if (value >= 1) return { value: value.toFixed(1), unit: 'g' };
  return { value: value.toFixed(2), unit: 'g' };
}

export function gramsText(value) {
  const grams = formatGrams(value);
  return `${grams.value}\u00a0${grams.unit}`;
}

/** 88.2M, 455K, 1.2B \u2014 compact but never round-to-zero a real figure. */
export function compact(value, locale) {
  if (!Number.isFinite(value)) return '\u2014';
  if (value === 0) return '0';
  if (value < 1000) return String(Math.round(value));
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

export function exact(value, locale) {
  if (!Number.isFinite(value)) return '\u2014';
  return new Intl.NumberFormat(locale).format(value);
}

export function percent(value, digits = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 0.01) return '<1';
  if (value < 1) return value.toFixed(1);
  return value.toFixed(digits);
}

export function usd(value, unpriced = false) {
  if (!Number.isFinite(value) || value <= 0) return unpriced ? '\u2014' : '$0';
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

/** A time for a session row; includes the year when it is not this year. */
export function timeLabel(ms, locale) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function clockLabel(ms, locale) {
  if (!Number.isFinite(ms)) return '\u2014';
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** A whole number with at most two decimals, for factors and multipliers. */
export function factorNumber(value) {
  if (!Number.isFinite(value)) return '\u2014';
  if (Math.abs(value) >= 1000) return new Intl.NumberFormat('en-US').format(Math.round(value));
  return String(Math.round(value * 100) / 100);
}

export function multiplier(value) {
  if (!Number.isFinite(value)) return '\u2014';
  const rounded = Math.round(value * 100) / 100;
  return `\u00d7${String(rounded)}`;
}
