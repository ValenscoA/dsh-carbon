/**
 * The range view and the two files it feeds.
 *
 * The arithmetic here has one invariant worth testing hard: the parts add up.
 * Buckets must sum to the window total, the four kinds must sum to the same
 * total, and both must equal what `carbonForModel` says about the same rows.
 * A card and a page that disagree with the CLI would be worse than no card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadFactors, carbonForModel, carbonPartsForModel } from '../lib/core/carbon.mjs';
import { buildTimeline } from '../lib/core/timeline.mjs';
import { renderCard, CARD_HEIGHT, CARD_WIDTH } from '../lib/core/card.mjs';
import { renderBadge, badgeMarkdown, heatHex, textWidth } from '../lib/core/badge.mjs';
import { whaleColors, whaleParts, whaleSvg, WHALE_HEIGHT, WHALE_WIDTH } from '../lib/core/whale.mjs';
import { heatTone, ratioTone, heatLoad } from '../lib/core/heat.mjs';

const factors = loadFactors();

/** A day of sessions spread over `days`, newest last. */
function rows(days = 20, perDay = 2, { start = new Date(2026, 8, 1, 10, 0, 0).getTime() } = {}) {
  const out = [];
  for (let day = 0; day < days; day += 1) {
    for (let index = 0; index < perDay; index += 1) {
      const at = start + day * 86_400_000 + index * 3_600_000;
      const calls = 10 + ((day * 5 + index) % 20);
      out.push({
        v: 1,
        id: `session-${day}-${index}`,
        cwd: `/tmp/project-${day % 3}`,
        workspace: 'ws',
        createdAt: at - 60_000,
        firstUsageAt: at - 30_000,
        lastUsageAt: at,
        turns: 3,
        steps: calls,
        duplicates: 0,
        models: [
          {
            model: 'deepseek-v4.1-flash',
            input: calls * 200,
            output: calls * 120,
            cacheRead: calls * 9000,
            cacheWrite: calls * 40,
            calls,
          },
        ],
        tokens: 0,
      });
    }
  }
  return out;
}

const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();

test('buckets sum to the window total', () => {
  const timeline = buildTimeline({ factors, rows: rows(), range: 'custom', since: '2026-09-01', until: '2026-09-30', now: NOW });
  const bucketSum = timeline.buckets.reduce((acc, bucket) => acc + bucket.grams, 0);
  assert.ok(timeline.totals.grams > 0);
  assert.ok(Math.abs(bucketSum - timeline.totals.grams) < 1e-6, `${bucketSum} vs ${timeline.totals.grams}`);
});

