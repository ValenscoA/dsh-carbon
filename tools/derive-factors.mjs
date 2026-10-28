/**
 * Derives emission factors from the only public source that measures DeepSeek
 * inference energy, and writes lib/factors/factors.json.
 *
 * Source: Jegham et al. 2025, arXiv:2505.09598v6, Table 4 — per-query energy in
 * Wh (PUE included) for three prompt shapes: (100 in, 300 out), (1k, 1k) and
 * (10k, 1.5k).
 *
 * The derivation is deliberately mechanical and printed on every run, because
 * the whole point of the table is that a reader can audit how much of it is
 * measured and how much is assumed.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'lib', 'factors', 'factors.json');

const SHAPES = [
  { input: 100, output: 300 },
  { input: 1000, output: 1000 },
  { input: 10000, output: 1500 },
];

/** Per-query Wh, PUE included, from Jegham et al. v6 Table 4. */
const MEASURED_WH = {
  'deepseek-v3/china': [2.777, 8.864, 13.162],
  'deepseek-v3/azure': [0.742, 2.165, 3.696],
  'deepseek-r1/china': [19.251, 24.596, 29.078],
  'deepseek-r1/azure': [2.353, 4.331, 7.41],
};

const INFRA = {
  deepseek_own_china: { pue: 1.27, cif: 0.6 },
  microsoft_azure: { pue: 1.12, cif: 0.35 },
  aws: { pue: 1.14, cif: 0.287 },
};

/**
 * Non-negative least squares for `Wh = a*input + b*output`, no intercept.
 *
 * Plain least squares drives the input coefficient negative for the DeepSeek
 * rows: the three points are close to collinear, so the two terms trade off
 * almost freely. Constraining both to be non-negative is the honest reading —
 * it says "this data cannot separate prefill from decode" rather than inventing
 * a negative prefill cost.
 */
function nnls(shapes, wh) {
  let best = { sse: Infinity, a: 0, b: 0 };
  const STEPS = 20000;
  const HI = 5e-3;
  for (let i = 0; i <= STEPS; i += 1) {
    const a = (HI * i) / STEPS;
    let num = 0;
    let den = 0;
    for (let k = 0; k < shapes.length; k += 1) {
      num += shapes[k].output * (wh[k] - a * shapes[k].input);
      den += shapes[k].output ** 2;
    }
    const b = num / den;
    if (b < 0) continue;
    let sse = 0;
    for (let k = 0; k < shapes.length; k += 1) {
      sse += (a * shapes[k].input + b * shapes[k].output - wh[k]) ** 2;
    }
    if (sse < best.sse) best = { sse, a, b };
  }
  return best;
}

/** Wh/token -> gCO2e per million tokens. */
const toGPerMtok = (whPerToken, cif) => whPerToken * cif * 1e6;

/**
 * Mean absolute relative error of a fit against the points it was fitted to.
 *
 * Reported because a per-token model is a claim that energy is proportional to
 * token count. Where that claim fails — a large fixed per-query overhead — the
 * error is large and the caller deserves to see it rather than a bare number.
 */
function fitError(shapes, wh, fit) {
  let total = 0;
  for (let k = 0; k < shapes.length; k += 1) {
    const predicted = fit.a * shapes[k].input + fit.b * shapes[k].output;
    total += Math.abs(predicted - wh[k]) / wh[k];
  }
  return total / shapes.length;
}

const deepseekV3Active = 37e9;
const deepseekV41Active = (() => {
  const hidden = 5120;
  const moeIntermediate = 2304;
  const layers = 40;
  const routed = 384;
  const activeRouted = 6;
  const shared = 1;
  const heads = 64;
  const headDim = 512;
  const qLora = 1280;
  const oLora = 1024;
  const kvLora = 512;
  const ropeDim = 64;

  const perExpert = 3 * hidden * moeIntermediate;
  const mlp = (activeRouted + shared) * perExpert * layers;
  const attention =
    (hidden * qLora +
      qLora * heads * headDim +
      hidden * (kvLora + ropeDim) +
      kvLora * heads * headDim +
      heads * headDim * oLora +
      oLora * hidden) *
    layers;
  return { perExpert, mlp, attention, total: mlp + attention };
})();

const v41Ratio = deepseekV41Active.total / deepseekV3Active;

