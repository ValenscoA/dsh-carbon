/**
 * The shields-style badge.
 *
 * A badge is a claim in a README, so it has one job: be checkable. The message
 * carries the figure and the month it was measured, the colour is the same heat
 * scale as the page, and the link goes to the methodology rather than to a
 * landing page.
 *
 * Rendered here rather than fetched from shields.io because the number must not
 * travel: shields only takes the *text* in the URL for static badges, but a
 * live badge would mean publishing your footprint to a third party on every
 * view. A local SVG is committed once and costs nothing.
 */
import { gramsText } from './format.mjs';
import { heatTone } from './heat.mjs';

const HEIGHT = 20;
const PAD = 6;
const CHAR = 6.35;
const LABEL_BG = '#3d444d';
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** Width of a string at the badge's 11px semi-bold, near enough for layout. */
export function textWidth(value) {
  return Math.round(String(value).length * CHAR);
}

/**
 * @param {object} options
 * @param {number} options.grams   the figure the badge reports
 * @param {string} [options.label] left-hand label
 * @param {string} [options.message] override for the right-hand text
 * @param {number} [options.measuredAt] when the figure was taken
 */
export function renderBadge({ grams, label = 'dsh-carbon', message = null, measuredAt = Date.now() } = {}) {
  const month = new Date(measuredAt).toISOString().slice(0, 7);
  const value = message ?? `${gramsText(grams)} CO₂e · ${month}`;
  const tone = heatTone(grams);

  const labelWidth = textWidth(label) + PAD * 2;
  const valueWidth = textWidth(value) + PAD * 2;
  const width = labelWidth + valueWidth;

  const labelText = `${labelWidth / 2 + 0.5}`;
  const valueText = `${labelWidth + valueWidth / 2 - 0.5}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${esc(`${label}: ${value}`)}">`,
    `<title>${esc(`${label}: ${value}`)}</title>`,
    '<linearGradient id="dshc-badge-sheen" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>',
    `<clipPath id="dshc-badge-round"><rect width="${width}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#dshc-badge-round)">`,
    `<rect width="${labelWidth}" height="${HEIGHT}" fill="${LABEL_BG}"/>`,
    `<rect x="${labelWidth}" width="${valueWidth}" height="${HEIGHT}" fill="${tone.color}"/>`,
    `<rect width="${width}" height="${HEIGHT}" fill="url(#dshc-badge-sheen)"/>`,
    '</g>',
    `<g font-family="${FONT}" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">`,
    `<text x="${labelText}" y="14">${esc(label)}</text>`,
    `<text x="${valueText}" y="14">${esc(value)}</text>`,
    '</g>',
    '</svg>',
  ].join('');
}

/**
 * The markdown a README needs.
 *
 * `href` links to the methodology, because the first question a badge gets is
 * what produced the number.
 */
export function badgeMarkdown({ grams, measuredAt = Date.now(), href = 'https://github.com/deepseek-ai/deepseek-harness', alt = 'DeepSeek Harness carbon footprint' } = {}) {
  const month = new Date(measuredAt).toISOString().slice(0, 7);
  const value = `${gramsText(grams)} CO2e, ${month}`;
  const encoded = encodeURIComponent(value).replace(/-/g, '--').replace(/_/g, '__');
  // shields takes the colour as a bare hex: a leading # would start a fragment
  // and truncate the URL at the colour.
  const url = `https://img.shields.io/badge/dsh--carbon-${encoded}-${hex(grams).replace('#', '')}`;
  return `[![${alt}](${url})](${href})`;
}

/** A hex colour for the heat scale, for the shields URL. */
function hex(grams) {
  const tone = heatTone(grams);
  const match = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/.exec(tone.color);
  if (match === null) return '2f6f4f';
  const [hue, saturation, lightness] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  const sector = Math.floor(hue / 60) % 6;
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];
  return `#${table
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

export { hex as heatHex };
