/**
 * The shareable card.
 *
 * A PNG is what people actually post, but an SVG is what a plugin can produce
 * with no browser, no native module and no network: it is a text file, it
 * scales, and the page can turn it into a PNG in the reader's own browser with
 * a canvas. So the server renders SVG and the conversion is the client's
 * business.
 *
 * The card is deliberately 1200x630 — the size every social preview crops to —
 * and it carries the two things that keep a shareable number honest: the band
 * around the point estimate, and the fleet the factors assume.
 */
import { dateText, gramsText, gramsValue, compactNumber, usdText, percentText, shortDateText } from './format.mjs';
import { whaleSvg } from './whale.mjs';
import { heatTone } from './heat.mjs';

const WIDTH = 1200;
const HEIGHT = 630;
const PAD = 64;
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const INK = '#f2f4f8';
const MUTED = '#98a2b3';
const DIM = '#6b7480';
const CARD_BG = '#0e1116';
const BORDER = '#232830';

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

function text(value, { x, y, size = 14, fill = INK, weight = 400, anchor = 'start', family = FONT, spacing = null, opacity = null } = {}) {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${family}"`,
    `font-size="${size}"`,
    `font-weight="${weight}"`,
    `fill="${fill}"`,
    `text-anchor="${anchor}"`,
  ];
  if (spacing !== null) attrs.push(`letter-spacing="${spacing}"`);
  if (opacity !== null) attrs.push(`opacity="${opacity}"`);
  return `<text ${attrs.join(' ')}>${esc(value)}</text>`;
}

const RANGE_LABEL = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12mo': 'Last 12 months',
  all: 'All time',
  custom: 'Custom range',
};

function rangeCaption(timeline) {
  const label = RANGE_LABEL[timeline.range.key] ?? 'Selected range';
  const from = shortDateText(timeline.range.from);
  const to = shortDateText(timeline.range.to - 1);
  const sameYear = new Date(timeline.range.from).getFullYear() === new Date(timeline.range.to - 1).getFullYear();
  return `${label} · ${from}${sameYear ? '' : ` ${new Date(timeline.range.from).getFullYear()}`} – ${to} ${new Date(timeline.range.to - 1).getFullYear()}`;
}

function tierLine(timeline) {
  const tier = timeline.totals.tier ?? 'unknown';
  const label = { measured: 'measured factors', derived: 'derived factors', extrapolated: 'extrapolated factors', unknown: 'unknown model' }[tier] ?? tier;
  return label;
}

function stripes(timeline, { x, y, width, height }) {
  const buckets = timeline.buckets ?? [];
  if (buckets.length === 0) {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${BORDER}"/>`;
  }
  const gap = buckets.length > 90 ? 0 : 1.5;
  const cell = width / buckets.length;
  return buckets
    .map((bucket, index) => {
      const w = Math.max(0.6, cell - gap);
      const empty = bucket.grams <= 0;
      const fill = empty ? '#1b2027' : bucket.color;
      return `<rect x="${(x + index * cell).toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${height}" fill="${fill}" opacity="${empty ? 0.85 : 1}"/>`;
    })
    .join('');
}

/**
 * @param {object} options
 * @param {object} options.timeline the payload from `buildTimeline`
 * @param {number} [options.generatedAt]
 * @param {boolean} [options.includeStripes]
 */
