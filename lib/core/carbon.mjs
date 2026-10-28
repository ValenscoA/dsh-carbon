/**
 * Turns token counts into grams of CO2e, and says how much to trust the answer.
 *
 * The arithmetic is the same shape claude-carbon uses — one factor per model per
 * direction, cache reads at a reduced rate — but every result here also carries
 * the confidence tier of the factor that produced it and a low/high band. On an
 * Anthropic-only tool the band would be noise; here the difference between the
 * measured and derived rows is an order of magnitude, so collapsing it into one
 * confident number would be the one dishonest thing this tool could do.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORS_PATH = join(HERE, '..', 'factors', 'factors.json');

export function loadFactors(path = FACTORS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const TIER_RANK = { measured: 0, derived: 1, extrapolated: 2, unknown: 3 };

/**
 * Resolve a model string such as `deepseek/deepseek-v4.1-flash` to a factor row.
 * Longest matching pattern wins so that `v4.1-flash` is not swallowed by `v4`.
 */
export function resolveFactor(model, factors) {
  const haystack = String(model ?? '').toLowerCase();
  let best = null;
  for (const row of factors.models) {
    for (const pattern of row.match) {
      if (!haystack.includes(pattern.toLowerCase())) continue;
      if (best === null || pattern.length > best.length) best = { row, length: pattern.length };
    }
  }
  return best === null ? { ...factors.fallback, matched: null } : { ...best.row, matched: best.row.id };
}

const KINDS = ['input', 'cacheWrite', 'cacheRead', 'output'];

/**
 * The same arithmetic as `carbonForModel`, split by kind of token.
 *
 * The split is what makes the shape of a session legible: cache reads are most
 * of the tokens and a fraction of the grams, while output is a fraction of the
 * tokens and a large share of the grams. The parts always sum to the total, by
 * construction, because both functions price the same four counters with the
 * same four weights.
 */
export function carbonPartsForModel(counts, factors) {
  const factor = resolveFactor(counts.model, factors);
  const cacheReadFactor = factors._cache_read_factor.value;
  // A cache write is a full prefill, so it prices at the input factor.
  const weights = {
    input: factor.input,
    cacheWrite: factor.input,
    cacheRead: factor.input * cacheReadFactor,
    output: factor.output,
  };
  const parts = {};
  for (const kind of KINDS) parts[kind] = ((counts[kind] ?? 0) * weights[kind]) / 1e6;
  parts.total = KINDS.reduce((acc, kind) => acc + parts[kind], 0);
  return { parts, weights, factorId: factor.id, tier: factor.tier };
}

/** Grammes of CO2e for one model's token counts, plus the surrounding band. */
export function carbonForModel(counts, factors) {
  const factor = resolveFactor(counts.model, factors);
  const cacheReadFactor = factors._cache_read_factor.value;

  // A cache write is a full prefill, so it prices at the input factor.
  const uncachedInput = counts.input + (counts.cacheWrite ?? 0);
  const perMillion = (uncachedInput * factor.input + counts.cacheRead * factor.input * cacheReadFactor + counts.output * factor.output) / 1e6;

  const low = perMillion * factor.band.low_multiplier;
  const high = perMillion * factor.band.high_multiplier;

  return {
    model: counts.model,
    factorId: factor.id,
    tier: factor.tier,
    grams: perMillion,
    low,
    high,
    inputs: { ...counts },
    detail: {
      inputFactor: factor.input,
      outputFactor: factor.output,
      cacheReadFactor: factor.input * cacheReadFactor,
      cacheReadShare: factor.input * cacheReadFactor,
      derivation: factor.derivation ?? null,
      caveat: factor.caveat ?? null,
      source: factor.source,
      fit: factor.fit ?? null,
    },
  };
}

const INFRA_ALIASES = {
  china: 'deepseek_own_china',
  deepseek: 'deepseek_own_china',
  deepseek_own_china: 'deepseek_own_china',
  azure: 'microsoft_azure',
  microsoft_azure: 'microsoft_azure',
  aws: 'aws',
};

/**
 * Rescale a China-fleet result onto another fleet.
 *
 * Only used for display of an alternative reading. It is a pure ratio of grid
 * carbon intensity, so it captures the grid half of the difference the paper
 * measured (which also included PUE) and not all of it.
 */
export function infraOf(factors, requested) {
  const key = INFRA_ALIASES[String(requested ?? '').toLowerCase()] ?? factors._default_infrastructure;
  const target = factors._infrastructure[key];
  const base = factors._infrastructure[factors._default_infrastructure];
  return {
    key,
    cif: target.cif,
    pue: target.pue,
    scale: target.cif / base.cif,
  };
}

/** API-equivalent cost in USD at the peak tariff, or null when unpriced. */
export function costForModel(counts, factors) {
  const factor = resolveFactor(counts.model, factors);
  const price = factors.pricing.models[factor.id];
  if (price === undefined) return { usd: null, priced: false, factorId: factor.id };
  const usd =
    (counts.input * price.cache_miss +
      counts.cacheRead * price.cache_hit +
      (counts.cacheWrite ?? 0) * price.cache_miss +
      counts.output * price.output) /
    1e6;
  return { usd, priced: true, factorId: factor.id, tariff: 'peak' };
}

/** Roll per-model results into one session total with a worst-confidence stamp. */
export function summarise(perModel) {
  const totals = perModel.reduce(
    (acc, entry) => {
      acc.grams += entry.carbon.grams;
      acc.low += entry.carbon.low;
      acc.high += entry.carbon.high;
      acc.input += entry.carbon.inputs.input ?? 0;
      acc.output += entry.carbon.inputs.output ?? 0;
      acc.cacheRead += entry.carbon.inputs.cacheRead ?? 0;
      acc.cacheWrite += entry.carbon.inputs.cacheWrite ?? 0;
      acc.calls += entry.carbon.inputs.calls ?? 0;
      acc.cost += entry.cost.usd ?? 0;
      if (!entry.cost.priced) acc.unpriced = true;
      if (
        acc.tier === null ||
        TIER_RANK[entry.carbon.tier] > TIER_RANK[acc.tier]
      ) {
        acc.tier = entry.carbon.tier;
      }
      return acc;
    },
    {
      grams: 0,
      low: 0,
      high: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 0,
      cost: 0,
      unpriced: false,
      tier: null,
    },
  );
  if (totals.tier === null) totals.tier = 'unknown';
  totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}
