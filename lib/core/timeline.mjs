/**
 * The range view: totals over a window, the same window before it, and the
 * per-bucket series the stripes are drawn from.
 *
 * Everything here is derived from stored token counts at read time, so a
 * request with `?range=12mo` and one with `?range=7d` are the same arithmetic
 * over different slices — there is no second pipeline to keep in sync.
 */
import { carbonForModel, carbonPartsForModel, costForModel, infraOf, summarise } from './carbon.mjs';
import { bucketKey, bucketsFor, median, previousRange, rowsInRange, resolveRange, sessionAt } from './history.mjs';
import { ratioTone } from './heat.mjs';

const KIND_ORDER = ['input', 'cacheWrite', 'cacheRead', 'output'];

const TIER_RANK = { measured: 0, derived: 1, extrapolated: 2, unknown: 3 };
function worstTier(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return (TIER_RANK[b] ?? 9) > (TIER_RANK[a] ?? 9) ? b : a;
}

/** Price one stored row into grams, cost and a per-kind split. */
export function annotateRow(row, factors, scale = 1) {
  const perModel = [];
  const parts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let tier = null;

  for (const cell of row.models ?? []) {
    const carbon = carbonForModel(cell, factors);
    const cost = costForModel(cell, factors);
    const { parts: split } = carbonPartsForModel(cell, factors);
    for (const kind of KIND_ORDER) parts[kind] += split[kind] * scale;
    tier = worstTier(tier, carbon.tier);
    perModel.push({ carbon, cost });
  }

  const totals = summarise(perModel);
  const grams = totals.grams * scale;
  return {
    id: row.id,
    at: sessionAt(row),
    cwd: row.cwd ?? null,
    workspace: row.workspace ?? null,
    turns: row.turns ?? 0,
    steps: row.steps ?? 0,
    cwdName: typeof row.cwd === 'string' ? row.cwd.split('/').filter(Boolean).pop() ?? null : null,
    grams,
    low: totals.low * scale,
    high: totals.high * scale,
    tokens: totals.tokens,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    calls: totals.calls,
    cost: totals.cost,
    unpriced: totals.unpriced,
    tier: tier ?? 'unknown',
    parts,
    models: (row.models ?? []).map((cell) => cell.model),
  };
}

function merge(totals, session) {
  totals.grams += session.grams;
  totals.low += session.low;
  totals.high += session.high;
  totals.tokens += session.tokens;
  totals.input += session.input;
  totals.output += session.output;
  totals.cacheRead += session.cacheRead;
  totals.cacheWrite += session.cacheWrite;
  totals.calls += session.calls;
  totals.cost += session.cost ?? 0;
  totals.sessions += 1;
  if (session.unpriced) totals.unpriced = true;
  totals.tier = worstTier(totals.tier, session.tier);
  for (const kind of KIND_ORDER) totals.parts[kind] += session.parts[kind];
  return totals;
}

function emptyTotals() {
  return {
    grams: 0,
    low: 0,
    high: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    cost: 0,
    sessions: 0,
    unpriced: false,
    tier: null,
    parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  };
}

/**
 * @param {object} options
 * @param {object} options.factors   factor file
 * @param {object[]} options.rows    history rows
 * @param {string} [options.infra]   fleet override
 * @param {string} [options.range]   7d | 30d | 90d | 12mo | all | custom
 * @param {string} [options.since]   YYYY-MM-DD, for range=custom
 * @param {string} [options.until]   YYYY-MM-DD, exclusive
 * @param {number} [options.now]
 * @param {number} [options.maxSessions] cap on the session list in the payload
 */