test('the four kinds sum to the total they are a split of', () => {
  const timeline = buildTimeline({ factors, rows: rows(), range: 'all', now: NOW });
  const parts = timeline.kinds.reduce((acc, entry) => acc + entry.grams, 0);
  assert.ok(Math.abs(parts - timeline.totals.grams) < 1e-6);
  const shares = timeline.kinds.reduce((acc, entry) => acc + entry.gramShare, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
});

test('the timeline agrees with carbonForModel on the same rows', () => {
  const source = rows(3, 1);
  const timeline = buildTimeline({ factors, rows: source, range: 'all', now: NOW });
  const expected = source.reduce((acc, row) => {
    const perModel = row.models.map((cell) => carbonForModel(cell, factors));
    return acc + perModel.reduce((sum, carbon) => sum + carbon.grams, 0);
  }, 0);
  assert.ok(Math.abs(timeline.totals.grams - expected) < 1e-6);
});

test('a kind priced per million tokens matches the factor table', () => {
  const cell = { model: 'deepseek-v4.1-flash', input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, calls: 1 };
  const { parts } = carbonPartsForModel(cell, factors);
  const row = factors.models.find((entry) => entry.id === 'deepseek-v4.1-flash');
  assert.ok(Math.abs(parts.output - row.output) < 1e-9, 'a million output tokens cost the output factor');
  assert.equal(parts.input, 0);
});

test('cache reads are most of the tokens and a minority of the grams', () => {
  const timeline = buildTimeline({ factors, rows: rows(5, 2), range: 'all', now: NOW });
  const cache = timeline.kinds.find((entry) => entry.kind === 'cacheRead');
  const output = timeline.kinds.find((entry) => entry.kind === 'output');
  assert.ok(cache.tokenShare > 0.9, 'cache reads dominate the token count');
  assert.ok(cache.gramShare < 0.3, 'but not the footprint');
  assert.ok(output.tokenShare < 0.05, 'output is a rounding error of the tokens');
  assert.ok(output.gramShare > 0.5, 'and most of the footprint');
});

test('a first window has no change figure rather than a fake one', () => {
  const fresh = rows(5, 1, { start: NOW - 3 * 86_400_000 });
  const timeline = buildTimeline({ factors, rows: fresh, range: '7d', now: NOW });
  assert.equal(timeline.change, null, 'nothing to compare against');
  assert.equal(timeline.previous.sessions, 0);
});

test('the change compares the same length of time before', () => {
  const steady = rows(40, 1, { start: NOW - 60 * 86_400_000 });
  const timeline = buildTimeline({ factors, rows: steady, range: '30d', now: NOW });
  assert.notEqual(timeline.change, null);
  assert.ok(timeline.previous.grams > 0);
  assert.ok(Number.isFinite(timeline.change));
});

test('the fleet scale reaches the rows, the buckets and the kinds exactly once', () => {
  const source = rows(4, 1);
  const china = buildTimeline({ factors, rows: source, range: 'all', now: NOW });
  const azure = buildTimeline({ factors, rows: source, range: 'all', now: NOW, infra: 'azure' });
  const ratio = azure.infrastructure.scale;
  assert.ok(Math.abs(azure.totals.grams - china.totals.grams * ratio) < 1e-6);
  const azureBuckets = azure.buckets.reduce((acc, bucket) => acc + bucket.grams, 0);
  assert.ok(Math.abs(azureBuckets - azure.totals.grams) < 1e-6);
  const azureKinds = azure.kinds.reduce((acc, entry) => acc + entry.grams, 0);
  assert.ok(Math.abs(azureKinds - azure.totals.grams) < 1e-6);
});

test('an empty range is a valid payload, not a crash', () => {
  const timeline = buildTimeline({ factors, rows: [], range: '30d', now: NOW });
  assert.equal(timeline.totals.grams, 0);
  assert.equal(timeline.totals.sessions, 0);
  assert.equal(timeline.medianBucketGrams, 0);
  assert.ok(timeline.buckets.length > 0, 'the axis still exists');
  assert.equal(timeline.change, null);
});

test('a stripe is coloured against the median, not the maximum', () => {
  const quiet = ratioTone(0, 100);
  const typical = ratioTone(100, 100);
  const heavy = ratioTone(1600, 100);
  assert.ok(quiet.load < typical.load);
  assert.ok(typical.load < heavy.load);
  assert.equal(heavy.load, 1, 'eight times the median is the red end');
  assert.match(quiet.color, /^hsl\(/);
  assert.equal(ratioTone(50, 0).load, heatLoad(50), 'no median falls back to the absolute scale');
});

test('the heat scale is unchanged for the hero', () => {
  assert.equal(heatTone(0).band, 'low');
  assert.equal(heatTone(5000).band, 'high');
});

test('the card is the size every preview crops to, and carries the figure', () => {
  const timeline = buildTimeline({ factors, rows: rows(10, 2), range: '30d', now: NOW });
  const svg = renderCard({ timeline, generatedAt: NOW });
  assert.match(svg, /^<svg /);
  assert.match(svg, new RegExp(`viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}"`));
  assert.match(svg, /CO₂e/, 'names its unit');
  assert.match(svg, /Estimate, not a measurement/, 'and says what it is not');
  assert.match(svg, /deepseek own china|deepseek_own_china|deepseek own/, 'names the fleet');
  assert.match(svg, /<rect/, 'draws the stripes');
  assert.ok(svg.length > 4000);
});

test('the card escapes text instead of emitting broken markup', () => {
  const timeline = buildTimeline({ factors, rows: rows(3, 1), range: '30d', now: NOW });
  // The fleet name reaches the footer verbatim, so it is the field that would
  // carry an injection out of a hand-edited factors file.
  timeline.infrastructure.key = '<script>alert(1)</script>';
  const svg = renderCard({ timeline, generatedAt: NOW });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('the whale is one sprite with every part present', () => {
  const parts = whaleParts();
  assert.equal(WHALE_WIDTH, 36);
  assert.ok(WHALE_HEIGHT >= 16);
  for (const name of ['body', 'belly', 'eye', 'spout', 'fluke', 'fin']) {
    assert.ok(parts[name].length > 0, `${name} has pixels`);
  }
  const svg = whaleSvg({ load: 0.5, size: 4 });
  assert.match(svg, /viewBox="0 0 36/);
  assert.match(svg, /dshc-whale-spout/, 'the page animates these groups by name');
  assert.match(svg, /role="img"/);
});

test('the whale colour follows the load and stays on the ramp', () => {
  const cool = whaleColors(0);
  const hot = whaleColors(1);
  assert.match(cool.body, /^hsl\(15\d(\.\d)? /);
  assert.match(hot.body, /^hsl\(2(\.0)? /);
  assert.notEqual(cool.body, hot.body);
  assert.equal(whaleColors(Number.NaN).load, 0);
  assert.equal(whaleColors(4).load, 1);
});

test('the badge fits its text and names the figure', () => {
  const svg = renderBadge({ grams: 1720, measuredAt: Date.UTC(2026, 9, 28) });
  assert.match(svg, /dsh-carbon/);
  assert.match(svg, /1\.72 kg CO₂e/);
  assert.match(svg, /2026-10/);
  const width = Number(/width="(\d+)"/.exec(svg)[1]);
  assert.ok(width > textWidth('1.72 kg CO₂e · 2026-10'));
});

test('badge markdown is a shields URL with an encoded message', () => {
  const markdown = badgeMarkdown({ grams: 1720, measuredAt: Date.UTC(2026, 9, 28) });
  assert.match(markdown, /^\[!\[DeepSeek Harness carbon footprint\]\(https:\/\/img\.shields\.io\/badge\//);
  assert.match(markdown, /1\.72%20kg%20CO2e/);
  assert.ok(!markdown.includes('#'), 'a raw # would start a fragment and truncate the colour');
  assert.match(markdown, /-[0-9a-f]{6}\)\]/, 'the colour is a bare hex at the end of the URL');
});

test('the badge colour is a real hex on the same ramp', () => {
  assert.match(heatHex(0), /^#[0-9a-f]{6}$/);
  assert.match(heatHex(5000), /^#[0-9a-f]{6}$/);
  assert.notEqual(heatHex(0), heatHex(5000));
});
