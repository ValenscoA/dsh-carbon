/**
 * The whale.
 *
 * claude-carbon has a pixel molecule; this is a pixel whale, on the same
 * principle: a mark whose colour is the reading, so a number has a face before
 * you have read it. It swims left, breathes, and its spout grows as the load
 * rises.
 *
 * The sprite is a character map rather than a path so it stays legible in
 * source and editable by hand — one character per pixel, one colour per
 * character. Both the page and the exported card render from `whaleParts()`,
 * so the whale on your card is the whale you saw.
 *
 * Coordinates are the map's own: x to the right, y down, 36x18.
 */
import { heatLoad, heatRamp } from './heat.mjs';

const MAP = [
  '....................................', // 0
  '............S..S....................', // 1  spout
  '............SSSS....................', // 2
  '.............SS.....................', // 3
  '.............S......................', // 4  blowhole
  '....................................', // 5
  '.....bbbbbbbbbbbbbb.................', // 6
  '...bbbbbbbbbbbbbbbbbbb..............', // 7
  '..bbbbbbbbbbbbbbbbbbbbbb............', // 8
  '.bbbbbbbbbbbbbbbbbbbbbbbbb..........', // 9
  '.bbbbbbbbbbbbbbbbbbbbbbbbbbb........', // 10
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb......', // 11
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.....', // 12
  '.mmmmbbbbbbbbbbbbbbbbbbbbbbbbbbb....', // 13 mouth along the jaw
  '..llllllllllllllllllllllllll........', // 14 underside
  '....llllllllllllllllllllll..........', // 15
  '....nnnnnnn.........................', // 16 fin
  '......nnnnn.........................', // 17
];

/** The fluke sits above the body's tail stock, so it lifts out of the water line. */
const FLUKE = [
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '..............................ffff..',
  '...............................fff..',
  '..............................fff...',
  '.............................fff....',
  '............................fff.....',
  '...........................ffff.....',
  '..........................fffff.....',
  '...........................ffff.....',
  '............................fff.....',
  '.............................fff....',
  '..............................fff...',
  '...............................fff..',
];

function overlay(base, patch) {
  return base.map((row, y) => {
    const chars = row.padEnd(36, '.').split('');
    const layer = (patch[y] ?? '').padEnd(36, '.');
    for (let x = 0; x < 36; x += 1) if (layer[x] !== '.') chars[x] = layer[x];
    return chars.join('');
  });
}

const SPRITE = overlay(MAP, FLUKE);

export const WHALE_WIDTH = 36;
export const WHALE_HEIGHT = SPRITE.length;

/** Where the eye and its highlight sit, in map coordinates. */
export const WHALE_EYE = { x: 4, y: 9 };
export const WHALE_EYE_HIGHLIGHT = { x: 5, y: 9 };

const PART_OF = {
  b: 'body',
  l: 'belly',
  e: 'eye',
  S: 'spout',
  f: 'fluke',
  n: 'fin',
  m: 'mouth',
};

/** Pixels grouped by part, in map coordinates. */
export function whaleParts() {
  const parts = { body: [], belly: [], eye: [], spout: [], fluke: [], fin: [], mouth: [] };
  SPRITE.forEach((line, y) => {
    for (let x = 0; x < line.length; x += 1) {
      const part = PART_OF[line[x]];
      if (part !== undefined) parts[part].push({ x, y });
    }
  });
  // The eye is a lens on the body rather than a pixel in the map: it needs a
  // highlight, and a highlight in the map would be a second colour to keep in
  // step with the palette.
  parts.eye.push({ ...WHALE_EYE, highlight: false });
  parts.eye.push({ ...WHALE_EYE_HIGHLIGHT, highlight: true });
  return parts;
}

/**
 * The sprite's colours at a load.
 *
 * The load moves the hue, not the value: a red whale stays readable instead of
 * turning into a red blob. The belly is the same hue desaturated, because a
 * whale is one colour with a paler underside.
 */
export function whaleColors(load) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0));
  const { hue, saturation, lightness } = heatRamp(clamped);
  const fixed = (value) => Number(value.toFixed(1));
  return {
    load: clamped,
    body: `hsl(${fixed(hue)} ${fixed(saturation)}% ${fixed(lightness)}%)`,
    // A darker underside reads as one body in shadow; a lighter one drew a
    // straight pale band across the animal at banner size.
    belly: `hsl(${fixed(hue)} ${fixed(saturation)}% ${fixed(Math.max(16, lightness - 13))}%)`,
    fluke: `hsl(${fixed(hue)} ${fixed(saturation)}% ${fixed(Math.max(18, lightness - 4))}%)`,
    fin: `hsl(${fixed(hue)} ${fixed(saturation)}% ${fixed(Math.max(16, lightness - 9))}%)`,
    mouth: `hsl(${fixed(hue)} ${fixed(saturation)}% ${fixed(Math.max(12, lightness - 22))}%)`,
    eye: 'hsl(212 32% 10%)',
    eyeHighlight: 'hsl(0 0% 100%)',
    spout: `hsl(196 ${Math.round(40 + clamped * 40)}% ${Math.round(64 - clamped * 8)}%)`,
  };
}

/* ------------------------------------------------------------------ *
 * SVG rendering
 * ------------------------------------------------------------------ */

function escapeXml(value) {
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

function rects(pixels, fill, className = null) {
  const cls = className === null ? '' : ` class="${className}"`;
  return pixels
    .map(({ x, y }) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"${cls}/>`)
    .join('');
}

/**
 * A standalone SVG string of the whale, for the card and for the CLI.
 *
 * The groups carry the same class names the page's stylesheet animates, so the
 * card and the page share one vocabulary; the card simply never gets the CSS.
 */
export function whaleSvg({ load = 0, size = 6, title = null } = {}) {
  const colors = whaleColors(load);
  const parts = whaleParts();
  const label = title === null ? '' : `<title>${escapeXml(title)}</title>`;
  const eye = parts.eye
    .map(
      ({ x, y, highlight }) =>
        `<rect x="${x}" y="${y}" width="1" height="1" fill="${escapeXml(highlight ? colors.eyeHighlight : colors.eye)}"/>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_WIDTH} ${WHALE_HEIGHT}" width="${WHALE_WIDTH * size}" height="${WHALE_HEIGHT * size}" shape-rendering="crispEdges" role="img">`,
    label,
    `<g class="dshc-whale-fin">${rects(parts.fin, colors.fin)}</g>`,
    `<g class="dshc-whale-fluke">${rects(parts.fluke, colors.fluke)}</g>`,
    `<g class="dshc-whale-body">${rects(parts.body, colors.body)}${rects(parts.belly, colors.belly)}${rects(parts.mouth, colors.mouth)}</g>`,
    `<g class="dshc-whale-eye">${eye}</g>`,
    `<g class="dshc-whale-spout">${rects(parts.spout, colors.spout)}</g>`,
    '</svg>',
  ].join('');
}

/** The whale for a gram total, on the same thresholds as the heat tint. */
export function whaleForGrams(grams) {
  return whaleColors(heatLoad(grams));
}

export { SPRITE as WHALE_MAP };
