#!/usr/bin/env node
/**
 * CLI entry: `dsh-carbon [report|sessions|timeline|json|methodology|sync|card|badge|pr|recompute]`.
 *
 * The report leads with the band rather than a single figure, because on every
 * model this tool currently supports except V3/R1 the point estimate is derived
 * rather than measured.
 *
 * Readings come from the durable store, not from the session logs: `collect()`
 * syncs it, then prices the rows in the selected window. That is what makes
 * `--since 2025-01-01` work on sessions the harness has already pruned.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFactors, carbonForModel, carbonPartsForModel, costForModel, summarise, infraOf } from '../lib/core/carbon.mjs';
import { syncHistory, rowsInRange, resolveRange, sessionAt, historyPath } from '../lib/core/history.mjs';
import { buildTimeline } from '../lib/core/timeline.mjs';
import { renderCard } from '../lib/core/card.mjs';
import { renderBadge, badgeMarkdown } from '../lib/core/badge.mjs';
import { branchInfo, rowsInRepo, prComment, postComment, ghAvailable, openPullRequest } from '../lib/core/pr.mjs';
import { gramsText, compactNumber } from '../lib/core/format.mjs';

const TIER_LABEL = {
  measured: 'measured',
  derived: 'derived',
  extrapolated: 'extrapolated',
  unknown: 'UNKNOWN',
};

const TIER_MARK = {
  measured: '\u25CF',
  derived: '\u25D0',
  extrapolated: '\u25CB',
  unknown: '?',
};

function packageHomepage() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof manifest.homepage === 'string' && manifest.homepage !== '' ? manifest.homepage : undefined;
  } catch {
    return undefined;
  }
}

const RANGE_LABEL = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  '12mo': 'last 12 months',
  all: 'all time',
  custom: 'custom range',
};

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function grams(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kg`;
  if (value >= 1) return `${value.toFixed(1)} g`;
  return `${value.toFixed(3)} g`;
}

function bar(value, max, width = 28) {
  if (max <= 0) return '';
  const filled = Math.max(1, Math.round((value / max) * width));
  return '\u2588'.repeat(filled);
}

/** Block characters by load, for a stripes row that works without colour. */
const BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

function sparkline(buckets) {
  return buckets
    .map((bucket) => {
      if (bucket.grams <= 0) return '\u00B7';
      const load = Math.min(1, Math.max(0, bucket.load ?? 0));
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.round(load * (BLOCKS.length - 1)))];
    })
    .join('');
}

/** Sync the store, then fold the rows in the window into priced sessions. */
function collect(options) {
  const factors = loadFactors();
  const { rows, stats, path } = syncHistory({ force: options.force === true });
  const oldest = rows.reduce((best, row) => {
    const at = sessionAt(row);
    if (!Number.isFinite(at) || at <= 0) return best;
    return best === null || at < best ? at : best;
  }, null);
  const range = resolveRange(options.range ?? 'all', Date.now(), {
    since: options.since,
    until: options.until,
    oldest,
  });
  const picked = rowsInRange(rows, range);

  const sessions = [];
  const parts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const row of picked) {
    const perModel = (row.models ?? []).map((cell) => ({
      carbon: carbonForModel(cell, factors),
      cost: costForModel(cell, factors),
    }));
    if (perModel.length === 0) continue;
    for (const cell of row.models ?? []) {
      const split = carbonPartsForModel(cell, factors).parts;
      parts.input += split.input;
      parts.cacheWrite += split.cacheWrite;
      parts.cacheRead += split.cacheRead;
      parts.output += split.output;
    }
    sessions.push({
      id: row.id,
      cwd: row.cwd ?? null,
      createdAt: row.createdAt ?? null,
      firstUsageAt: row.firstUsageAt ?? null,
      lastUsageAt: row.lastUsageAt ?? null,
      turns: row.turns ?? 0,
      steps: row.steps ?? 0,
      perModel,
      totals: summarise(perModel),
    });
  }
  sessions.sort((a, b) => (b.firstUsageAt ?? 0) - (a.firstUsageAt ?? 0));
  return { factors, sessions, range, stats, path, rows, parts, skippedLines: stats.skippedLines, scanned: stats.onDisk };
}

