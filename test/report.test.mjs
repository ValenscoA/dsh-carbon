import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFactors, carbonForModel, costForModel, summarise, infraOf } from '../lib/core/carbon.mjs';
import { buildSummary, buildMethodology } from '../lib/core/report.mjs';
import { loadCrossChecks } from '../lib/core/cross-checks.mjs';

const factors = loadFactors();

function session({ id, first, last, model, input, output, cacheRead = 0, cacheWrite = 0, calls = 1 }) {
  const counts = { model, input, output, cacheRead, cacheWrite, calls };
  const perModel = [{ carbon: carbonForModel(counts, factors), cost: costForModel(counts, factors) }];
  return {
    id,
    cwd: '/tmp/workspace',
    firstUsageAt: first,
    lastUsageAt: last,
    turns: 1,
    perModel,
    totals: summarise(perModel),
  };
}

function fixture() {
  return [
    session({
      id: 'session-new',
      first: 2_000,
      last: 3_000,
      model: 'deepseek-v4.1-flash',
      input: 1_000,
      output: 2_000,
      cacheRead: 50_000,
      calls: 3,
    }),
    session({
      id: 'session-old',
      first: 1_000,
      last: 1_500,
      model: 'deepseek-v3',
      input: 5_000,
      output: 1_000,
      cacheRead: 0,
      calls: 2,
    }),
  ];
}

test('summary scales every gram figure by the selected fleet, not just the rows', () => {
  const china = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), generatedAt: 'x' });
  const azure = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'azure'), generatedAt: 'x' });

  assert.equal(azure.infrastructure.key, 'microsoft_azure');
  assert.ok(azure.infrastructure.scale < 1);
  assert.ok(Math.abs(azure.totals.grams - china.totals.grams * azure.infrastructure.scale) < 1e-9);
  assert.ok(Math.abs(azure.totals.low - china.totals.low * azure.infrastructure.scale) < 1e-9);
  assert.ok(Math.abs(azure.totals.high - china.totals.high * azure.infrastructure.scale) < 1e-9);
  assert.ok(Math.abs(azure.totals.latestSessionGrams - china.totals.latestSessionGrams * azure.infrastructure.scale) < 1e-9);
  for (const row of azure.sessions) {
    assert.ok(Math.abs(row.grams - (china.sessions.find((s) => s.id === row.id).grams * azure.infrastructure.scale)) < 1e-9);
  }
});

test('summary totals count every session even when the row list is capped', () => {
  const summary = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), limit: 1, generatedAt: 'x' });
  assert.equal(summary.sessions.length, 1);
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.sessions[0].id, 'session-new', 'newest session comes first');
});

test('summary reports token splits, calls and cost from both sessions', () => {
  const summary = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), generatedAt: 'x' });
  const expectedTokens = 1_000 + 2_000 + 50_000 + 5_000 + 1_000;
  assert.equal(summary.totals.tokens, expectedTokens);
  assert.equal(summary.totals.input, 6_000);
  assert.equal(summary.totals.output, 3_000);
  assert.equal(summary.totals.cacheRead, 50_000);
  assert.equal(summary.totals.calls, 5);
  assert.ok(summary.totals.cost > 0);

  const newest = summary.sessions.find((s) => s.id === 'session-new');
  assert.equal(newest.calls, 3);
  assert.equal(newest.input, 1_000);
  assert.equal(newest.output, 2_000);
  assert.equal(newest.cacheRead, 50_000);
});

test('models aggregate by factor row and cover the whole footprint', () => {
  const summary = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), generatedAt: 'x' });
  const ids = summary.models.map((row) => row.factorId);
  assert.deepEqual(ids.sort(), ['deepseek-v3', 'deepseek-v4.1-flash']);
  for (let i = 1; i < summary.models.length; i += 1) {
    assert.ok(summary.models[i - 1].grams >= summary.models[i].grams, 'models sort by grams, largest first');
  }

  const flash = summary.models.find((row) => row.factorId === 'deepseek-v4.1-flash');
  const v3 = summary.models.find((row) => row.factorId === 'deepseek-v3');
  const share = summary.models.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-12, `shares sum to ${share}`);
  assert.equal(flash.tier, 'derived');
  assert.equal(v3.tier, 'measured');
  assert.equal(flash.calls, 3);
  assert.ok(flash.models.includes('deepseek-v4.1-flash'));
});

