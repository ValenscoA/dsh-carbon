/**
 * Assemble the wire summary the web GUI reads.
 *
 * Kept out of the host entry so the arithmetic can be tested without a running
 * web server or a session directory. The input rows are already folded and
 * priced; this module only aggregates, scales onto the selected fleet, and
 * shapes the JSON. Every gram figure is scaled exactly once, including the
 * totals — an earlier version scaled the session rows and the latest-session
 * field but left the totals on the default fleet, so `?infra=azure` produced a
 * page whose header and rows disagreed.
 */

const TIER_RANK = { measured: 0, derived: 1, extrapolated: 2, unknown: 3 };

/** The least trustworthy of two tiers, treating an absent tier as unknown. */
function worstTier(a, b) {
  const left = TIER_RANK[a] ?? TIER_RANK.unknown;
  const right = TIER_RANK[b] ?? TIER_RANK.unknown;
  return right > left ? (b ?? 'unknown') : (a ?? 'unknown');
}

function tokenCount(inputs) {
  return (inputs.input ?? 0) + (inputs.output ?? 0) + (inputs.cacheRead ?? 0) + (inputs.cacheWrite ?? 0);
}

/**
 * @param {object} options
 * @param {object} options.factors - parsed `factors.json`.
 * @param {Array<object>} options.sessions - folded sessions, each with `perModel` (`{carbon, cost}`) and `totals` from `summarise()`.
 * @param {object} options.infra - the resolved infrastructure row (`key`, `cif`, `pue`, `scale`).
 * @param {string} [options.generatedAt] - ISO timestamp for this response.
 * @param {number} [options.limit] - session rows retained after sorting (default 50).
 * @returns {object} the JSON payload served under `/dsh-carbon`.
 */
export function buildSummary({ factors, sessions, infra, generatedAt, limit = 50 }) {
  const scale = Number.isFinite(infra?.scale) && infra.scale > 0 ? infra.scale : 1;
  const models = new Map();
  const factorRows = new Map(factors.models.map((row) => [row.id, row]));
  if (factors.fallback !== undefined) factorRows.set(factors.fallback.id, factors.fallback);

  const totals = {
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
    unpriced: false,
    measured: 0,
    unmeasured: 0,
    sessions: 0,
    latestSessionGrams: null,
    latestSessionId: null,
  };

  const rows = sessions.map((session) => {
    const folded = session.totals;
    const grams = folded.grams * scale;
    const low = folded.low * scale;
    const high = folded.high * scale;

    totals.grams += grams;
    totals.low += low;
    totals.high += high;
    totals.tokens += folded.tokens;
    totals.input += folded.input;
    totals.output += folded.output;
    totals.cacheRead += folded.cacheRead;
    totals.cacheWrite += folded.cacheWrite;
    totals.calls += folded.calls;
    totals.cost += folded.cost ?? 0;
    if (folded.unpriced) totals.unpriced = true;
    if (folded.tier === 'measured') totals.measured += 1;
    else totals.unmeasured += 1;

    const modelRows = session.perModel.map((entry) => {
      const carbon = entry.carbon;
      const inputs = carbon.inputs ?? {};
      const modelGrams = carbon.grams * scale;
      const modelLow = carbon.low * scale;
      const modelHigh = carbon.high * scale;
      const tokens = tokenCount(inputs);

      let aggregate = models.get(carbon.factorId);
      if (aggregate === undefined) {
        aggregate = {
          factorId: carbon.factorId,
          tier: carbon.tier,
          grams: 0,
          low: 0,
          high: 0,
          tokens: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          calls: 0,
          aliases: new Set(),
          factor: factorRows.get(carbon.factorId) ?? factors.fallback,
        };
        models.set(carbon.factorId, aggregate);
      }
      aggregate.tier = worstTier(aggregate.tier, carbon.tier);
      aggregate.grams += modelGrams;
      aggregate.low += modelLow;
      aggregate.high += modelHigh;
      aggregate.tokens += tokens;
      aggregate.input += inputs.input ?? 0;
      aggregate.output += inputs.output ?? 0;
      aggregate.cacheRead += inputs.cacheRead ?? 0;
      aggregate.calls += inputs.calls ?? 0;
      aggregate.aliases.add(carbon.model);

      return {
        model: carbon.model,
        factorId: carbon.factorId,
        tier: carbon.tier,
        grams: modelGrams,
        low: modelLow,
        high: modelHigh,
        tokens,
        calls: inputs.calls ?? 0,
      };
    });

    return {
      id: session.id,
      cwd: session.cwd,
      firstUsageAt: session.firstUsageAt,
      lastUsageAt: session.lastUsageAt,
      turns: session.turns ?? 0,
      grams,
      low,
      high,
      tier: folded.tier ?? 'unknown',
      tokens: folded.tokens,
      input: folded.input,
      output: folded.output,
      cacheRead: folded.cacheRead,
      cacheWrite: folded.cacheWrite,
      calls: folded.calls,
      cost: folded.cost ?? 0,
      unpriced: folded.unpriced === true,
      models: modelRows,
    };
  });

  const latest = rows.reduce((best, session) => {
    const at = session.lastUsageAt ?? 0;
    return at > (best?.lastUsageAt ?? 0) ? session : best;
  }, null);

  const modelRows = [...models.values()]
    .sort((a, b) => b.grams - a.grams)
    .map((aggregate) => ({
      factorId: aggregate.factorId,
      tier: aggregate.tier,
      grams: aggregate.grams,
      low: aggregate.low,
      high: aggregate.high,
      share: totals.grams > 0 ? aggregate.grams / totals.grams : 0,
      tokens: aggregate.tokens,
      input: aggregate.input,
      output: aggregate.output,
      cacheRead: aggregate.cacheRead,
      calls: aggregate.calls,
      models: [...aggregate.aliases].sort(),
      factor: {
        input: aggregate.factor?.input ?? null,
        output: aggregate.factor?.output ?? null,
        lowMultiplier: aggregate.factor?.band?.low_multiplier ?? null,
        highMultiplier: aggregate.factor?.band?.high_multiplier ?? null,
      },
    }));

  totals.sessions = sessions.length;
  totals.latestSessionGrams = latest === null ? null : latest.grams;
  totals.latestSessionId = latest?.id ?? null;

  return {
    ok: true,
    generatedAt: generatedAt ?? new Date().toISOString(),
    methodologyVersion: factors._methodology_version,
    infrastructure: infra,
    totals,
    models: modelRows,
    equivalences: factors.equivalences?.world ?? [],
    sessions: rows
      .sort((a, b) => (b.firstUsageAt ?? 0) - (a.firstUsageAt ?? 0))
      .slice(0, Math.max(0, limit)),
  };
}

/** The full factor table, with the confidence vocabulary and the equivalence set. */
export function buildMethodology(factors, crossChecks = null) {
  return {
    ok: true,
    methodologyVersion: factors._methodology_version,
    cacheReadFactor: factors._cache_read_factor,
    infrastructure: factors._infrastructure,
    defaultInfrastructure: factors._default_infrastructure,
    models: factors.models,
    fallback: factors.fallback,
    pricing: factors.pricing,
    equivalences: factors.equivalences ?? null,
    crossChecks,
  };
}
