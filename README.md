# dsh-carbon

<p>
  <a href="https://www.npmjs.com/package/dsh-carbon"><img src="https://img.shields.io/npm/v/dsh-carbon" alt="npm version"></a>
  <a href="https://github.com/ValenscoA/dsh-carbon/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/tests-65-brightgreen" alt="65 tests">
</p>

Track the estimated carbon footprint of your [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) sessions, in the terminal and in the web GUI.

It is a port of the idea behind [claude-carbon](https://github.com/gwittebolle/claude-carbon) — a local, token-based CO2e estimate with a sourced methodology — to DeepSeek. It is **not** a port of its numbers, because the evidence base for DeepSeek is much thinner, and pretending otherwise would be the whole problem.

<p align="center"><img src="https://raw.githubusercontent.com/ValenscoA/dsh-carbon/main/docs/panel.png" width="720" alt="The Carbon panel: a whale coloured by the footprint, the estimate with its plausible range, stripes per day coloured against the median day, and two bars showing share of tokens against share of CO2"></p>

```
  dsh-carbon — carbon footprint of your DeepSeek Harness sessions
  ──────────────────────────────────────────────────────────────

  Estimated       238.7 g
  Plausible range 119.4 g – 716.1 g

  8,384,774 tokens over 126 model calls, 4 sessions
  input 214,769 · output 113,045 · cache reads 8,056,960 (96% of tokens)
  API-equivalent cost at peak tariff: $0.2484

  ≈ 1.4 km driven by car
  ≈ 9.9 kettle boils

  Per session
  ◐ 2026-10-28 03:14     66.7 g  ████████           deepseek-v4.1-flash
  ◐ 2026-10-28 03:02    143.0 g  ██████████████████ deepseek-v4.1-flash
  ◐ 2026-10-28 02:48     11.7 g  █                  deepseek-v4.1-flash

  Where it comes from
  ◐ deepseek-v4.1-flash    238.7 g  100%  derived

  Confidence
  4 of 4 sessions ran on a model with NO published energy measurement.
```

## The web GUI

The plugin ships a browser half alongside the host routes: a **Carbon** row in the sidebar and a page it opens in the main panel.

- **The whale.** A pixel whale whose colour *is* the reading — the same green → yellow → red ramp as the hero, on the same log scale (green to 250 g, red from 5 kg). It breathes, blinks, and its fluke beats faster as the figure gets redder. It is drawn from one character map in `lib/core/whale.mjs`, shared with the exported card, so the whale on your card is the whale you saw.
- **Estimated total with its band** — the point estimate is never shown without the low/high reading, and a marker places it inside that range.
- **Stripes** — one column per day, week or month, coloured against the *median* period (green at an eighth of it, red at eight times), the same idea as Ed Hawkins' warming stripes but drawn from your own sessions. Hovering or tabbing to a stripe names its date, total and session count.
- **A time window** — 7 days, 30, 90, 12 months or all time, remembered per browser. The hero shows the change against the previous window of the same length when there is an honest one to compare.
- **Two bars over the same four kinds of token** — how many there were, and what they cost. Almost every token in a session is a cache read and roughly a tenth of the grams; output is half a percent of the tokens and nine tenths of the footprint. A single bar hides that.
- **Equivalent scale** — km driven, kettle boils and smartphone charges, from the same world-average factors the CLI uses.
- **Fleet switch** — DeepSeek's own fleet or Azure, applied consistently to every number on the page (totals, sessions, models, stripes and equivalences). The choice is remembered per browser.
- **Export** — *Download card* renders a 1200×630 card as a PNG in the browser (canvas, no native dependency, falling back to the SVG); *Copy badge* puts a shields.io markdown line on the clipboard. See [Sharing](#sharing).
- **Method tab** — the formula, the deployment assumptions, every factor row with its tier and band, each row's caveat and source, and the external cross-checks below. The same caveats the CLI prints.
- **Live** — refreshes every 30 seconds while the page is visible, on window focus, and on demand. The explicit refresh button bypasses the host's 5-second cache.
- **English and Chinese**, following the host locale, with the panel laid out for narrow main columns.

> **One restart for the first install.** The host caches whether a package has a `dsh.client` half for the lifetime of the process, so adding the browser half to an already-running harness needs one restart (or app relaunch) before **Carbon** appears in the sidebar, and again after the browser half's *declaration* changes. Rebuilding the bundle alone hot-reloads; a host-side change takes effect on the next recomposition.

## Install

**As a plugin** — the GUI is this half; the CLI comes with it.

```bash
dsh plugin --profile desktop add dsh-carbon
```

That forwards to `pnpm add` inside the profile *and* appends the package to `dsh.profile.bundles`, so the only manual step left is restarting the harness once, which is when the browser half is discovered. If `dsh` is not on your `PATH`, it ships inside the app:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-carbon
```

Without npm, the same tarball is attached to every [release](https://github.com/ValenscoA/dsh-carbon/releases) — `dsh plugin --profile desktop add <tarball URL>` accepts it too. By hand it is `pnpm add dsh-carbon` in the profile directory plus a `"dsh-carbon"` entry in `dsh.profile.bundles`.

**The CLI alone**, on Node 22.15 or newer:

```bash
npx dsh-carbon report
```

From a clone instead: `node bin/dsh-carbon.mjs report`.

## Commands

| Command | What it does |
|---|---|
| `dsh-carbon` | The report: totals, band, per-session and per-model, split by kind of token |
| `dsh-carbon timeline` | The stripes row in blocks, totals, the median period and the four kind shares |
| `dsh-carbon sync` | Bring the store up to date with the session logs |
| `dsh-carbon recompute` | Reprice every stored session from its token counts |
| `dsh-carbon card` | Write the shareable SVG card (`--out`, `--stdout`) |
| `dsh-carbon badge` | Print a shields.io badge for a README (`--svg`) |
| `dsh-carbon pr` | The repository's footprint since the branch point, posted to its pull request (`--dry-run`, `--pr N`) |
| `dsh-carbon sessions` | One line per session |
| `dsh-carbon json` | Machine-readable output |
| `dsh-carbon methodology` | Every factor, its source, its band and its caveats |

Every reading takes `--range 7d|30d|90d|12mo|all`, `--since YYYY-MM-DD`, `--until YYYY-MM-DD` and `--infra china|azure|aws`. `report` also takes `--limit N`.

Environment: `DSH_CARBON_INFRA=azure` for the alternative-fleet reading, `DSH_HOME` to point at another harness home, `DSH_CARBON_HISTORY` to move the store.

## The store

Sessions are kept in `~/.dsh/carbon/history.jsonl`, one line per session, and the window, the stripes, the median and the delta are all derived from it.

Two decisions worth stating, because they are not the obvious ones:

**Rows store tokens, never grams.** The conversion happens on every read, from the factors in force at that moment. When a factor is corrected the whole history re-prices, with no migration step and no stale rows — `recompute` exists to show that total, not to rewrite anything. What is stored is what was measured (how many tokens of each kind crossed the wire); what is derived stays derived.

**JSONL, not SQLite.** The file has to be readable and diffable by a person. This tool's claim is that you can check its arithmetic, and a database you need a shell to open works against that. A few thousand rows is a few hundred kilobytes, far below the point where the format matters.

Sync is incremental: each row remembers the size and mtime of the log it came from, so an unchanged log is stat'd rather than parsed, and only a live session that has grown is read again. A session whose transcript the harness has pruned keeps its row — that is the entire point — and the page reports how many of the total come from logs it can no longer verify.

## Sharing

<p align="center"><img src="https://raw.githubusercontent.com/ValenscoA/dsh-carbon/main/docs/card.png" width="640" alt="The exported card: the estimate with its band, a whale coloured by it, stripes per day, and the sentence estimate, not a measurement"></p>

`card.svg` is a 1200×630 card: the figure, its band, the fleet the factors assume, the stripes and the kind split, signed with the sentence it should be signed with — *estimate, not a measurement*. It is rendered on the host as SVG, so there is no browser, native module or network call on the export path; the page rasterises it in your own browser when you ask for a PNG. `card --out` and `badge --svg` write the same artefacts from the CLI.

`badge` prints a static shields.io markdown line whose message is the figure and the month it was taken. Static on purpose: a *live* badge would publish your footprint to a third party on every view of your README.

`pr` sums the stored sessions whose working directory sits inside the current repository, from the point the branch left the default branch, and posts one sticky comment through your own `gh` auth. It is weaker than `claude-carbon`'s attribution and says so: a branch is not recorded in a harness session log, so this is a repository-and-time attribution, not a per-branch one — it includes any session that ran in the same repository in that window, and excludes work done before the branch point. `--dry-run` prints the comment and posts nothing.

## The honest part

`claude-carbon` can lean on measured per-token energy for the model family it tracks. This cannot, and the difference is worth stating plainly.

**What is measured.** Jegham et al. 2025 ([arXiv:2505.09598v6](https://arxiv.org/abs/2505.09598)), Table 4, is the only public source of per-query inference energy covering DeepSeek. It measures **DeepSeek-V3** and **DeepSeek-R1** on both DeepSeek's own Chinese datacenters and on Azure, at three prompt shapes.

**What is not.** It covers no V3.1, V3.2, V4, V4-Pro or Flash checkpoint. [EcoLogits](https://ecologits.ai) carries no DeepSeek model at all, so unlike `claude-carbon`'s Opus/Haiku rows there is no second **measurement** to bracket the extrapolations against. A Tier-3 cross-check is shown on the Method tab, but it is an estimate, not a bracket. The model this harness actually runs by default, **deepseek-v4.1-flash**, has **no published energy measurement whatsoever**.

**So the table is graded.** Every row carries a tier, and both the report and the GUI show the tier of whatever they used:

| Model | Tier | Why |
|---|---|---|
| `deepseek-v3` | **measured** | Fitted to the published per-query energies. Mean error 2.0%. |
| `deepseek-r1` | **measured** | Same source, but the fit is poor: mean error 30% (see below). |
| `deepseek-v4.1-flash` | **derived** | Scaled from V3 by active-parameter ratio, from the released `config.json`. |
| `deepseek-v4-pro` | **extrapolated** | No measurement and no released config. Widest band. |

### Deriving V4.1-Flash

V4.1-Flash has open weights, so its architecture is at least checkable. From the released config: 40 layers, 384 routed experts of intermediate width 2304, 6 active per token, 1 shared expert, plus MLA attention — about **14.2B active parameters** against V3's ~37B.

Both prefill FLOPs and decode bytes scale with active parameters, so both factors scale by the same ratio:

```
V4.1-Flash factor = V3 factor x (14.2B / 37B) = 0.38x
  input  28 g/Mtok -> 11 g/Mtok
  output 5289 g/Mtok -> 2028 g/Mtok
```

That is arithmetic from a released config, but the *assumption* — that energy per active byte is the same on DeepSeek's V4 serving stack as on V3's — is not verified. Hence the 0.5x–3.0x band, and hence `derived` rather than `measured`.

### Why R1's factor is worse than V3's

Fitting `energy = a*input + b*output` to the three published R1 points gives a 30% mean error, against 2.0% for V3. The reason is diagnostic, not cosmetic: R1 costs ~19 Wh even for a 100/300-token prompt. Most of its energy is **fixed per query** — long reasoning traces, prefill, scheduling — not proportional to tokens. A token-only model therefore under-reports short R1 sessions and over-reports long ones.

`dsh-carbon` reports that error rather than hiding it. A per-query intercept term would fit better but would need a "how many requests" denominator the log does not cleanly provide, so the limitation is documented instead of papered over.

### Why the input factor is the weak one

The three published points are close to collinear, so the input and output terms trade off almost freely. Unconstrained least squares puts the input coefficient **slightly negative** for the DeepSeek rows — obviously wrong, and a sign that the data cannot separate prefill from decode. The derivation script therefore uses non-negative least squares and carries the input term across from the Azure fit, where it is positive and identifiable, rescaled to the China grid. It is a borrowed number, labelled as such.

### Deployment dominates

Jegham et al. measured the *same* DeepSeek-V3 at **13.162 Wh** on DeepSeek's own Chinese datacenters and **3.696 Wh** on Azure. A 3.6x gap from PUE, cooling and grid carbon intensity alone — larger than the gap between most model families.

So the fleet assumption matters more than the model. The default is DeepSeek's own fleet, because DeepSeek Harness runs on DeepSeek's first-party API, and it is also the pessimistic reading. `DSH_CARBON_INFRA=azure` shows the optimistic one, and the GUI's fleet switch does the same for a single page without an environment change.

### Cross-checks

A second number is useful only if its limits travel with it. [Know Your Compute](https://www.knowyourcompute.com/models/deepseek-v4-flash) (July 2026) is a transparent Tier-3 calculator: for models without disclosures it estimates per-query energy from GPU power, model size and benchmark latency. Its DeepSeek-V4-Flash page gives **1.0 Wh and 0.53 g CO₂e per query** on a 525 gCO₂/kWh China grid.

That is a **sibling estimate, not a measurement of V4.1-Flash**, and the site does not publish the prompt shape behind the number. Read against the paper's shapes:

- at 100 input / 300 output, this tool's V4.1-Flash factor implies **1.02 Wh** (0.53 g at 525 g/kWh) — essentially the site's figure;
- at 1,000 / 1,000 it implies **3.4 Wh**, so the agreement is shape-dependent.

Its V4-Pro figure (6.0 Wh) is six times its V4-Flash figure and sits at the top of this tool's 0.5–6× band: evidence the point estimate may be low, not evidence that it is wrong. Its V3 page is a cautionary example instead: it says 2.0 Wh for a medium prompt, while the paper's China points are 2.777 / 8.864 / 13.162 Wh, and 2.0 Wh is close to the **Azure** medium point (2.165 Wh) paired with the China grid. That row is shown as `not used`.

The GUI's Method tab lists all three with their URLs and verdicts. None of them enters the arithmetic, and none changes a factor: a Tier-3 estimate cannot narrow a band that exists because the physics is unmeasured.

## How it works

```
grams = ((input + cacheWrite) * inputFactor
       + cacheRead * inputFactor * 0.08
       + output * outputFactor) / 1e6
```

Cache reads are a prefill residual at 8% of the input factor. DeepSeek's 0.02 cache-hit *price* ratio is not an energy ratio and is deliberately not used.

Token counts come from the session logs under `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`, reading `data.usage` on `assistant/message` events, attributed per message to `data.message.source.model` so a mid-session model switch is priced correctly. `inputTokens` already excludes cached tokens. A `sync` folds those logs into the store (see [The store](#the-store)); every reading is priced from the store, not from the logs, so a pruned transcript no longer loses its footprint.

Assistant messages are deduplicated by `message.id`. A resumed or compacted session can replay messages that are already in the log, and counting a replay twice inflates the token sum with no symptom other than a larger footprint. `claude-carbon` found roughly 3× inflation from this; across the logs read here no session had a repeat, so the count of ignored replays is reported rather than silently absorbed.

**One implementation detail worth knowing.** The harness *appends* to these logs, one zstd frame per flush — a live log had 168 frames. Node's `zstdDecompressSync` decodes only the first frame and silently returns a truncated log. This walks every frame, validating each candidate boundary by attempting the decode, and drops a half-written trailing frame (which Node decodes to a partial line rather than throwing). Without that, history would be silently under-reported by an order of magnitude.

## HTTP routes

The host plugin registers read-only routes, loopback-only and same-origin fenced. The GUI is a client of the same routes, so anything the page shows is available to a script.

| Route | Returns |
|---|---|
| `GET /dsh-carbon` | The window: totals, buckets, kind split, models, sessions |
| `GET /dsh-carbon/summary` | Same |
| `GET /dsh-carbon/timeline` | The same payload without the model and session rows |
| `GET /dsh-carbon/sessions` | Session rows only |
| `GET /dsh-carbon/methodology` | The full factor table with tiers, sources, equivalences and cross-checks |
| `GET /dsh-carbon/card.svg` | The shareable card (`?download=1` sets a filename) |
| `GET /dsh-carbon/badge.svg` | A shields-style badge of the all-time total |

All of them accept `?range=7d|30d|90d|12mo|all`, `?since=`, `?until=`, `?infra=azure|china|aws`, and `?fresh=1` to bypass the 5-second read cache. `/summary` and `/sessions` also take `?limit=N` (1–200 session rows, default 50). The payload carries `totals` (tokens by direction, calls, cost, measured/unmeasured), `buckets` (one per period, with its colour and load), `kinds` (tokens and grams per kind, with both shares), a `models` roll-up keyed by factor row, the world-average `equivalences`, and the session rows. Every gram figure is on the selected fleet, scaled exactly once.

## Development

```bash
npm test                 # 65 tests: factors, folding, store, windows, exports, client bundle
npm run build:client     # rebuild lib/client.js from src/client/
```

`lib/client.js` is committed and is the artifact the harness serves; edit `src/client/` and rebuild rather than touching it. The bundle is built with esbuild, keeps React external against the shell's shared module table, and registers `dsh-carbon` on `window.__ModuleLoader__` in the format the client module system expects. The test suite loads that built bundle through a stubbed loader and renders the page with `react-dom/server`, so a broken bundle fails `npm test` rather than a user's sidebar.

## Tests

```bash
npm test                 # 65 tests; `npm install` first for the 9 browser tests
node --test test/*.test.mjs
```

65 tests, including one that regenerates `lib/factors/factors.json` from `tools/derive-factors.mjs` and fails if the two have drifted — so the published numbers cannot silently diverge from their stated derivation. The report tests cover fleet scaling, the session-row cap, model roll-up and empty history; the client tests cover registration, both locales, the rendered rows, the method table, the heat scale's thresholds and hue direction, and the cross-check card. The store tests prove the two properties the design rests on — a session survives the deletion of its log, and an unchanged log is not parsed again — and the export tests pin the invariant that matters most: the buckets and the four kinds each sum to the window total, on every fleet.

## Publishing

Nothing in this package is tied to the author's machine: no absolute paths, no hard-coded home directory, no network call on any read path. The store is per-user at `~/.dsh/carbon/history.jsonl` (override with `DSH_CARBON_HISTORY`), and the plugin writes nothing else.

A plain `git clone && node --test test/*.test.mjs` runs the arithmetic without installing anything: the nine browser tests skip themselves with a note, because React is a devDependency and the shipped bundle never contains it.

A `npm pack` tarball installs cleanly into an empty project and produces a report against any `DSH_HOME`; the core test files also run from the installed package.

It ships by two routes, and they carry the same bytes: the npm package `dsh-carbon`, and a `.tgz` attached to each GitHub release for anyone who would rather not depend on the registry. `homepage` and `repository` are set, because the badge markdown and the page's *Copy badge* button link there.

Releasing a new version:

```bash
npm test                 # `prepublishOnly` runs it anyway
npm version patch        # or minor / major; commits and tags
git push --follow-tags
npm publish              # needs a granular token with "bypass 2FA"
gh release create v$(node -p "require('./package.json').version") \
  ./dsh-carbon-$(node -p "require('./package.json').version").tgz
```

The community registry at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) indexes GitHub repositories rather than receiving submissions, and lists a one-line `install` command per entry (`dsh plugin --profile web add <package>`); 3,823 of its 7,406 entries are npm packages. There was no carbon-footprint plugin in it when this was written.

## Limits

- **V4.1-Flash and V4-Pro figures are not measurements.** Treat them as an order of magnitude.
- **The store is only as old as its first sync.** Sessions the harness pruned before you installed this are gone; nothing can rebuild them. From the first sync on, history survives pruning.
- **The band is judgement, not a confidence interval.** It has no statistical basis; it is the range the author would defend.
- **Costs use the peak tariff**, because a historical report cannot know which tariff applied. Off-peak is exactly half. The GUI's cost stat does not change with the fleet switch: it is API pricing, not electricity.
- **No per-request tracing.** One number per model per direction, like `claude-carbon`.
- **Cross-checks are estimates, not factors.** Know Your Compute's numbers are shown on the Method tab for comparison; they never enter the arithmetic. Its V3 row is explicitly rejected because it mixes an Azure energy reading with the China grid.
- **The GUI and the routes are read-only.** They read the store and never write to the profile; the only thing the plugin writes is its own `history.jsonl`.

## Licence

MIT. Factor values are derived from published research; see `lib/factors/factors.json` for per-row citations.
