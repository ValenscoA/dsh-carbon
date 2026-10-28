/**
 * The artwork: the plugin icon, the repository logo, and the three banners.
 *
 * Generated rather than drawn by hand for one reason: the whale in the art has
 * to be the whale in the app. `whaleSvg()` reads the same 36x18 character map
 * the page and the card render, so a change to the sprite moves every asset
 * with it instead of leaving a stale logo behind.
 *
 * Run with `node scripts/make-art.mjs`; it writes `icon.svg` and the SVGs under
 * `docs/`. The PNGs are rasterised from those by `scripts/make-art.sh`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whaleSvg } from '../lib/core/whale.mjs';
import { heatTone } from '../lib/core/heat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const BG = '#0e1116';
const INK = '#f2f4f8';
const MUTED = '#98a2b3';
const DIM = '#6b7480';
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/** The load the whale wears in the artwork: warm, not alarming. */
const ART_LOAD = 0.68;

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

function text(value, { x, y, size = 16, fill = INK, weight = 400, anchor = 'start', family = FONT, spacing = null, opacity = null } = {}) {
  const attrs = [`x="${x}"`, `y="${y}"`, `font-family="${family}"`, `font-size="${size}"`, `font-weight="${weight}"`, `fill="${fill}"`, `text-anchor="${anchor}"`];
  if (spacing !== null) attrs.push(`letter-spacing="${spacing}"`);
  if (opacity !== null) attrs.push(`opacity="${opacity}"`);
  return `<text ${attrs.join(' ')}>${esc(value)}</text>`;
}

/** A soft pool of the heat colour, so the darkness reads as depth not flatness. */
function glow({ id, cx, cy, r, stop = 0.3 }) {
  const { color } = heatTone(3500);
  return `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity="${stop}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`;
}

function whale(load = ART_LOAD, scale = 2.4) {
  return whaleSvg({ load, size: 6 }).replace('<svg ', `<svg transform="scale(${scale})" `);
}

const TAGLINE = 'Carbon footprint of your DeepSeek Harness sessions';
const META = 'local  ·  every factor sourced  ·  no telemetry';
const VERSION = '0.3.1';

/* ------------------------------------------------------------------ *
 * logo: square, for an avatar slot or a README badge
 * ------------------------------------------------------------------ */

function logo({ size = 512, radius = 96, whaleScale = 2.05 } = {}) {
  const whaleWidth = 216 * whaleScale;
  const whaleHeight = 108 * whaleScale;
  const x = (size - whaleWidth) / 2;
  const y = (size - whaleHeight) / 2;
  const scale = whaleScale;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="dsh-carbon">`,
    `<title>dsh-carbon</title>`,
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>`,
    glow({ id: 'logoGlow', cx: size / 2, cy: size / 2, r: size * 0.5, stop: 0.22 }),
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">${whale(ART_LOAD, scale)}</g>`,
    '</svg>',
  ].join('');
}

/* ------------------------------------------------------------------ *
 * banners
 * ------------------------------------------------------------------ */

function horizontal() {
  const w = 1280;
  const h = 640;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="dsh-carbon: carbon footprint of your DeepSeek Harness sessions">`,
    `<title>dsh-carbon</title>`,
    `<rect width="${w}" height="${h}" fill="${BG}"/>`,
    glow({ id: 'hGlow', cx: 930, cy: 330, r: 360, stop: 0.26 }),
    `<g transform="translate(748 208)">${whale(ART_LOAD, 2.15)}</g>`,
    text('dsh-carbon', { x: 88, y: 262, size: 74, weight: 700, spacing: '-2.5' }),
    text(TAGLINE, { x: 90, y: 312, size: 22, fill: MUTED }),
    `<rect x="90" y="352" width="72" height="2" fill="${heatTone(3500).color}" opacity="0.85"/>`,
    text(META, { x: 90, y: 396, size: 15, fill: DIM, family: MONO }),
    text(`v${VERSION}`, { x: w - 88, y: h - 52, size: 14, fill: DIM, anchor: 'end', family: MONO }),
    '</svg>',
  ].join('');
}

function square() {
  const s = 1080;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" role="img" aria-label="dsh-carbon: carbon footprint of your DeepSeek Harness sessions">`,
    `<title>dsh-carbon</title>`,
    `<rect width="${s}" height="${s}" fill="${BG}"/>`,
    glow({ id: 'sGlow', cx: s / 2, cy: 430, r: 400, stop: 0.26 }),
    `<g transform="translate(232 222)">${whale(ART_LOAD, 2.85)}</g>`,
    text('dsh-carbon', { x: s / 2, y: 718, size: 92, weight: 700, anchor: 'middle', spacing: '-3' }),
    text(TAGLINE, { x: s / 2, y: 772, size: 26, fill: MUTED, anchor: 'middle' }),
    `<rect x="${s / 2 - 40}" y="812" width="80" height="2" fill="${heatTone(3500).color}" opacity="0.85"/>`,
    text(META, { x: s / 2, y: 862, size: 16, fill: DIM, anchor: 'middle', family: MONO }),
    text(`v${VERSION}`, { x: s / 2, y: s - 64, size: 15, fill: DIM, anchor: 'middle', family: MONO }),
    '</svg>',
  ].join('');
}

function vertical() {
  const w = 1080;
  const h = 1350;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="dsh-carbon: carbon footprint of your DeepSeek Harness sessions">`,
    `<title>dsh-carbon</title>`,
    `<rect width="${w}" height="${h}" fill="${BG}"/>`,
    glow({ id: 'vGlow', cx: w / 2, cy: 560, r: 440, stop: 0.26 }),
    `<g transform="translate(173 250)">${whale(ART_LOAD, 3.4)}</g>`,
    text('dsh-carbon', { x: w / 2, y: 812, size: 104, weight: 700, anchor: 'middle', spacing: '-3.5' }),
    text(TAGLINE, { x: w / 2, y: 872, size: 28, fill: MUTED, anchor: 'middle' }),
    `<rect x="${w / 2 - 40}" y="916" width="80" height="2" fill="${heatTone(3500).color}" opacity="0.85"/>`,
    text(META, { x: w / 2, y: 970, size: 17, fill: DIM, anchor: 'middle', family: MONO }),
    text('dsh plugin add dsh-carbon', { x: w / 2, y: 1084, size: 21, fill: INK, anchor: 'middle', family: MONO }),
    text(`v${VERSION}`, { x: w / 2, y: h - 70, size: 15, fill: DIM, anchor: 'middle', family: MONO }),
    '</svg>',
  ].join('');
}

/* ------------------------------------------------------------------ *
 * write
 * ------------------------------------------------------------------ */

const assets = [
  ['icon.svg', logo({ size: 64, radius: 14, whaleScale: 0.26 })],
  [join('docs', 'logo.svg'), logo()],
  [join('docs', 'banner-horizontal.svg'), horizontal()],
  [join('docs', 'banner-square.svg'), square()],
  [join('docs', 'banner-vertical.svg'), vertical()],
];

for (const [file, svg] of assets) {
  writeFileSync(join(ROOT, file), svg, 'utf8');
  console.log(`wrote ${file} (${svg.length} bytes)`);
}
