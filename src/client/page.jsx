/**
 * The carbon page.
 *
 * One container owns the network state; the views are pure so they can be
 * rendered with a fixture (the test does exactly that). Data refreshes on
 * mount, every 30s while the page is visible, and when the window regains
 * focus. Fleet changes are persisted in localStorage because the choice is a
 * reading preference, not a session fact.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cardToPng, copyText, download, fetchCard, fetchMethodology, fetchSummary } from './api.js';
import {
  clockLabel,
  compact,
  exact,
  factorNumber,
  formatGrams,
  gramsText,
  multiplier,
  percent,
  timeLabel,
  usd,
} from './format.js';
import { CarIcon, ChevronIcon, InfoIcon, KettleIcon, LeafIcon, PhoneIcon, RefreshIcon } from './icons.jsx';
import { Whale } from './whale.jsx';
import { GREEN_AT, RED_AT, heatTone } from './heat.js';
import { badgeMarkdown } from '../../lib/core/badge.mjs';

const INFRA_KEY = 'dsh-carbon:infra';
const RANGE_KEY = 'dsh-carbon:range';
const REFRESH_MS = 30_000;
const SESSION_ROWS = 8;
const RANGES = ['7d', '30d', '90d', '12mo', 'all'];

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readInfra() {
  try {
    const saved = globalThis.localStorage?.getItem(INFRA_KEY);
    if (saved === 'azure') return 'azure';
  } catch {
    // A blocked storage read is not a reason to fail the page.
  }
  return 'china';
}

function rememberInfra(value) {
  try {
    globalThis.localStorage?.setItem(INFRA_KEY, value);
  } catch {
    // Persistence is a nicety; the page still works for this view.
  }
}

/** The window is a reading preference too, and it survives a panel re-mount. */
function readRange() {
  try {
    const saved = globalThis.localStorage?.getItem(RANGE_KEY);
    if (RANGES.includes(saved)) return saved;
  } catch {
    // Fall through to the default.
  }
  return '30d';
}

function rememberRange(value) {
  try {
    globalThis.localStorage?.setItem(RANGE_KEY, value);
  } catch {
    // See above.
  }
}

function shortId(id) {
  const text = String(id ?? '');
  return text.startsWith('session-') ? text.slice('session-'.length, 'session-'.length + 8) : text.slice(0, 8);
}

function basename(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

function useActiveLocale(localeService) {
  const subscribe = useCallback(
    (callback) => {
      if (localeService === undefined || localeService === null) return () => {};
      if (typeof localeService.subscribe === 'function') return localeService.subscribe(callback);
      return () => {};
    },
    [localeService],
  );
  const snapshot = useCallback(
    () => localeService?.getSnapshot?.()?.active ?? 'en',
    [localeService],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function useSummary(infra, range) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null, fetchedAt: 0 });
  const sequence = useRef(0);

  const load = useCallback(async ({ quiet = false, fresh = false } = {}) => {
    const id = ++sequence.current;
    setState((previous) => ({
      ...previous,
      status: previous.data === null ? (quiet ? previous.status : 'loading') : 'refreshing',
      error: null,
    }));
    try {
      const data = await fetchSummary({ infra, range, fresh });
      if (sequence.current !== id) return;
      setState({ status: 'ready', data, error: null, fetchedAt: Date.now() });
    } catch (error) {
      if (sequence.current !== id) return;
      setState((previous) => ({
        ...previous,
        status: previous.data === null ? 'error' : 'ready',
        error: messageOf(error),
      }));
    }
  }, [infra, range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const tick = () => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      load({ quiet: true });
    };
    const timer = globalThis.setInterval(tick, REFRESH_MS);
    const onFocus = () => {
      if (globalThis.document?.visibilityState !== 'hidden') load({ quiet: true });
    };
    globalThis.document?.addEventListener('visibilitychange', onFocus);
    globalThis.addEventListener?.('focus', onFocus);
    return () => {
      globalThis.clearInterval(timer);
      globalThis.document?.removeEventListener('visibilitychange', onFocus);
      globalThis.removeEventListener?.('focus', onFocus);
    };
  }, [load]);

  return { ...state, refresh: () => load({ fresh: true }) };
}

function useMethodology(active) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  const load = useCallback(async () => {
    setState({ status: 'loading', data: null, error: null });
    try {
      const data = await fetchMethodology();
      setState({ status: 'ready', data, error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error: messageOf(error) });
    }
  }, []);

  useEffect(() => {
    if (!active || state.status !== 'idle') return;
    load();
  }, [active, state.status, load]);

  return { ...state, retry: load };
}