function report(options) {
  const { factors, sessions, range, stats, path, parts } = collect(options);
  const infra = infraOf(factors, options.infra);
  const scale = infra.scale;

  if (sessions.length === 0) {
    console.log(`No sessions with recorded token usage in the ${RANGE_LABEL[range.key]} window.`);
    console.log(`Store: ${path} (${stats.total} session${stats.total === 1 ? '' : 's'} recorded).`);
    console.log(`Looked in ${stats.onDisk} session log(s) under ${process.env.DSH_HOME ?? '~/.dsh'}/sessions.`);
    return;
  }

  const total = sessions.reduce(
    (acc, session) => {
      acc.grams += session.totals.grams;
      acc.low += session.totals.low;
      acc.high += session.totals.high;
      acc.tokens += session.totals.tokens;
      acc.input += session.totals.input;
      acc.output += session.totals.output;
      acc.cacheRead += session.totals.cacheRead;
      acc.cacheWrite += session.totals.cacheWrite;
      acc.calls += session.totals.calls;
      acc.cost += session.totals.cost;
      if (session.totals.unpriced) acc.unpriced = true;
      if (session.totals.tier === 'measured') acc.measured += 1;
      else acc.derived += 1;
      return acc;
    },
    {
      grams: 0, low: 0, high: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      calls: 0, cost: 0, unpriced: false, measured: 0, derived: 0,
    },
  );

  const g = total.grams * scale;
  const lo = total.low * scale;
  const hi = total.high * scale;

  console.log('');
  console.log('  dsh-carbon \u2014 carbon footprint of your DeepSeek Harness sessions');
  console.log('  ' + '\u2500'.repeat(62));
  const windowLabel =
    range.key === 'custom'
      ? `${new Date(range.from).toISOString().slice(0, 10)} to ${new Date(range.to - 1).toISOString().slice(0, 10)}`
      : RANGE_LABEL[range.key];
  console.log(`  Window          ${windowLabel} (${range.days} ${plural(range.days, 'day', 'days')})`);
  console.log('');
  console.log(`  Estimated       ${grams(g)}`);
  console.log(`  Plausible range ${grams(lo)} \u2013 ${grams(hi)}`);
  console.log('');
  console.log(`  ${total.tokens.toLocaleString('en-US')} tokens over ${total.calls.toLocaleString('en-US')} model calls, ${sessions.length} ${plural(sessions.length, 'session', 'sessions')}`);
  const cacheShare = total.tokens > 0 ? (total.cacheRead / total.tokens) * 100 : 0;
  console.log(`  input ${total.input.toLocaleString('en-US')} \u00B7 output ${total.output.toLocaleString('en-US')} \u00B7 cache reads ${total.cacheRead.toLocaleString('en-US')} (${cacheShare.toFixed(0)}% of tokens)`);
  if (total.cost > 0) {
    console.log(`  API-equivalent cost at peak tariff: $${total.cost.toFixed(4)}${total.unpriced ? ' (some models unpriced)' : ''}`);
  }
  console.log('');

  const eqs = factors.equivalences[localeSet(factors)];
  const car = eqs.find((e) => e.id === 'car');
  if (car !== undefined) {
    const value = g / car.divisor;
    // A single session can be a few grams; "0.0 miles" is noise, not a scale.
    console.log(`  \u2248 ${value < 0.1 ? '<0.1' : value.toFixed(car.decimals)} ${car.label}`);
  }
  const kettle = eqs.find((e) => e.id === 'kettle');
  if (kettle !== undefined && g / kettle.divisor >= 0.1) {
    console.log(`  \u2248 ${(g / kettle.divisor).toFixed(kettle.decimals)} ${kettle.label}`);
  }
  console.log('');

  console.log('  Per session');
  const max = Math.max(...sessions.map((s) => s.totals.grams));
  for (const session of sessions.slice(0, options.limit ?? 12)) {
    const value = session.totals.grams * scale;
    const when = session.firstUsageAt !== null ? new Date(session.firstUsageAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown       ';
    const models = [...new Set(session.perModel.map((p) => p.carbon.factorId))].join('+');
    console.log(
      `  ${TIER_MARK[session.totals.tier]} ${when}  ${grams(value).padStart(9)}  ${bar(session.totals.grams, max, 18).padEnd(18)} ${models}`,
    );
  }
  if (sessions.length > (options.limit ?? 12)) {
    console.log(`  \u2026 ${sessions.length - (options.limit ?? 12)} more`);
  }
  console.log('');

  // The split that explains the number: most tokens are cache reads, most
  // grams are output.
  const scaledParts = {
    input: parts.input * scale,
    cacheWrite: parts.cacheWrite * scale,
    cacheRead: parts.cacheRead * scale,
    output: parts.output * scale,
  };
  const partTotal = scaledParts.input + scaledParts.cacheWrite + scaledParts.cacheRead + scaledParts.output;
  console.log('  By kind of token');
  const kindRows = [
    ['uncached input', total.input, scaledParts.input],
    ['cache writes', total.cacheWrite, scaledParts.cacheWrite],
    ['cache reads', total.cacheRead, scaledParts.cacheRead],
    ['output', total.output, scaledParts.output],
  ];
  for (const [label, tokens, kindGrams] of kindRows) {
    if (tokens === 0) continue;
    console.log(
      `    ${label.padEnd(15)} ${((tokens / total.tokens) * 100).toFixed(1).padStart(5)}% of tokens   ${((kindGrams / partTotal) * 100).toFixed(1).padStart(5)}% of CO2`,
    );
  }
  console.log('');

  const byFactor = new Map();
  for (const session of sessions) {
    for (const entry of session.perModel) {
      const key = entry.carbon.factorId;
      const existing = byFactor.get(key) ?? { grams: 0, tokens: 0, tier: entry.carbon.tier };
      existing.grams += entry.carbon.grams;
      existing.tokens +=
        (entry.carbon.inputs.input ?? 0) +
        (entry.carbon.inputs.output ?? 0) +
        (entry.carbon.inputs.cacheRead ?? 0) +
        (entry.carbon.inputs.cacheWrite ?? 0);
      byFactor.set(key, existing);
    }
  }
  console.log('  Where it comes from');
  for (const [id, value] of [...byFactor.entries()].sort((a, b) => b[1].grams - a[1].grams)) {
    const share = total.grams > 0 ? (value.grams / total.grams) * 100 : 0;
    console.log(`  ${TIER_MARK[value.tier]} ${id.padEnd(20)} ${grams(value.grams * scale).padStart(9)}  ${share.toFixed(0).padStart(3)}%  ${TIER_LABEL[value.tier]}`);
  }
  console.log('');

  console.log('  Confidence');
  if (total.derived > 0) {
    console.log(`  ${total.derived} of ${sessions.length} sessions ran on a model with NO published energy measurement.`);
    console.log('  Those figures are derived from DeepSeek-V3 by active-parameter ratio and are an');
    console.log('  order of magnitude, not a measurement. Run `dsh-carbon methodology` for the working.');
  } else {
    console.log(`  All ${total.measured} sessions ran on models with published per-query energy (V3 / R1).`);
  }
  console.log('');
  if (infra.key !== factors._default_infrastructure) {
    console.log(`  Scaled to ${infra.key} (grid ${infra.cif} kgCO2e/kWh) \u2014 ${(1 / scale).toFixed(2)}x the default reading.`);
    console.log('');
  }
  console.log(`  Fleet assumed: ${factors._default_infrastructure} (grid ${factors._infrastructure[factors._default_infrastructure].cif} kgCO2e/kWh).`);
  console.log('  Override with DSH_CARBON_INFRA=azure for the optimistic reading.');
  if (stats.missing > 0) {
    console.log(`  ${stats.missing} of ${stats.total} stored sessions no longer have a log on disk; they are counted from the store.`);
  }
  if (stats.duplicates > 0) {
    console.log(`  ${stats.duplicates} replayed log line(s) were counted once (duplicate message ids).`);
  }
  if (stats.skippedLines > 0) {
    console.log(`  ${stats.skippedLines} unparseable store line(s) skipped.`);
  }
  console.log('');
}

/** The equivalence set for the current locale, defaulting to the world set. */
function localeSet(factors) {
  const available = factors.equivalences ?? {};
  let tag = '';
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  } catch {
    tag = '';
  }
  const lower = tag.toLowerCase();
  if (lower.startsWith('fr') && available.fr !== undefined) return 'fr';
  if (lower.endsWith('-us') && available.us !== undefined) return 'us';
  return available.world === undefined ? Object.keys(available)[0] : 'world';
}