/** Ordinary least squares with no non-negativity constraint, quoted only to show why NNLS is needed. */
function ols(shapes, wh) {
  let s00 = 0, s01 = 0, s11 = 0, t0 = 0, t1 = 0;
  for (let k = 0; k < shapes.length; k += 1) {
    s00 += shapes[k].input ** 2;
    s01 += shapes[k].input * shapes[k].output;
    s11 += shapes[k].output ** 2;
    t0 += shapes[k].input * wh[k];
    t1 += shapes[k].output * wh[k];
  }
  const det = s00 * s11 - s01 * s01;
  return { a: (t0 * s11 - t1 * s01) / det, b: (s00 * t1 - s01 * t0) / det };
}

const fitV3ChinaRaw = ols(SHAPES, MEASURED_WH['deepseek-v3/china']);
const fitV3China = nnls(SHAPES, MEASURED_WH['deepseek-v3/china']);
const fitV3Azure = nnls(SHAPES, MEASURED_WH['deepseek-v3/azure']);
const fitR1China = nnls(SHAPES, MEASURED_WH['deepseek-r1/china']);
const fitR1Azure = nnls(SHAPES, MEASURED_WH['deepseek-r1/azure']);

const china = INFRA.deepseek_own_china.cif;
const azure = INFRA.microsoft_azure.cif;

/**
 * The measured rows fit input to ~zero, which is an artifact of collinearity,
 * not a claim that prefill is free. Azure fits the same model with a positive,
 * identifiable input term, so that term is carried across as the best available
 * statement about prefill cost and rescaled to the China grid.
 */
const v3Input = toGPerMtok(fitV3Azure.a, azure) * (china / azure);
const r1Input = toGPerMtok(fitR1Azure.a, azure) * (china / azure);

const v3Output = toGPerMtok(fitV3China.b, china);
const r1Output = toGPerMtok(fitR1China.b, china);

const v41Input = v3Input * v41Ratio;
const v41Output = v3Output * v41Ratio;

const round = (n) => Math.round(n * 100) / 100;
const roundInt = (n) => Math.round(n);

const fitQuality = {
  'deepseek-v3': {
    mape: round(fitError(SHAPES, MEASURED_WH['deepseek-v3/china'], fitV3China)),
    note: 'A per-token model fits V3 well: the three published points lie close to a line through the origin.',
  },
  'deepseek-r1': {
    mape: round(fitError(SHAPES, MEASURED_WH['deepseek-r1/china'], fitR1China)),
    note:
      'Poor fit. R1 costs ~19 Wh even for the smallest prompt, so most of its energy is fixed per query ' +
      '(reasoning traces, long prefill, scheduling), not proportional to tokens. A token-only model therefore ' +
      'under-reports short R1 sessions and over-reports long ones. Reported as an error, not corrected here.',
  },
};

const v41 = {
  input: roundInt(v41Input),
  output: roundInt(v41Output),
};