export function renderCard({ timeline, generatedAt = Date.now(), includeStripes = true } = {}) {
  const grams = timeline.totals.grams;
  const { value, unit } = gramsValue(grams);
  const tone = heatTone(grams);
  const total = timeline.totals;
  const stripesY = 452;
  const stripesH = 86;
  const stripeLeft = PAD;
  const stripeWidth = WIDTH - PAD * 2;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${CARD_BG}"/>`);
  parts.push(`<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="${BORDER}"/>`);

  // Masthead.
  parts.push(text('dsh-carbon', { x: PAD, y: 78, size: 22, weight: 700, spacing: '-0.4' }));
  parts.push(text('DeepSeek Harness · session footprint', { x: PAD, y: 102, size: 13, fill: MUTED }));
  parts.push(text(rangeCaption(timeline), { x: WIDTH - PAD, y: 78, size: 13, fill: MUTED, anchor: 'end' }));
  parts.push(text(tierLine(timeline), { x: WIDTH - PAD, y: 102, size: 13, fill: DIM, anchor: 'end' }));

  // The figure.
  const figureTop = 214;
  parts.push(text(value, { x: PAD, y: figureTop, size: 104, weight: 700, spacing: '-3' }));
  const figureWidth = String(value).length * 56;
  parts.push(text(unit === 'kg' ? 'kg CO₂e' : 'g CO₂e', {
    x: PAD + Math.max(60, figureWidth),
    y: figureTop - 6,
    size: 26,
    weight: 500,
    fill: MUTED,
  }));

  parts.push(
    text(
      `between ${gramsText(total.low)} and ${gramsText(total.high)} · ${compactNumber(total.sessions)} session${total.sessions === 1 ? '' : 's'}`,
      { x: PAD, y: figureTop + 42, size: 16, fill: MUTED },
    ),
  );

  const stats = [
    `${compactNumber(total.tokens)} tokens`,
    `${compactNumber(total.calls)} model calls`,
    `${usdText(total.cost, total.unpriced)} at API list prices`,
  ];
  parts.push(text(stats.join('  ·  '), { x: PAD, y: figureTop + 72, size: 14, fill: DIM }));

  // Change against the window before, when there is an honest one.
  if (timeline.change !== null && Number.isFinite(timeline.change)) {
    const up = timeline.change >= 0;
    const label = `${up ? '+' : ''}${percentText(timeline.change, 0)} vs the previous ${timeline.range.days} days`;
    parts.push(text(label, { x: PAD, y: figureTop + 102, size: 13, fill: up ? '#e0796b' : '#65b98c' }));
  }

  // Where the grams actually come from: the one fact a total cannot convey.
  const kinds = new Map((timeline.kinds ?? []).map((entry) => [entry.kind, entry]));
  const output = kinds.get('output');
  const cacheRead = kinds.get('cacheRead');
  if (output !== undefined && cacheRead !== undefined && total.tokens > 0) {
    parts.push(
      text(
        `Output: ${percentText(output.tokenShare, 1)} of tokens, ${percentText(output.gramShare, 0)} of the CO₂.  Cache reads: ${percentText(cacheRead.tokenShare, 0)} of tokens, ${percentText(cacheRead.gramShare, 0)} of the CO₂.`,
        { x: PAD, y: figureTop + 132, size: 13, fill: MUTED },
      ),
    );
  }

  // The whale.
  parts.push(
    `<g transform="translate(${WIDTH - PAD - 366} 146) scale(1.7)">${whaleSvg({ load: tone.load, size: 6, title: 'Whale coloured by this footprint' })}</g>`,
  );

  // Stripes.
  if (includeStripes) {
    parts.push(stripes(timeline, { x: stripeLeft, y: stripesY, width: stripeWidth, height: stripesH }));
    const unitLabel = timeline.range.unit === 'day' ? 'day' : timeline.range.unit === 'week' ? 'week' : 'month';
    const median = gramsText(timeline.medianBucketGrams);
    parts.push(
      text(`One stripe per ${unitLabel}, coloured against the median ${unitLabel} (${median})`, {
        x: stripeLeft,
        y: stripesY - 14,
        size: 12,
        fill: DIM,
      }),
    );
    parts.push(text(shortDateText(timeline.range.from), { x: stripeLeft, y: stripesY + stripesH + 20, size: 11, fill: DIM }));
    parts.push(
      text(shortDateText(timeline.range.to - 1), { x: stripeLeft + stripeWidth, y: stripesY + stripesH + 20, size: 11, fill: DIM, anchor: 'end' }),
    );
  }

  // Footer: what the number is and is not.
  const fleet = timeline.infrastructure?.key ?? 'unknown';
  const cif = timeline.infrastructure?.cif;
  parts.push(
    text(
      `Estimate, not a measurement. Factors: Jegham et al. 2025 · ${fleet.replace(/_/g, ' ')} fleet${Number.isFinite(cif) ? ` (${Math.round(cif * 1000)} gCO₂/kWh)` : ''}`,
      { x: PAD, y: HEIGHT - 34, size: 11, fill: DIM },
    ),
  );
  parts.push(
    text(`generated ${dateText(generatedAt)}`, { x: WIDTH - PAD, y: HEIGHT - 34, size: 11, fill: DIM, anchor: 'end', family: MONO }),
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="dsh-carbon footprint card">`,
    `<title>dsh-carbon: ${gramsText(grams)} CO₂e over ${timeline.range.days} days</title>`,
    parts.join(''),
    '</svg>',
  ].join('');
}

export const CARD_WIDTH = WIDTH;
export const CARD_HEIGHT = HEIGHT;