export function CarbonPage({ t, localeService }) {
  const locale = useActiveLocale(localeService);
  const [infra, setInfra] = useState(readInfra);
  const [range, setRange] = useState(readRange);
  const [tab, setTab] = useState('overview');
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState(null);
  const [exporting, setExporting] = useState(null);
  const summary = useSummary(infra, range);
  const method = useMethodology(tab === 'method');

  const chooseInfra = (next) => {
    if (next === infra) return;
    rememberInfra(next);
    setInfra(next);
  };

  const chooseRange = (next) => {
    if (next === range) return;
    rememberRange(next);
    setRange(next);
  };

  // The flash is a short confirmation, not state the page owns: it clears
  // itself so a stale "copied" cannot sit on screen for the next visit.
  useEffect(() => {
    if (flash === null) return undefined;
    const timer = globalThis.setTimeout(() => setFlash(null), 4000);
    return () => globalThis.clearTimeout(timer);
  }, [flash]);

  const data = summary.data;

  const exportCard = async () => {
    if (exporting !== null) return;
    setExporting('card');
    try {
      const svg = await fetchCard({ infra, range });
      const stamp = data?.range?.since ?? new Date().toISOString().slice(0, 10);
      try {
        const png = await cardToPng(svg);
        download(png, `dsh-carbon-${stamp}.png`);
        setFlash(t('export.carded'));
      } catch {
        // A browser that will not rasterise still gets the vector file.
        download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `dsh-carbon-${stamp}.svg`);
        setFlash(t('export.cardedSvg'));
      }
    } catch (error) {
      setFlash(t('export.failed', { message: messageOf(error) }));
    } finally {
      setExporting(null);
    }
  };

  const exportBadge = async () => {
    if (data === null) return;
    const markdown = badgeMarkdown({
      grams: data.totals?.grams ?? 0,
      measuredAt: summary.fetchedAt || Date.now(),
      ...(typeof data.homepage === 'string' ? { href: data.homepage } : {}),
    });
    const ok = await copyText(markdown);
    setFlash(ok ? t('export.badged') : t('export.badgeFailed'));
  };

  const busy = summary.status === 'loading' || summary.status === 'refreshing';

  return (
    <div className="dshc-page">
      <div className="dshc-scroll">
        <div className="dshc-content">
          <header className="dshc-head">
            <div className="dshc-headText">
              <h1>{t('title')}</h1>
              <p className="dshc-sub">{t('subtitle')}</p>
            </div>
            <div className="dshc-actions">
              <div className="dshc-seg" role="group" aria-label={t('aria.window')}>
                {RANGES.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={range === key}
                    onClick={() => chooseRange(key)}
                    title={t(`range.${key}`)}
                  >
                    {t(`rangeShort.${key}`)}
                  </button>
                ))}
              </div>
              <div className="dshc-seg" role="group" aria-label={t('aria.fleet')}>
                <button
                  type="button"
                  aria-pressed={infra === 'china'}
                  onClick={() => chooseInfra('china')}
                  title={t('fleet.aria')}
                >
                  {t('fleet.china')}
                </button>
                <button
                  type="button"
                  aria-pressed={infra === 'azure'}
                  onClick={() => chooseInfra('azure')}
                  title={t('fleet.aria')}
                >
                  {t('fleet.azure')}
                </button>
              </div>
              <button
                type="button"
                className="dshc-iconBtn"
                onClick={() => summary.refresh()}
                title={t('refresh')}
                aria-label={t('aria.refresh')}
                disabled={busy && data === null}
              >
                <RefreshIcon size={15} className={busy ? 'dshc-spin' : undefined} />
              </button>
            </div>
          </header>

          <div className="dshc-tabsRow">
            <div className="dshc-tabs" role="tablist" aria-label={t('tabs.aria')}>
              {['overview', 'method'].map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`dshc-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`dshc-panel-${id}`}
                  className="dshc-tab"
                  onClick={() => setTab(id)}
                >
                  {t(`tab.${id}`)}
                </button>
              ))}
            </div>
            {summary.fetchedAt > 0 && (
              <span className="dshc-updated">{t('updated', { time: clockLabel(summary.fetchedAt, locale) })}</span>
            )}
          </div>

          {summary.error && data !== null && (
            <div className="dshc-inlineError" role="alert">
              <span>{summary.error}</span>
              <button type="button" className="dshc-linkBtn" onClick={() => summary.refresh()}>
                {t('error.retry')}
              </button>
            </div>
          )}

          {flash !== null && (
            <div className="dshc-flash" role="status">{flash}</div>
          )}

          <div
            id="dshc-panel-overview"
            role="tabpanel"
            aria-labelledby="dshc-tab-overview"
            className="dshc-body"
            hidden={tab !== 'overview'}
          >
            <Overview
              t={t}
              locale={locale}
              summary={summary}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((value) => !value)}
              onMethod={() => setTab('method')}
              onExportCard={exportCard}
              onExportBadge={exportBadge}
              exporting={exporting}
            />
          </div>
          <div
            id="dshc-panel-method"
            role="tabpanel"
            aria-labelledby="dshc-tab-method"
            className="dshc-body"
            hidden={tab !== 'method'}
          >
            {tab === 'method' && <MethodView t={t} locale={locale} method={method} summary={data} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Overview({ t, locale, summary, expanded, onToggleExpanded, onMethod, onExportCard, onExportBadge, exporting }) {
  const data = summary.data;

  if (summary.status === 'loading' && data === null) return <SkeletonOverview />;
  if (data === null) {
    return (
      <ErrorState
        t={t}
        title={t('error.title')}
        body={summary.error ?? t('error.body')}
        onRetry={() => summary.refresh()}
      />
    );
  }
  if ((data.totals?.sessions ?? 0) === 0) return <EmptyState t={t} />;

  const totals = data.totals;

  return (
    <>
      <Hero t={t} locale={locale} data={data} />
      <Stripes
        t={t}
        locale={locale}
        data={data}
        onExportCard={onExportCard}
        onExportBadge={onExportBadge}
        exporting={exporting}
      />
      <StatGrid t={t} locale={locale} totals={totals} />
      <TokenMix t={t} locale={locale} data={data} />
      <div className="dshc-grid">
        <section className="dshc-card" aria-labelledby="dshc-sessions-heading">
          <h2 id="dshc-sessions-heading">
            <span>{t('sessions.title')}</span>
            <span className="dshc-count">{t('sessions.count', { count: totals.sessions })}</span>
          </h2>
          <SessionList
            t={t}
            locale={locale}
            sessions={data.sessions ?? []}
            expanded={expanded}
            onToggle={onToggleExpanded}
          />
        </section>
        <section className="dshc-card" aria-labelledby="dshc-models-heading">
          <h2 id="dshc-models-heading">{t('models.title')}</h2>
          <ModelList t={t} locale={locale} models={data.models ?? []} onMethod={onMethod} />
        </section>
      </div>
      <ConfidenceNote t={t} totals={totals} onMethod={onMethod} />
    </>
  );
}

function Hero({ t, locale, data }) {
  const totals = data.totals;
  const estimate = formatGrams(totals.grams);
  const low = formatGrams(totals.low);
  const high = formatGrams(totals.high);
  const ratio = totals.high > totals.low ? (totals.grams - totals.low) / (totals.high - totals.low) : 0.5;
  const position = Math.min(1, Math.max(0, ratio)) * 100;
  const heat = heatTone(totals.grams);
  const heatScale = t('heat.scale', { green: gramsText(GREEN_AT), red: gramsText(RED_AT) });
  const change = data.change;

  return (
    <section
      className="dshc-hero"
      aria-labelledby="dshc-hero-label"
      style={{ '--dshc-heat': heat.color }}
    >
      <div className="dshc-heroMain">
        <div className="dshc-heroTop">
          <div className="dshc-eyebrow" id="dshc-hero-label">{t('estimated')}</div>
          <div className="dshc-heatBand" title={heatScale}>
            <span className="dshc-heatDot" aria-hidden="true" />
            {t(`heat.${heat.band}`)}
          </div>
        </div>
        <div className="dshc-big">
          <span className="dshc-bigValue">{estimate.value}</span>
          <span className="dshc-bigUnit">{estimate.unit}</span>
        </div>
        <div className="dshc-range">
          <div className="dshc-rangeCaption">{t('range', { low: gramsText(totals.low), high: gramsText(totals.high) })}</div>
          <div
            className="dshc-rangeTrack"
            role="img"
            aria-label={t('aria.range', {
              low: gramsText(totals.low),
              high: gramsText(totals.high),
              value: gramsText(totals.grams),
            })}
          >
            <span className="dshc-rangeMark" style={{ left: `${position}%` }} />
          </div>
        </div>
        <div className="dshc-heroFoot">
          <span className="dshc-heroWindow">{t(`rangeLabel.${data.range?.key ?? '30d'}`, { days: data.range?.days ?? 0 })}</span>
          {change !== null && Number.isFinite(change) && (
            <span className={`dshc-change ${change >= 0 ? 'dshc-changeUp' : 'dshc-changeDown'}`}>
              {change >= 0 ? '\u2197' : '\u2198'} {percent(Math.abs(change * 100), 0)}%
              <span className="dshc-changeNote">{t('change.vs', { days: data.range?.days ?? 0 })}</span>
            </span>
          )}
        </div>
      </div>
      <div className="dshc-heroWhale">
        <Whale load={heat.load} title={t('whale.aria', { grams: gramsText(totals.grams) })} />
        <span className="dshc-whaleCaption">{t('whale.caption')}</span>
      </div>
      <Equivalences t={t} locale={locale} grams={totals.grams} equivalences={data.equivalences} />
    </section>
  );
}

/**
 * The stripes: one column per day, week or month, coloured against the median
 * of the periods shown.
 *
 * A bucket is a `<button>` rather than a `<div>` with a mouse handler: the date
 * and the total are the point of hovering, so they have to be reachable from a
 * keyboard and announced by a screen reader. The detail line below the row is
 * the same element for both.
 */
function Stripes({ t, locale, data, onExportCard, onExportBadge, exporting }) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const [active, setActive] = useState(null);
  if (buckets.length === 0) return null;

  const unit = data.range?.unit ?? 'day';
  const median = data.medianBucketGrams ?? 0;
  const hovered = active === null ? null : buckets[active];

  const when = (bucket) => {
    const date = new Date(bucket.from);
    if (unit === 'month') return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(date);
    if (unit === 'week') return t('stripes.weekOf', { date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date) });
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  };

  const describe = (bucket) =>
    t('stripes.bucket', {
      date: when(bucket),
      grams: gramsText(bucket.grams),
      sessions: bucket.sessions,
    });

  return (
    <section className="dshc-card dshc-stripesCard" aria-labelledby="dshc-stripes-heading">
      <div className="dshc-stripesHead">
        <h2 id="dshc-stripes-heading">{t('stripes.title')}</h2>
        <span className="dshc-stripesMeta">
          {t('stripes.caption', {
            unit: t(`stripes.unit.${unit}`),
            median: gramsText(median),
          })}
        </span>
      </div>

      <div className="dshc-stripes" role="group" aria-label={t('stripes.aria', { unit: t(`stripes.unit.${unit}`) })}>
        {buckets.map((bucket, index) => (
          <button
            key={bucket.key}
            type="button"
            className={`dshc-stripe ${bucket.grams <= 0 ? 'dshc-stripeEmpty' : ''} ${active === index ? 'dshc-stripeActive' : ''}`}
            style={{ '--dshc-stripe': bucket.color, flexGrow: '1' }}
            aria-label={describe(bucket)}
            title={describe(bucket)}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
          />
        ))}
      </div>

      <div className="dshc-stripesFoot">
        <span className="dshc-stripesRead" aria-live="polite">
          {hovered === null ? (
            t('stripes.hint')
          ) : (
            <>
              <strong>{when(hovered)}</strong>
              <span className="dshc-dot" aria-hidden="true" />
              {gramsText(hovered.grams)}
              <span className="dshc-dot" aria-hidden="true" />
              {t('stripes.sessions', { count: hovered.sessions })}
            </>
          )}
        </span>
        <span className="dshc-export">
          <button type="button" className="dshc-button dshc-buttonGhost" onClick={onExportCard} disabled={exporting === 'card'}>
            {exporting === 'card' ? t('export.cardBusy') : t('export.card')}
          </button>
          <button type="button" className="dshc-button dshc-buttonGhost" onClick={onExportBadge}>
            {t('export.badge')}
          </button>
        </span>
      </div>
    </section>
  );
}

function Equivalences({ t, locale, grams, equivalences }) {
  const list = Array.isArray(equivalences) ? equivalences : [];
  const known = ['car', 'kettle', 'phone'];
  const rows = [];
  for (const id of known) {
    const entry = list.find((item) => item?.id === id);
    if (entry === undefined || !Number.isFinite(entry.divisor) || entry.divisor <= 0) continue;
    const value = grams / entry.divisor;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (id === 'kettle' && value < 0.1) continue;
    const decimals = Number.isFinite(entry.decimals) ? entry.decimals : 1;
    const rendered = value < 0.1
      ? '<0.1'
      : new Intl.NumberFormat(locale, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(value);
    rows.push({ id, rendered, label: t(`eq.${id}`) });
  }
  if (rows.length === 0) return null;

  const icon = { car: CarIcon, kettle: KettleIcon, phone: PhoneIcon };

  return (
    <div className="dshc-eq">
      {rows.map((row) => {
        const Icon = icon[row.id] ?? LeafIcon;
        return (
          <div className="dshc-eqRow" key={row.id}>
            <span className="dshc-eqIcon"><Icon size={15} /></span>
            <span>
              <strong className="dshc-eqValue">{row.rendered}</strong>{' '}
              <span className="dshc-eqLabel">{row.label}</span>
            </span>
          </div>
        );
      })}
      <div className="dshc-eqNote">{t('eq.note')}</div>
    </div>
  );
}

function StatGrid({ t, locale, totals }) {
  const cacheShare = totals.tokens > 0 ? (totals.cacheRead / totals.tokens) * 100 : 0;
  const stats = [
    {
      label: t('stat.tokens'),
      value: compact(totals.tokens, locale),
      sub: t('stat.tokensSub', { pct: percent(cacheShare, 0) }),
    },
    {
      label: t('stat.calls'),
      value: exact(totals.calls, locale),
      sub: t('stat.callsSub', { count: exact(totals.sessions, locale) }),
    },
    {
      label: t('stat.output'),
      value: compact(totals.output, locale),
      sub: t('stat.outputSub', { count: compact(totals.input ?? 0, locale) }),
    },
    {
      label: t('stat.cost'),
      value: usd(totals.cost, totals.unpriced),
      sub: totals.unpriced ? t('stat.costUnpriced') : t('stat.costSub'),
    },
  ];
  return (
    <div className="dshc-stats">
      {stats.map((stat) => (
        <div className="dshc-stat" key={stat.label}>
          <div className="dshc-statLabel">{stat.label}</div>
          <div className="dshc-statValue">{stat.value}</div>
          <div className="dshc-statSub">{stat.sub}</div>
        </div>
      ))}
    </div>
  );
}

const KINDS = [
  { id: 'input', className: 'dshc-mixInput', label: 'mix.uncached' },
  { id: 'cacheWrite', className: 'dshc-mixWrite', label: 'mix.write' },
  { id: 'cacheRead', className: 'dshc-mixCache', label: 'mix.cache' },
  { id: 'output', className: 'dshc-mixOutput', label: 'mix.output' },
];

/**
 * Two bars over the same four kinds of token: one by tokens, one by grams.
 *
 * A single token bar hides the finding. Almost every token in a session is a
 * cache read, but a cache read is priced at a fraction of an uncached one;
 * output is a rounding error in tokens and most of the footprint. The two bars
 * make that visible without a sentence explaining it.
 */
function TokenMix({ t, locale, data }) {
  const totals = data?.totals ?? {};
  const kinds = Array.isArray(data?.kinds) ? data.kinds : [];
  const rows = KINDS.map((kind) => {
    const entry = kinds.find((item) => item.kind === kind.id);
    const tokens = entry?.tokens ?? (kind.id === 'cacheRead' ? totals.cacheRead : totals[kind.id]) ?? 0;
    return {
      ...kind,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      tokenShare: entry?.tokenShare ?? 0,
      gramShare: entry?.gramShare ?? 0,
      grams: entry?.grams ?? 0,
    };
  }).filter((row) => row.tokens > 0);

  if (rows.length === 0) {
    return (
      <section className="dshc-card dshc-mix" aria-labelledby="dshc-mix-heading">
        <h2 id="dshc-mix-heading">{t('mix.title')}</h2>
        <p className="dshc-muted">{t('mix.empty')}</p>
      </section>
    );
  }

  const bar = (shareOf, label) => (
    <div className="dshc-mixRow">
      <span className="dshc-mixRowLabel">{label}</span>
      <div className="dshc-mixBar" role="img" aria-label={label}>
        {rows.map((row) => {
          const share = shareOf(row);
          if (share <= 0) return null;
          return (
            <span
              key={row.id}
              className={row.className}
              style={{ width: `${share * 100}%` }}
              title={`${t(row.label)}: ${percent(share * 100, 1)}%`}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <section className="dshc-card dshc-mix" aria-labelledby="dshc-mix-heading">
      <h2 id="dshc-mix-heading">{t('mix.title')}</h2>
      <p className="dshc-mixLede">{t('mix.lede')}</p>
      {bar((row) => row.tokenShare, t('mix.byTokens'))}
      {bar((row) => row.gramShare, t('mix.byCo2'))}
      <div className="dshc-legend">
        <div className="dshc-legendHead" aria-hidden="true">
          <span />
          <span />
          <span>{t('mix.tokensColumn')}</span>
          <span>{t('mix.tokenShare')}</span>
          <span>{t('mix.co2Share')}</span>
        </div>
        {rows.map((row) => (
          <div className="dshc-legendRow" key={row.id}>
            <span className={`dshc-swatch ${row.className}`} />
            <span className="dshc-legendLabel">{t(row.label)}</span>
            <span className="dshc-legendValue">{compact(row.tokens, locale)}</span>
            <span className="dshc-legendPct">{percent(row.tokenShare * 100, 1)}%</span>
            <span className="dshc-legendPct">{percent(row.gramShare * 100, 1)}%</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionList({ t, locale, sessions, expanded, onToggle }) {
  if (sessions.length === 0) return <p className="dshc-muted">{'\u2014'}</p>;
  const visible = expanded ? sessions : sessions.slice(0, SESSION_ROWS);
  const max = sessions.reduce((acc, session) => Math.max(acc, session.grams ?? 0), 0);
  const hidden = sessions.length - visible.length;

  // Most sessions come from the workspace you are in. Repeating its name on
  // every row is noise; an outlier workspace is the one worth labelling.
  const byCwd = new Map();
  for (const session of sessions) {
    if (typeof session.cwd === 'string' && session.cwd.length > 0) {
      byCwd.set(session.cwd, (byCwd.get(session.cwd) ?? 0) + 1);
    }
  }
  let dominant = null;
  let dominantCount = 0;
  for (const [cwd, count] of byCwd) {
    if (count > dominantCount) {
      dominant = cwd;
      dominantCount = count;
    }
  }

  return (
    <>
      <ul className="dshc-rows">
        {visible.map((session) => {
          const when = timeLabel(session.firstUsageAt ?? session.lastUsageAt, locale) ?? t('sessions.unknownTime');
          const id = shortId(session.id);
          const cwd = basename(session.cwd);
          const showCwd = cwd !== null && session.cwd !== dominant;
          const factorCount = new Set((session.models ?? []).map((entry) => entry.factorId)).size;
          const width = max > 0 && (session.grams ?? 0) > 0 ? Math.max(2, ((session.grams ?? 0) / max) * 100) : 0;
          return (
            <li
              className="dshc-row"
              key={session.id}
              title={`${session.id}${cwd ? `\n${cwd}` : ''}`}
              aria-label={t('aria.session', {
                id,
                grams: gramsText(session.grams ?? 0),
                tokens: exact(session.tokens ?? 0, locale),
              })}
            >
              <div className="dshc-rowTop">
                <span className="dshc-rowWhen">{when}</span>
                <span className="dshc-rowGrams">{gramsText(session.grams ?? 0)}</span>
              </div>
              <div className="dshc-rowBar" aria-hidden="true">
                <span className="dshc-rowFill" style={{ width: `${width}%` }} />
              </div>
              <div className="dshc-rowMeta">
                <span>{t('sessions.tokens', { count: compact(session.tokens ?? 0, locale) })}</span>
                <span className="dshc-dot" aria-hidden="true" />
                <span>{factorCount === 1 ? t('sessions.modelOne') : t('sessions.models', { count: factorCount })}</span>
                <span className="dshc-dot" aria-hidden="true" />
                <TierChip tier={session.tier} t={t} />
                {showCwd && <span className="dshc-rowCwd">{cwd}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button type="button" className="dshc-more" onClick={onToggle}>
          {t('sessions.more', { count: sessions.length })}
          <ChevronIcon size={12} open={expanded} />
        </button>
      )}
      {expanded && sessions.length > SESSION_ROWS && (
        <button type="button" className="dshc-more" onClick={onToggle}>
          {t('sessions.less')}
          <ChevronIcon size={12} open={false} />
        </button>
      )}
    </>
  );
}

function ModelList({ t, locale, models, onMethod }) {
  if (models.length === 0) return <p className="dshc-muted">{'\u2014'}</p>;
  const max = models.reduce((acc, model) => Math.max(acc, model.grams ?? 0), 0);

  return (
    <>
      <ul className="dshc-models">
        {models.map((model) => {
        const aliases = Array.isArray(model.models) ? model.models : [];
        const others = aliases.filter((alias) => alias !== model.factorId);
        const factor = model.factor;
        const width = max > 0 && (model.grams ?? 0) > 0 ? Math.max(2, ((model.grams ?? 0) / max) * 100) : 0;
        return (
          <li
            className="dshc-model"
            key={model.factorId}
            aria-label={t('aria.model', {
              model: model.factorId,
              grams: gramsText(model.grams ?? 0),
              share: percent((model.share ?? 0) * 100, 0),
            })}
            title={others.length > 0 ? t('models.aliases', { models: others.join(', ') }) : undefined}
          >
            <div className="dshc-modelTop">
              <code className="dshc-code">{model.factorId}</code>
              <span className="dshc-modelGrams">{gramsText(model.grams ?? 0)}</span>
            </div>
            <div className="dshc-modelBar" aria-hidden="true">
              <span className="dshc-modelFill" style={{ width: `${width}%` }} />
            </div>
            <div className="dshc-modelMeta">
              <TierChip tier={model.tier} t={t} />
              <span>{t('models.share', { pct: percent((model.share ?? 0) * 100, 0) })}</span>
              <span className="dshc-dot" aria-hidden="true" />
              <span>{t('models.calls', { count: exact(model.calls ?? 0, locale) })}</span>
            </div>
            {factor != null && factor.input !== null && factor.output !== null && (
              <div className="dshc-modelFactor">
                <span>{t('models.factor', { input: factorNumber(factor.input), output: factorNumber(factor.output) })}</span>
                <span className="dshc-dot" aria-hidden="true" />
                <span>
                  {t('models.band', {
                    low: multiplier(factor.lowMultiplier),
                    high: multiplier(factor.highMultiplier),
                  })}
                </span>
              </div>
            )}
            {others.length > 0 && (
              <div className="dshc-modelAliases">{t('models.aliases', { models: others.join(', ') })}</div>
            )}
          </li>
        );
      })}
      </ul>
      {onMethod !== undefined && (
        <button type="button" className="dshc-more dshc-modelMethod" onClick={onMethod}>
          {t('models.method')}
          <ChevronIcon size={12} open={false} />
        </button>
      )}
    </>
  );
}

function ConfidenceNote({ t, totals, onMethod }) {
  if ((totals.sessions ?? 0) === 0) return null;
  const warn = (totals.measured ?? 0) === 0;
  return (
    <div className={`dshc-note ${warn ? 'dshc-noteWarn' : 'dshc-noteOk'}`} role="note">
      <span className="dshc-noteIcon">{warn ? <InfoIcon size={16} /> : <LeafIcon size={16} />}</span>
      <p>
        <strong>{warn
          ? t('confidence.warnTitle')
          : t('confidence.okTitle', { measured: totals.measured, total: totals.sessions })}</strong>{' '}
        {warn
          ? t('confidence.warnBody', { count: totals.sessions })
          : t('confidence.okBody')}{' '}
        <button type="button" className="dshc-linkBtn" onClick={onMethod}>
          {t('confidence.link')}
        </button>
      </p>
    </div>
  );
}

function MethodView({ t, locale, method, summary }) {
  if (method.status === 'loading' || method.status === 'idle') return <SkeletonMethod />;
  if (method.status === 'error' || method.data === null) {
    return (
      <ErrorState
        t={t}
        title={t('error.title')}
        body={method.error ?? t('error.body')}
        onRetry={() => method.retry()}
      />
    );
  }

  const factors = method.data.models ?? [];
  const fallback = method.data.fallback;
  const all = [...factors, ...(fallback ? [fallback] : [])];
  const cacheFactor = method.data.cacheReadFactor?.value;
  const infra = summary?.infrastructure;

  return (
    <div className="dshc-method">
      <p className="dshc-lede">{t('method.lede')}</p>
      <pre className="dshc-formula">{t('method.formula', { cacheFactor: factorNumber(cacheFactor) })}</pre>

      <div className="dshc-grid dshc-gridTight">
        <section className="dshc-card" aria-labelledby="dshc-deployment-heading">
          <h2 id="dshc-deployment-heading">{t('method.deployment')}</h2>
          {infra !== undefined && infra !== null ? (
            <>
              <dl className="dshc-dl">
                <dt>{t('method.fleet')}</dt>
                <dd>{fleetName(t, infra.key)}</dd>
                <dt>{t('method.grid')}</dt>
                <dd>{factorNumber(infra.cif)} kgCO{'\u2082'}e/kWh</dd>
                <dt>{t('method.pue')}</dt>
                <dd>{factorNumber(infra.pue)}</dd>
                <dt>{t('method.scale')}</dt>
                <dd>{multiplier(infra.scale)}</dd>
              </dl>
              <p className="dshc-cardNote">{t('method.deploymentNote')}</p>
            </>
          ) : (
            <p className="dshc-muted">{'\u2014'}</p>
          )}
        </section>

        <section className="dshc-card" aria-labelledby="dshc-tiers-heading">
          <h2 id="dshc-tiers-heading">{t('method.tiers')}</h2>
          <ul className="dshc-tiers">
            {['measured', 'derived', 'extrapolated', 'unknown'].map((tier) => (
              <li key={tier}>
                <TierChip tier={tier} t={t} />
                <span>{t(`method.tierNote.${tier}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="dshc-card" aria-labelledby="dshc-factors-heading">
        <h2 id="dshc-factors-heading">{t('method.factors')}</h2>
        <div className="dshc-tableWrap">
          <table className="dshc-table">
            <thead>
              <tr>
                <th scope="col">{t('method.model')}</th>
                <th scope="col">{t('method.tier')}</th>
                <th scope="col" className="dshc-num">{t('method.input')}</th>
                <th scope="col" className="dshc-num">{t('method.output')}</th>
                <th scope="col">{t('method.band')}</th>
              </tr>
            </thead>
            <tbody>
              {all.map((factor) => (
                <tr key={factor.id}>
                  <th scope="row" className="dshc-modelCell">
                    <code className="dshc-code">{factor.id}</code>
                    {factor.fit?.mape !== undefined && (
                      <span className="dshc-fit">
                        {factor.fit.mape <= 0.1
                          ? `fit ${percent(factor.fit.mape * 100, 1)}%`
                          : `fit ${percent(factor.fit.mape * 100, 0)}%`}
                      </span>
                    )}
                  </th>
                  <td><TierChip tier={factor.tier} t={t} /></td>
                  <td className="dshc-num">{factorNumber(factor.input)}</td>
                  <td className="dshc-num">{factorNumber(factor.output)}</td>
                  <td className="dshc-band">
                    {multiplier(factor.band?.low_multiplier)} {'\u2013'} {multiplier(factor.band?.high_multiplier)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dshc-perMtok">{t('method.perMtok')}</div>

        <h3 className="dshc-subheading">{t('method.caveats')}</h3>
        <div className="dshc-caveats">
          {all.map((factor) => (
            <div className="dshc-caveat" key={factor.id}>
              <div className="dshc-caveatHead">
                <code className="dshc-code">{factor.id}</code>
                <TierChip tier={factor.tier} t={t} />
              </div>
              <p className="dshc-source">
                <Linkified text={factor.source ?? ''} />
              </p>
              {factor.caveat && <p className="dshc-caveatNote">{factor.caveat}</p>}
            </div>
          ))}
        </div>
      </section>

      <CrossChecks t={t} data={method.data.crossChecks} />

      <footer className="dshc-footer">
        {t('method.footer', { version: method.data.methodologyVersion ?? '?' })}
      </footer>
    </div>
  );
}

const CROSS_VERDICT = {
  'order-of-magnitude': 'orderOfMagnitude',
  'band-top': 'bandTop',
  'not-used': 'notUsed',
};

function CrossChecks({ t, data }) {
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return null;

  return (
    <section className="dshc-card dshc-cross" aria-labelledby="dshc-cross-heading">
      <h2 id="dshc-cross-heading">{t('cross.title')}</h2>
      <p className="dshc-crossLede">{t('cross.lede')}</p>
      <ul className="dshc-crossList">
        {items.map((item) => {
          const verdict = CROSS_VERDICT[item.verdict] ?? 'notUsed';
          const peer = String(item.tier ?? '').startsWith('peer');
          return (
            <li className="dshc-crossRow" key={item.id}>
              <div className="dshc-crossHead">
                <code className="dshc-code">{item.model}</code>
                <span className="dshc-tier dshc-tier-unknown">
                  {peer ? t('cross.tier.peerReviewed') : t('cross.tier.estimated')}
                </span>
                <a
                  className="dshc-crossLink"
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {item.source}
                  <span aria-hidden="true"> ↗</span>
                </a>
                <span className="dshc-crossNumbers">
                  {factorNumber(item.whPerQuery)} Wh · {factorNumber(item.gramsPerQuery)} g CO₂e / query
                </span>
              </div>
              <p className={`dshc-crossVerdict dshc-crossVerdict-${item.verdict}`}>
                {t(`cross.verdict.${verdict}`)}
              </p>
            </li>
          );
        })}
      </ul>
      {data.accessed && (
        <p className="dshc-crossAccessed">{t('cross.accessed', { date: data.accessed })}</p>
      )}
    </section>
  );
}

function fleetName(t, key) {
  if (key === 'deepseek_own_china') return t('fleet.china');
  if (key === 'microsoft_azure') return t('fleet.azure');
  return key ?? '\u2014';
}

function TierChip({ tier, t }) {
  const known = ['measured', 'derived', 'extrapolated', 'unknown'].includes(tier) ? tier : 'unknown';
  return (
    <span
      className={`dshc-tier dshc-tier-${known}`}
      title={t(`method.tierNote.${known}`)}
    >
      {t(`method.tier.${known}`)}
    </span>
  );
}

function Linkified({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((part, index) => (
    /^https?:\/\//.test(part)
      ? <a key={`${index}-${part}`} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
      : <span key={`${index}-${part.length}`}>{part}</span>
  ));
}

function SkeletonOverview() {
  return (
    <div className="dshc-skeleton" aria-busy="true">
      <div className="dshc-skelHero">
        <div className="dshc-skel" style={{ width: '22%', height: 12 }} />
        <div className="dshc-skel" style={{ width: '34%', height: 38, marginTop: 12 }} />
        <div className="dshc-skel" style={{ width: '52%', height: 8, marginTop: 16 }} />
      </div>
      <div className="dshc-stats">
        {[0, 1, 2, 3].map((key) => (
          <div className="dshc-stat" key={key}>
            <div className="dshc-skel" style={{ width: '50%', height: 9 }} />
            <div className="dshc-skel" style={{ width: '38%', height: 22, marginTop: 9 }} />
            <div className="dshc-skel" style={{ width: '62%', height: 8, marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="dshc-card">
        <div className="dshc-skel" style={{ width: '24%', height: 10 }} />
        <div className="dshc-skel" style={{ width: '100%', height: 8, marginTop: 14 }} />
      </div>
      <div className="dshc-grid">
        <div className="dshc-card">
          <div className="dshc-skel" style={{ width: '30%', height: 10 }} />
          {[0, 1, 2, 3].map((key) => (
            <div className="dshc-skel" key={key} style={{ width: '100%', height: 30, marginTop: 10 }} />
          ))}
        </div>
        <div className="dshc-card">
          <div className="dshc-skel" style={{ width: '44%', height: 10 }} />
          {[0, 1, 2].map((key) => (
            <div className="dshc-skel" key={key} style={{ width: '100%', height: 38, marginTop: 12 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SkeletonMethod() {
  return (
    <div className="dshc-skeleton" aria-busy="true">
      <div className="dshc-skel" style={{ width: '72%', height: 12 }} />
      <div className="dshc-skel" style={{ width: '100%', height: 76, marginTop: 16 }} />
      <div className="dshc-grid dshc-gridTight" style={{ marginTop: 16 }}>
        <div className="dshc-card"><div className="dshc-skel" style={{ width: '100%', height: 120 }} /></div>
        <div className="dshc-card"><div className="dshc-skel" style={{ width: '100%', height: 120 }} /></div>
      </div>
      <div className="dshc-card" style={{ marginTop: 16 }}>
        <div className="dshc-skel" style={{ width: '100%', height: 180 }} />
      </div>
    </div>
  );
}

function ErrorState({ t, title, body, onRetry }) {
  return (
    <div className="dshc-state" role="alert">
      <span className="dshc-stateIcon"><InfoIcon size={20} /></span>
      <h2>{title}</h2>
      <p>{body}</p>
      <button type="button" className="dshc-button" onClick={onRetry}>{t('error.retry')}</button>
    </div>
  );
}

function EmptyState({ t }) {
  return (
    <div className="dshc-state">
      <span className="dshc-stateIcon dshc-stateLeaf"><LeafIcon size={22} /></span>
      <h2>{t('empty.title')}</h2>
      <p>{t('empty.body')}</p>
      <p className="dshc-emptyHint"><code className="dshc-code">{t('empty.hint')}</code></p>
    </div>
  );
}

/** The pure view with a fixture, for tests and for a future preview harness. */
export const __test = {
  Hero,
  Stripes,
  TokenMix,
  Whale: (props) => <Whale {...props} />,
  heatTone,
  StatGrid,
  SessionList,
  ModelList,
  TierChip,
  MethodView,
  formatGrams,
  percent,
  usd,
};
