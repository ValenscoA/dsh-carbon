/**
 * Number and date formatting for the server-rendered artefacts.
 *
 * The page has its own formatter because it formats with the reader's locale
 * and re-renders on a language switch. A card and a badge are files: they are
 * rendered once, in English, with figures that have to match the CLI's. Keeping
 * that in `lib/core` means the card cannot drift from `dsh-carbon report`.
 */

/** @returns {{value: string, unit: 'g'|'kg'}} */
export function gramsValue(grams) {
  const value = Number.isFinite(grams) ? grams : 0;
  if (value <= 0) return { value: '0', unit: 'g' };
  if (value >= 1000) {
    const kg = value / 1000;
    return { value: kg >= 100 ? kg.toFixed(0) : kg.toFixed(2), unit: 'kg' };
  }
  if (value >= 10) return { value: value.toFixed(value >= 100 ? 0 : 1), unit: 'g' };
  if (value >= 1) return { value: value.toFixed(1), unit: 'g' };
  return { value: value.toFixed(2), unit: 'g' };
}

export function gramsText(grams) {
  const { value, unit } = gramsValue(grams);
  return `${value} ${unit}`;
}

const COMPACT = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

/** 53.2M, 455K, 1.2B — compact but never rounds a real figure to zero. */
export function compactNumber(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const size = Math.abs(value);
  if (size < 1000) return `${sign}${Math.round(size)}`;
  for (const { limit, suffix } of COMPACT) {
    if (size >= limit) {
      const scaled = size / limit;
      return `${sign}${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return `${sign}${Math.round(size)}`;
}

export function usdText(value, unpriced = false) {
  if (!Number.isFinite(value) || value <= 0) return unpriced ? '—' : '$0';
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function percentText(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "28 Oct 2026", in local time. */
export function dateText(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "28 Oct", without the year, for axis labels. */
export function shortDateText(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "October 2026", for month buckets. */
export function monthText(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[date.getMonth()]} ${date.getFullYear()}`;
}