test('a session carries the worst tier of the models it used', () => {
  const mixed = session({
    id: 'session-mixed',
    first: 1,
    last: 2,
    model: 'deepseek-v4.1-flash',
    input: 10,
    output: 10,
  });
  const unknown = { model: 'some-other-vendor/model-x', input: 10, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 };
  mixed.perModel.push({
    carbon: carbonForModel(unknown, factors),
    cost: costForModel(unknown, factors),
  });
  mixed.totals = summarise(mixed.perModel);

  const summary = buildSummary({ factors, sessions: [mixed], infra: infraOf(factors, 'china'), generatedAt: 'x' });
  assert.equal(summary.sessions[0].tier, 'unknown', 'the unknown fallback is the worst tier in the mix');
  assert.equal(summary.totals.unmeasured, 1);
  assert.equal(summary.totals.measured, 0);
});

test('summary distinguishes measured from unmeasured sessions', () => {
  const summary = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), generatedAt: 'x' });
  assert.equal(summary.totals.measured, 1);
  assert.equal(summary.totals.unmeasured, 1);
});

test('summary exposes the equivalence set the page shows', () => {
  const summary = buildSummary({ factors, sessions: fixture(), infra: infraOf(factors, 'china'), generatedAt: 'x' });
  assert.ok(Array.isArray(summary.equivalences));
  assert.ok(summary.equivalences.some((entry) => entry.id === 'car'));
  assert.ok(summary.equivalences.some((entry) => entry.id === 'kettle'));
});

test('an empty history is a valid summary, not an error', () => {
  const summary = buildSummary({ factors, sessions: [], infra: infraOf(factors, 'china'), generatedAt: 'x' });
  assert.equal(summary.ok, true);
  assert.equal(summary.totals.sessions, 0);
  assert.equal(summary.totals.grams, 0);
  assert.equal(summary.totals.latestSessionGrams, null);
  assert.deepEqual(summary.sessions, []);
  assert.deepEqual(summary.models, []);
});

test('methodology returns every factor with its source and tier', () => {
  const method = buildMethodology(factors);
  assert.equal(method.ok, true);
  assert.equal(method.methodologyVersion, factors._methodology_version);
  assert.equal(method.models.length, factors.models.length);
  for (const row of [...method.models, method.fallback]) {
    assert.equal(typeof row.source, 'string');
    assert.ok(row.source.length > 20);
    assert.ok(['measured', 'derived', 'extrapolated', 'unknown'].includes(row.tier));
  }
  assert.ok(method.equivalences.world.length >= 2);
});

test('cross-checks are external, sourced and never enter the factor table', () => {
  const checks = loadCrossChecks();
  assert.ok(checks.items.length >= 2);
  for (const item of checks.items) {
    assert.match(item.url, /^https:\/\/www\.knowyourcompute\.com\/models\//);
    assert.ok(item.whPerQuery > 0, `${item.id} energy`);
    assert.ok(item.gramsPerQuery > 0, `${item.id} carbon`);
    assert.ok(item.note.length > 40, `${item.id} note`);
    assert.ok(['order-of-magnitude', 'band-top', 'not-used'].includes(item.verdict), `${item.id} verdict`);
  }

  const v3 = checks.items.find((item) => item.id === 'kyc-v3');
  assert.equal(v3.verdict, 'not-used', 'the V3 row that mixes fleets is explicitly rejected');

  const method = buildMethodology(factors, checks);
  assert.equal(method.crossChecks.items.length, checks.items.length);
  assert.equal(method.models.length, factors.models.length, 'cross-checks do not add factor rows');
});