const models = [
  {
    id: 'deepseek-v4.1-flash',
    match: ['v4.1-flash', 'deepseek-flash', 'v4-flash', 'flash-vision-exp'],
    tier: 'derived',
    input: v41.input,
    output: v41.output,
    band: { low_multiplier: 0.5, high_multiplier: 3.0 },
    source:
      'Derived, not measured. Scaled from DeepSeek-V3 on DeepSeek\u2019s own fleet (Jegham et al. v6 Table 4) by active-parameter ratio.',
    derivation:
      `Active parameters from the released config.json: ${round(deepseekV41Active.mlp / 1e9)}B routed+shared MLP + ` +
      `${round(deepseekV41Active.attention / 1e9)} attention = ${round(deepseekV41Active.total / 1e9)}B, ` +
      `against V3\u2019s ${deepseekV3Active / 1e9}B -> ${round(v41Ratio * 100) / 100}x. ` +
      `Both prefill FLOPs and decode bytes scale with active parameters, so both terms scale together.`,
    caveat:
      'No published measurement exists for this model. fp4 expert weights cut bytes read per decode step below the parameter ratio, which argues the point estimate is high; worse batching or a denser serving stack argues it is low. The band covers that.',
  },
  {
    id: 'deepseek-v4-pro',
    match: ['v4-pro'],
    tier: 'extrapolated',
    input: v41.input,
    output: v41.output,
    band: { low_multiplier: 0.5, high_multiplier: 6.0 },
    source:
      'No measurement and no released config. Carried at the Flash point estimate with a much wider band, on the assumption that a Pro tier is the larger sibling on the same fleet.',
    caveat:
      'The weakest row in the table: the multiplier is judgement, not arithmetic. DeepSeek has not published V4-Pro\u2019s architecture, so nothing here is checkable.',
  },
  {
    id: 'deepseek-v3',
    match: ['deepseek-v3', 'deepseek-chat', 'v3.1', 'v3.2'],
    tier: 'measured',
    fit: fitQuality['deepseek-v3'],
    input: roundInt(v3Input),
    output: roundInt(v3Output),
    band: {
      low_multiplier: round(v3Output ? toGPerMtok(fitV3Azure.b, azure) / v3Output : 1),
      high_multiplier: round((r1Output * china) / china / v3Output),
    },
    source:
      'Jegham et al. 2025 (arXiv:2505.09598v6) Table 4: DeepSeek-V3 on DeepSeek\u2019s own datacenters, ' +
      `${MEASURED_WH['deepseek-v3/china'].join(' / ')} Wh for the three published prompt shapes. ` +
      `Non-negative least squares at CIF ${china} kgCO2e/kWh, PUE ${INFRA.deepseek_own_china.pue}.`,
    caveat:
      'The three points are near-collinear, so the fit cannot separate the two terms: unconstrained least squares drives the input ' +
      `coefficient to ${(fitV3ChinaRaw.a * 1e6).toFixed(2)}e-6 Wh/token, which is negative and physically meaningless. ` +
      'Output therefore carries essentially all the signal. The input figure here is borrowed from the Azure fit, where it is positive ' +
      'and identifiable, and rescaled to this grid — it is not measured on this fleet. ' +
      'V3.1 and V3.2 match as family aliases; neither checkpoint was measured.',
  },
  {
    id: 'deepseek-r1',
    match: ['deepseek-r1', 'deepseek-reasoner', 'r1-0528'],
    tier: 'measured',
    fit: fitQuality['deepseek-r1'],
    input: roundInt(r1Input),
    output: roundInt(r1Output),
    band: {
      low_multiplier: round(r1Output ? toGPerMtok(fitR1Azure.b, azure) / r1Output : 1),
      high_multiplier: 1,
    },
    source:
      'Jegham et al. 2025 (arXiv:2505.09598v6) Table 4: DeepSeek-R1 on DeepSeek\u2019s own datacenters, ' +
      `${MEASURED_WH['deepseek-r1/china'].join(' / ')} Wh for the three published prompt shapes.`,
    caveat:
      'Same collinearity as V3: the output term absorbs nearly all the fit. R1 is the most energy-intensive DeepSeek row published, which is why it sets the top of the V3 band.',
  },
];

const fallback = {
  id: 'unknown',
  tier: 'unknown',
  input: v41.input,
  output: v41.output,
  band: { low_multiplier: 0.5, high_multiplier: 6.0 },
  source:
    'No factor entry matched this model string. The V4.1-Flash point estimate is used so the total is not silently zeroed, and the model is flagged in output.',
  caveat: 'An unmatched model means the report is a guess. Add a row here.',
};

