import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeZstdFrames, foldSession } from '../lib/core/sessions.mjs';
import { loadFactors, resolveFactor, carbonForModel, costForModel, summarise } from '../lib/core/carbon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('factor table matches what the derivation script produces', () => {
  const committed = readFileSync(join(ROOT, 'lib', 'factors', 'factors.json'), 'utf8');
  const regenerated = execFileSync(process.execPath, [join(ROOT, 'tools', 'derive-factors.mjs')], {
    encoding: 'utf8',
  });
  assert.ok(regenerated.includes('wrote'));
  const fresh = readFileSync(join(ROOT, 'lib', 'factors', 'factors.json'), 'utf8');
  assert.equal(fresh, committed, 'factors.json drifted from tools/derive-factors.mjs; run npm run derive');
});

test('every model row is sourced, graded and banded', () => {
  const factors = loadFactors();
  for (const row of [...factors.models, factors.fallback]) {
    assert.ok(['measured', 'derived', 'extrapolated', 'unknown'].includes(row.tier), `${row.id} tier`);
    assert.equal(typeof row.source, 'string', `${row.id} source`);
    assert.ok(row.source.length > 20, `${row.id} source is not a real citation`);
    assert.ok(row.input >= 0 && row.output > 0, `${row.id} factors positive`);
    assert.ok(row.band.low_multiplier > 0, `${row.id} low band`);
    assert.ok(row.band.high_multiplier >= row.band.low_multiplier, `${row.id} band ordered`);
  }
});

test('output factors exceed input factors, because decode is bandwidth-bound', () => {
  const factors = loadFactors();
  for (const row of factors.models) {
    assert.ok(row.output > row.input, `${row.id}: output factor should dominate input`);
  }
});

test('longest pattern wins so v4.1-flash is not matched as v4', () => {
  const factors = loadFactors();
  assert.equal(resolveFactor('deepseek/deepseek-v4.1-flash', factors).id, 'deepseek-v4.1-flash');
  assert.equal(resolveFactor('deepseek-v4-pro', factors).id, 'deepseek-v4-pro');
  assert.equal(resolveFactor('deepseek-reasoner', factors).id, 'deepseek-r1');
});

test('an unrecognised model is flagged, not silently priced', () => {
  const factors = loadFactors();
  const resolved = resolveFactor('some-other-vendor/model-x', factors);
  assert.equal(resolved.tier, 'unknown');
  assert.equal(resolved.matched, null);
});

test('cache reads price below uncached input and above zero', () => {
  const factors = loadFactors();
  const counts = { model: 'deepseek-v4.1-flash', input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 };
  const result = carbonForModel(counts, factors);
  const factor = resolveFactor(counts.model, factors);
  assert.ok(result.grams > 0);
  assert.ok(result.grams < factor.input, 'a cache read must cost less than a fresh input token');
});

test('cache writes price at the full input factor', () => {
  const factors = loadFactors();
  const factor = resolveFactor('deepseek-v4.1-flash', factors);
  const result = carbonForModel(
    { model: 'deepseek-v4.1-flash', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
    factors,
  );
  assert.equal(Math.round(result.grams), factor.input);
});

test('output tokens dominate a realistic agentic step', () => {
  const factors = loadFactors();
  const result = carbonForModel(
    { model: 'deepseek-v4.1-flash', input: 5000, output: 500, cacheRead: 100_000, cacheWrite: 0 },
    factors,
  );
  const outputShare = (500 * resolveFactor('deepseek-v4.1-flash', factors).output) / 1e6 / result.grams;
  assert.ok(outputShare > 0.5, `output should dominate, got ${(outputShare * 100).toFixed(0)}%`);
});

test('band brackets the point estimate', () => {
  const factors = loadFactors();
  const result = carbonForModel(
    { model: 'deepseek-v4.1-flash', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    factors,
  );
  assert.ok(result.low < result.grams);
  assert.ok(result.high > result.grams);
});

test('summary reports the worst confidence tier in the mix', () => {
  const factors = loadFactors();
  const perModel = [
    { carbon: carbonForModel({ model: 'deepseek-v3', input: 10, output: 10, cacheRead: 0 }, factors), cost: { usd: 1, priced: true } },
    { carbon: carbonForModel({ model: 'deepseek-v4.1-flash', input: 10, output: 10, cacheRead: 0 }, factors), cost: { usd: 1, priced: true } },
  ];
  assert.equal(summarise(perModel).tier, 'derived');
});

test('unpriced models are marked rather than costed at zero', () => {
  const factors = loadFactors();
  assert.equal(costForModel({ model: 'deepseek-v3', input: 1, output: 1, cacheRead: 0 }, factors).priced, false);
  assert.equal(costForModel({ model: 'deepseek-v4.1-flash', input: 1, output: 1, cacheRead: 0 }, factors).priced, true);
});

test('foldSession sums usage and attributes it to the serving model', () => {
  const events = [
    { type: 'session', id: 's1', createdAt: 1000, cwd: '/tmp' },
    { type: 'turn/start' },
    {
      type: 'assistant/message',
      time: 2000,
      data: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, message: { source: { model: 'deepseek-v4.1-flash' } } },
    },
    {
      type: 'assistant/message',
      time: 3000,
      data: { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }, message: { source: { model: 'deepseek-v3' } } },
    },
    { type: 'assistant/message', time: 4000, data: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } },
  ];
  const fold = foldSession(events);
  assert.equal(fold.id, 's1');
  assert.equal(fold.turns, 1);
  assert.equal(fold.byModel.length, 2, 'zero-usage messages must not create a model row');
  const flash = fold.byModel.find((row) => row.model === 'deepseek-v4.1-flash');
  assert.equal(flash.input, 10);
  assert.equal(flash.output, 20);
  assert.equal(flash.cacheRead, 30);
  assert.equal(flash.calls, 1);
  assert.equal(fold.firstUsageAt, 2000);
  assert.equal(fold.lastUsageAt, 3000);
});

test('zstd decoding walks every appended frame', () => {
  // A log the harness appends to is one frame per flush. Node's sync decoder
  // returns only the first, so a single-frame implementation would silently
  // under-report. Assert on content, not line count, so a decoder that returns
  // one line with the wrong payload still fails.
  const frames = ['alpha', 'beta', 'gamma'].map((tag) =>
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', tag })}\n`)),
  );
  const decoded = decodeZstdFrames(Buffer.concat(frames));
  const tags = decoded
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).tag);
  assert.deepEqual(tags, ['alpha', 'beta', 'gamma']);
});

test('a truncated trailing frame does not lose the frames before it', () => {
  // The live log is appended to while it is read, so the last frame is routinely
  // half-written. Everything already flushed must still decode.
  const whole = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', tag: 'whole' })}\n`));
  const cut = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', tag: 'cut' })}\n`));
  const truncated = cut.subarray(0, Math.floor(cut.length / 2));
  const decoded = decodeZstdFrames(Buffer.concat([whole, truncated]));
  const tags = decoded
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).tag);
  assert.deepEqual(tags, ['whole']);
});