export function buildTimeline({
  factors,
  rows,
  infra: infraOverride,
  range: rangeSpec = '30d',
  since,
  until,
  now = Date.now(),
  maxSessions = 200,
}) {
  const infra = infraOf(factors, infraOverride);
  const oldest = rows.reduce((best, row) => {
    const at = sessionAt(row);
    if (!Number.isFinite(at) || at <= 0) return best;
    return best === null || at < best ? at : best;
  }, null);
  const range = resolveRange(rangeSpec, now, { since, until, oldest });
  const scale = infra.scale;

  const inWindow = rowsInRange(rows, range);
  const totals = inWindow.reduce((acc, row) => merge(acc, annotateRow(row, factors, scale)), emptyTotals());

  // The chosen range and the window before it are comparable only if both are
  // complete; a range that runs past today has no honest predecessor, so the
  // delta is suppressed rather than computed against a partial baseline.
  const previous = previousRange(range);
  const previousTotals = rowsInRange(rows, previous).reduce(
    (acc, row) => merge(acc, annotateRow(row, factors, scale)),
    emptyTotals(),
  );

  const buckets = bucketsFor(range).map((bucket) => ({
    key: bucket.key,
    from: bucket.from,
    to: bucket.to,
    sessions: 0,
    grams: 0,
    tokens: 0,
  }));
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const row of inWindow) {
    const at = sessionAt(row);
    const bucket = byKey.get(bucketKey(at, range.unit));
    if (bucket === undefined) continue;
    const session = annotateRow(row, factors, scale);
    bucket.sessions += 1;
    bucket.grams += session.grams;
    bucket.tokens += session.tokens;
  }

  // Empty periods would drag the median to zero and flatten every stripe into
  // one colour; the median is taken over the periods that saw work.
  const busy = buckets.filter((bucket) => bucket.grams > 0).map((bucket) => bucket.grams);
  const reference = median(busy);
  for (const bucket of buckets) {
    const tone = ratioTone(bucket.grams, reference);
    bucket.color = tone.color;
    bucket.load = tone.load;
  }

  const kinds = KIND_ORDER.map((kind) => {
    const tokens = totals[kind];
    const grams = totals.parts[kind];
    return {
      kind,
      tokens,
      grams,
      tokenShare: totals.tokens > 0 ? tokens / totals.tokens : 0,
      gramShare: totals.grams > 0 ? grams / totals.grams : 0,
      gramsPerMillion: tokens > 0 ? (grams / tokens) * 1e6 : 0,
    };
  });

  const latest = inWindow.length === 0 ? null : inWindow.reduce((best, row) => (sessionAt(row) > sessionAt(best) ? row : best), inWindow[0]);

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    range: {
      key: range.key,
      from: range.from,
      to: range.to,
      unit: range.unit,
      days: range.days,
      since: new Date(range.from).toISOString().slice(0, 10),
      until: new Date(range.to - 1).toISOString().slice(0, 10),
    },
    infrastructure: {
      key: infra.key,
      cif: infra.cif,
      pue: infra.pue,
      scale: infra.scale,
      default: factors._default_infrastructure,
    },
    totals: {
      ...totals,
      tier: totals.tier ?? 'unknown',
      latestSessionGrams: latest === null ? null : annotateRow(latest, factors, scale).grams,
      latestSessionAt: latest === null ? null : sessionAt(latest),
    },
    previous: {
      from: previous.from,
      to: previous.to,
      grams: previousTotals.grams,
      sessions: previousTotals.sessions,
    },
    change:
      previousTotals.grams > 0 && previousTotals.sessions > 0
        ? (totals.grams - previousTotals.grams) / previousTotals.grams
        : null,
    buckets,
    medianBucketGrams: reference,
    kinds,
    sessions: [...inWindow]
      .sort((a, b) => sessionAt(b) - sessionAt(a))
      .slice(0, maxSessions)
      .map((row) => {
        const session = annotateRow(row, factors, scale);
        return {
          id: session.id,
          at: session.at,
          grams: session.grams,
          tokens: session.tokens,
          turns: session.turns,
          cost: session.cost,
          tier: session.tier,
          cwdName: session.cwdName,
          models: session.models,
        };
      }),
    coverage: {
      onDisk: null,
      missing: null,
      stored: rows.length,
    },
  };
}

export { KIND_ORDER };