const doc = {
  $comment: [
    'GENERATED by tools/derive-factors.mjs - edit that script, not this file.',
    '',
    'Emission factors for DeepSeek Harness sessions, in gCO2e per million tokens.',
    'Every entry carries a confidence tier. The only public source of per-query DeepSeek',
    'inference energy is Jegham et al. 2025 (arXiv:2505.09598v6) Table 4, which measures',
    'DeepSeek-V3 and DeepSeek-R1 on DeepSeek\u2019s own Chinese datacenters and on Azure.',
    'It covers no V3.1/V3.2/V4/Pro/Flash checkpoint, and EcoLogits carries no DeepSeek model',
    'at all - so unlike claude-carbon\u2019s Opus/Haiku rows there is no second opinion to',
    'bracket the extrapolations against.',
  ],
  _units: 'gCO2e per million tokens',
  _methodology_version: 1,
  _cache_read_factor: {
    value: 0.08,
    note:
      'Energy of a cache-read token as a fraction of an uncached input token: a prefill residual. ' +
      'DeepSeek\u2019s 0.02 cache-hit PRICE ratio is not an energy ratio and is deliberately not used.',
  },
  _infrastructure: {
    note:
      'Deployment dominates. Jegham et al. measured the same DeepSeek-V3 at 13.162 Wh on DeepSeek\u2019s own DCs ' +
      'and 3.696 Wh on Azure - a 3.6x gap from PUE, cooling and grid carbon intensity alone.',
    ...INFRA,
  },
  _default_infrastructure: 'deepseek_own_china',
  _default_infrastructure_rationale:
    'DeepSeek Harness runs on DeepSeek\u2019s first-party API, so the operator\u2019s own fleet is the closer assumption. ' +
    'It is also the pessimistic one: roughly 3.6x the Azure reading for identical tokens. Override with DSH_CARBON_INFRA=azure.',
  _derivation_values: {
    'v3_china_fit_wh_per_token': { input: fitV3China.a, output: fitV3China.b, sse: fitV3China.sse },
    'v3_azure_fit_wh_per_token': { input: fitV3Azure.a, output: fitV3Azure.b, sse: fitV3Azure.sse },
    'r1_china_fit_wh_per_token': { input: fitR1China.a, output: fitR1China.b, sse: fitR1China.sse },
    'r1_azure_fit_wh_per_token': { input: fitR1Azure.a, output: fitR1Azure.b, sse: fitR1Azure.sse },
    'v4_1_flash_active_params': {
      mlp: Math.round(deepseekV41Active.mlp),
      attention: Math.round(deepseekV41Active.attention),
      total: Math.round(deepseekV41Active.total),
      per_expert: Math.round(deepseekV41Active.perExpert),
    },
    'v3_active_params': deepseekV3Active,
    'v41_to_v3_active_ratio': round(v41Ratio),
  },
  models,
  fallback,
  $pricing_note:
    'API-equivalent cost uses DeepSeek list prices, USD per 1M tokens, at the PEAK tariff. ' +
    'Peak is 01:00-04:00 and 06:00-10:00 UTC Mon-Fri excluding Chinese public holidays, and is exactly 2x off-peak. ' +
    'A historical report cannot know which tariff applied, so it prices high and says so. ' +
    'Only models DeepSeek currently lists are priced; retired checkpoints carry null and are reported as unpriced rather than guessed.',
  pricing: {
    peak_hours_utc: [[1, 4], [6, 10]],
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    models: {
      'deepseek-v4.1-flash': { cache_hit: 0.006, cache_miss: 0.3, output: 1.2 },
      'deepseek-v4-pro': { cache_hit: 0.044, cache_miss: 1.32, output: 3.96 },
    },
  },
  equivalences: {
    us: [
      { id: 'car', divisor: 393, unit: 'miles', decimals: 1, label: 'miles driven by car', source: '393 gCO2e/mile, EPA US average' },
      { id: 'phone', divisor: 0.2, unit: '', decimals: 0, label: 'smartphone charges', source: '0.2 gCO2e per charge' },
      { id: 'kettle', divisor: 30, unit: '', decimals: 1, label: 'kettle boils', source: '30 gCO2e per 1L boil, US average grid' },
    ],
    world: [
      { id: 'car', divisor: 170, unit: 'km', decimals: 1, label: 'km driven by car', source: '170 gCO2e/km, global average passenger car' },
      { id: 'phone', divisor: 0.2, unit: '', decimals: 0, label: 'smartphone charges', source: '0.2 gCO2e per charge' },
      { id: 'kettle', divisor: 24, unit: '', decimals: 1, label: 'kettle boils', source: '24 gCO2e per 1L boil, world average grid' },
    ],
  },
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

console.log('fits (Wh/token), SSE against the three published points:');
for (const [name, fit] of Object.entries({
  'v3 china': fitV3China,
  'v3 azure': fitV3Azure,
  'r1 china': fitR1China,
  'r1 azure': fitR1Azure,
})) {
  console.log(`  ${name.padEnd(9)} input ${fit.a.toExponential(3)}  output ${fit.b.toExponential(3)}  sse ${fit.sse.toFixed(4)}`);
}
console.log('\nfit quality (mean absolute relative error vs published points):');
for (const [id, q] of Object.entries(fitQuality)) console.log(`  ${id.padEnd(12)} ${(q.mape * 100).toFixed(1)}%`);
console.log(`\nV4.1-Flash active params: ${(deepseekV41Active.total / 1e9).toFixed(2)}B (ratio ${v41Ratio.toFixed(3)}x of V3)`);
console.log(`\nfactors at CIF ${china} (DeepSeek own, China):`);
console.log(`  v3          input ${Math.round(v3Input)}  output ${Math.round(v3Output)} gCO2e/Mtok`);
console.log(`  r1          input ${Math.round(r1Input)}  output ${Math.round(r1Output)} gCO2e/Mtok`);
console.log(`  v4.1-flash  input ${v41.input}  output ${v41.output} gCO2e/Mtok`);
console.log(`\nwrote ${OUT}`);