function sessionsCommand(options) {
  const { sessions, range } = collect(options);
  if (sessions.length === 0) {
    console.log(`No sessions in the ${RANGE_LABEL[range.key]} window.`);
    return;
  }
  for (const session of sessions) {
    const when = session.firstUsageAt !== null ? new Date(session.firstUsageAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
    console.log(
      `${session.id}  ${when}  ${grams(session.totals.grams).padStart(9)}  ${session.totals.tier.padEnd(12)} ${session.cwd ?? ''}`,
    );
  }
}

function timelineCommand(options) {
  const { factors, rows } = collect(options);
  const timeline = buildTimeline({
    factors,
    rows,
    infra: options.infra,
    range: options.range ?? 'all',
    since: options.since,
    until: options.until,
    maxSessions: 0,
  });
  if (options.json === true) {
    console.log(JSON.stringify(timeline, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${timeline.range.days} days \u00B7 one stripe per ${timeline.range.unit}`);
  console.log(`  ${sparkline(timeline.buckets)}`);
  console.log('');
  console.log(`  Total         ${grams(timeline.totals.grams)}`);
  console.log(`  Sessions      ${timeline.totals.sessions}`);
  console.log(`  Median ${timeline.range.unit.padEnd(6)}  ${grams(timeline.medianBucketGrams)}`);
  if (timeline.change !== null) {
    console.log(`  Change        ${timeline.change >= 0 ? '+' : ''}${(timeline.change * 100).toFixed(0)}% vs the previous ${timeline.range.days} days`);
  }
  console.log('');
  console.log('  By kind of token');
  for (const entry of timeline.kinds) {
    if (entry.tokens === 0) continue;
    console.log(
      `    ${entry.kind.padEnd(11)} ${(entry.tokenShare * 100).toFixed(1).padStart(5)}% of tokens  ${(entry.gramShare * 100).toFixed(1).padStart(5)}% of CO2  ${grams(entry.grams)}`,
    );
  }
  console.log('');
}

function jsonCommand(options) {
  const { factors, sessions, range, stats, path } = collect(options);
  const infra = infraOf(factors, options.infra);
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        store: path,
        range,
        coverage: { stored: stats.total, onDisk: stats.onDisk, missing: stats.missing },
        infrastructure: infra,
        methodologyVersion: factors._methodology_version,
        sessions,
      },
      null,
      2,
    ),
  );
}

function syncCommand(options) {
  const { stats, path } = collect({ ...options, force: options.force });
  console.log('');
  console.log(`  Store   ${path}`);
  console.log(`  ${stats.total} session${stats.total === 1 ? '' : 's'} recorded, ${stats.onDisk} log${stats.onDisk === 1 ? '' : 's'} on disk, ${stats.missing} without a log.`);
  console.log(`  This run: ${stats.parsed} parsed, ${stats.reused} unchanged, ${stats.added} new, ${stats.updated} updated.`);
  if (stats.duplicates > 0) console.log(`  ${stats.duplicates} replayed log line(s) ignored.`);
  if (stats.unreadable > 0) console.log(`  ${stats.unreadable} log(s) could not be read.`);
  if (stats.skippedLines > 0) console.log(`  ${stats.skippedLines} unparseable store line(s) skipped.`);
  console.log('');
}

function cardCommand(options) {
  const { factors, rows } = collect({ range: 'all', ...options });
  const timeline = buildTimeline({
    factors,
    rows,
    infra: options.infra,
    range: options.range ?? '30d',
    since: options.since,
    until: options.until,
  });
  const svg = renderCard({ timeline });
  if (options.stdout === true) {
    process.stdout.write(svg);
    return;
  }
  const file = resolve(options.out ?? `dsh-carbon-${timeline.range.since}.svg`);
  writeFileSync(file, svg, 'utf8');
  console.log(`Wrote ${file}`);
  const count = timeline.totals.sessions;
  console.log(`${gramsText(timeline.totals.grams)} CO2e over ${timeline.range.days} days \u00B7 ${count} ${plural(count, 'session', 'sessions')}`);
  console.log('SVG: open it in a browser, or convert to PNG with any image tool.');
}

function badgeCommand(options) {
  const { factors, rows } = collect({ range: 'all', ...options });
  const timeline = buildTimeline({
    factors,
    rows,
    infra: options.infra,
    range: options.range ?? 'all',
    since: options.since,
    until: options.until,
  });
  if (options.svg === true) {
    const svg = renderBadge({ grams: timeline.totals.grams });
    if (options.out !== undefined) {
      writeFileSync(resolve(options.out), svg, 'utf8');
      console.log(`Wrote ${resolve(options.out)}`);
    } else {
      process.stdout.write(svg);
    }
    return;
  }
  console.log(badgeMarkdown({ grams: timeline.totals.grams, href: packageHomepage() }));
  console.log('');
  console.log(`# ${gramsText(timeline.totals.grams)} CO2e, ${timeline.totals.sessions} ${plural(timeline.totals.sessions, 'session', 'sessions')}, ${timeline.range.days} days`);
  console.log('# Paste the line above into a README. The image is a static shields.io badge built');
  console.log('# from your local store; nothing is sent anywhere when it renders.');
}

function prCommand(options) {
  const cwd = process.cwd();
  const info = branchInfo(cwd);
  if (info === null) {
    console.error(`Not inside a git repository: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const { factors, rows } = collect({ range: 'all' });
  const mine = rowsInRepo(rows, info.root);
  if (mine.length === 0) {
    console.log(`No stored sessions with a working directory inside ${info.root}.`);
    console.log('Run some sessions in this repository first, then run this again.');
    return;
  }

  // The window runs from the branch point to now. Without a merge base there is
  // no honest start, so the whole repository history is used and the comment
  // says so rather than inventing a date.
  const since = info.baseAt;
  const oldest = mine.reduce((best, row) => Math.min(best, sessionAt(row)), Number.POSITIVE_INFINITY);
  const range =
    since === null
      ? resolveRange('all', Date.now(), { oldest: Number.isFinite(oldest) ? oldest : null })
      : { from: since, to: Date.now() + 86_400_000, key: 'custom', unit: 'day', days: Math.max(1, Math.round((Date.now() - since) / 86_400_000)) };
  const inWindow = mine.filter((row) => sessionAt(row) >= range.from && sessionAt(row) < range.to);

  const timeline = buildTimeline({
    factors,
    rows: inWindow,
    infra: options.infra,
    range: 'all',
    maxSessions: 0,
  });

  const body = prComment({
    grams: timeline.totals.grams,
    total: timeline.totals,
    sessions: timeline.totals.sessions,
    branch: info.branch,
    base: info.branch,
    repo: info.root,
    unverifiedSessions: Math.max(0, inWindow.length - timeline.totals.sessions),
    rangeDays: range.days,
  });

  if (options.dryRun === true) {
    console.log(body);
    return;
  }
  if (!ghAvailable()) {
    console.log(body);
    console.log('');
    console.error('gh is not installed, so nothing was posted. Install the GitHub CLI, or copy the comment above.');
    process.exitCode = 1;
    return;
  }

  const pr = options.pr === undefined ? openPullRequest(cwd) : { number: options.pr };
  if (pr === null) {
    console.log(body);
    console.log('');
    console.error('No open pull request for this branch. Push the branch and open one, or pass --pr N.');
    process.exitCode = 1;
    return;
  }

  try {
    const result = postComment({ body, cwd, pr: pr.number });
    console.log(`${result.edited ? 'Updated' : 'Posted'} the comment on PR #${pr.number}.`);
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}

function recomputeCommand(options) {
  const { factors, rows, stats, path } = collect({ range: 'all', ...options });
  const timeline = buildTimeline({ factors, rows, infra: options.infra, range: 'all', maxSessions: 0 });
  console.log('');
  console.log('  Recompute \u2014 repricing every stored session from its token counts');
  console.log('  ' + '\u2500'.repeat(58));
  console.log('');
  console.log(`  Store      ${path}`);
  console.log(`  Sessions   ${stats.total}`);
  console.log(`  Tokens     ${compactNumber(timeline.totals.tokens)}`);
  console.log(`  Total      ${grams(timeline.totals.grams)}  (${gramsText(timeline.totals.grams)} CO2e)`);
  console.log(`  Factors    methodology v${factors._methodology_version}, cache reads at ${factors._cache_read_factor.value}x input`);
  console.log('');
  console.log('  Nothing was migrated: the store keeps tokens, never grams, so this total is');
  console.log('  already the reading under the current factors. Editing factors.json and');
  console.log('  re-running any command reprices the whole history.');
  console.log('');
}

function methodology() {
  const factors = loadFactors();
  console.log('');
  console.log('  Methodology');
  console.log('  ' + '\u2500'.repeat(62));
  console.log('');
  console.log('  Formula');
  console.log('    grams = ((input + cacheWrite) * inputFactor');
  console.log('           + cacheRead * inputFactor * ' + factors._cache_read_factor.value);
  console.log('           + output * outputFactor) / 1e6');
  console.log('');
  console.log('  Factors are gCO2e per million tokens.');
  console.log('  ' + factors._cache_read_factor.note);
  console.log('');
  console.log('  Model table');
  for (const row of factors.models) {
    console.log('');
    console.log(`  ${TIER_MARK[row.tier]} ${row.id}  \u2014 ${TIER_LABEL[row.tier]}`);
    console.log(`    input ${row.input}  output ${row.output}  gCO2e/Mtok`);
    console.log(`    band ${row.band.low_multiplier}x \u2013 ${row.band.high_multiplier}x`);
    console.log(`    matches: ${row.match.join(', ')}`);
    if (row.fit !== undefined) {
      console.log(`    fit quality: ${(row.fit.mape * 100).toFixed(1)}% mean error vs published points \u2014 ${row.fit.note}`);
    }
    console.log(`    source: ${row.source}`);
    if (row.derivation !== undefined) console.log(`    derivation: ${row.derivation}`);
    console.log(`    caveat: ${row.caveat}`);
  }
  console.log('');
  console.log('  Infrastructure');
  console.log('  ' + factors._infrastructure.note);
  console.log('');
  for (const [key, value] of Object.entries(factors._infrastructure)) {
    if (typeof value !== 'object') continue;
    console.log(`    ${key.padEnd(20)} PUE ${value.pue}  grid ${value.cif_kgco2e_per_kwh ?? value.cif} kgCO2e/kWh`);
  }
  console.log('');
  console.log(`  Default: ${factors._default_infrastructure}`);
  console.log(`  ${factors._default_infrastructure_rationale}`);
  console.log('');
  console.log('  Storage');
  console.log('    Sessions are stored as token counts in ~/.dsh/carbon/history.jsonl and priced on');
  console.log('    every read, so a corrected factor reprices history with no migration.');
  console.log('');
}

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith('-')) ?? 'report';
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name) => argv.includes(name);

const options = {
  infra: flag('--infra') ?? process.env.DSH_CARBON_INFRA,
  limit: flag('--limit') === undefined ? 12 : Number(flag('--limit')),
  range: flag('--range'),
  since: flag('--since'),
  until: flag('--until'),
  out: flag('--out'),
  pr: flag('--pr') === undefined ? undefined : Number(flag('--pr')),
  force: has('--force'),
  json: has('--json'),
  svg: has('--svg'),
  stdout: has('--stdout'),
  dryRun: has('--dry-run'),
};

const HELP = [
  'usage: dsh-carbon <command> [options]',
  '',
  'commands',
  '  report       totals, band, per-session and per-model breakdown (default)',
  '  sessions     one line per session',
  '  timeline     the stripes row, totals and the split by kind of token',
  '  sync         bring the store up to date with the session logs',
  '  recompute    reprice the whole store from its stored token counts',
  '  card         write the shareable SVG card',
  '  badge        print a shields.io badge for a README',
  '  pr           footprint of this repository since the branch point, posted to its PR',
  '  json         the sessions as JSON',
  '  methodology  factors, derivations and sources',
  '',
  'options',
  '  --range 7d|30d|90d|12mo|all   window (default: all time; card: 30d)',
  '  --since YYYY-MM-DD            start of a custom window',
  '  --until YYYY-MM-DD            end of a custom window (inclusive)',
  '  --limit N                     rows printed by report (default 12)',
  '  --infra china|azure|aws       grid/fleet to read against',
  '  --out FILE                    destination for card --svg / badge --svg',
  '  --stdout                      print the card SVG instead of writing a file',
  '  --svg                         print the badge SVG instead of the markdown',
  '  --json                        machine-readable output (timeline)',
  '  --dry-run                     print the PR comment, post nothing',
  '  --pr N                        target a specific pull request',
  '  --force                       re-parse every log on sync',
  '',
  'The store lives in ~/.dsh/carbon/history.jsonl. Override with DSH_CARBON_HISTORY.',
].join('\n');

if (command === 'report') report(options);
else if (command === 'sessions') sessionsCommand(options);
else if (command === 'timeline') timelineCommand(options);
else if (command === 'json') jsonCommand(options);
else if (command === 'sync') syncCommand(options);
else if (command === 'card') cardCommand(options);
else if (command === 'badge') badgeCommand(options);
else if (command === 'pr') prCommand(options);
else if (command === 'recompute') recomputeCommand(options);
else if (command === 'methodology' || command === 'methods') methodology();
else if (command === 'help' || command === '--help' || command === '-h') console.log(HELP);
else {
  console.error(`unknown command: ${command}`);
  console.error(HELP);
  process.exitCode = 1;
}

export { historyPath };
