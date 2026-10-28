/**
 * Host entry for dsh-carbon.
 *
 * Registers read-only HTTP routes under `/dsh-carbon` so the web GUI (or any
 * local client) can show the current footprint. The routes are loopback-only and
 * same-origin-fenced, matching the pattern the shipped plugins use: this exposes
 * local usage data, so it should not be reachable from a LAN.
 *
 * Readings come from the durable store in `lib/core/history.mjs`, not from the
 * session logs directly. The store is synced incrementally — an unchanged log
 * is stat'd, not parsed — so a request costs a directory walk even when the
 * history is a year deep, and a session whose log the harness has pruned still
 * counts.
 *
 * The browser half (`lib/client.js`, built from `src/client/`) renders the
 * sidebar page against these routes. The routes stay useful on their own for
 * scripts and for a client-only install.
 */
import { carbonForModel, costForModel, loadFactors, summarise, infraOf } from '../core/carbon.mjs';
import { buildSummary, buildMethodology } from '../core/report.mjs';
import { loadCrossChecks } from '../core/cross-checks.mjs';
import { resolveRange, rowsInRange, syncHistory, historyPath, sessionAt } from '../core/history.mjs';
import { buildTimeline } from '../core/timeline.mjs';
import { renderCard } from '../core/card.mjs';
import { renderBadge } from '../core/badge.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The package's own `homepage`, so a badge links somewhere its author chose. */
function packageHomepage() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    return typeof manifest.homepage === 'string' && manifest.homepage !== '' ? manifest.homepage : null;
  } catch {
    return null;
  }
}

const HOMEPAGE = packageHomepage();

export const name = 'dsh-carbon';

const ROUTE_PREFIX = '/dsh-carbon';
const CACHE_MS = 5_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** One cache slot per (fleet, range, limit). The previous single slot leaked the
 * first caller's fleet into every later reading inside the 5s window, so
 * toggling the fleet in the GUI could show one fleet's header over another's
 * rows. */
const cache = new Map();

/** Fold stored rows into the shape `buildSummary` already knows how to price. */
function sessionsForSummary(rows, factors, limit) {
  return rows
    .map((row) => {
      const perModel = (row.models ?? []).map((cell) => ({
        carbon: carbonForModel(cell, factors),
        cost: costForModel(cell, factors),
      }));
      return {
        id: row.id,
        cwd: row.cwd ?? null,
        firstUsageAt: row.firstUsageAt ?? row.createdAt ?? null,
        lastUsageAt: row.lastUsageAt ?? null,
        turns: row.turns ?? 0,
        perModel,
        totals: summarise(perModel),
      };
    })
    .filter((session) => session.perModel.length > 0)
    .slice(0, limit);
}

/**
 * The page payload: the timeline (range, buckets, kinds) with the model roll-up
 * and the session list from the summary builder, so both halves describe one
 * window.
 */
function payload({ infraOverride, rangeSpec, since, until, limit, fresh = false }) {
  const factors = loadFactors();
  const infra = infraOf(factors, infraOverride);
  const key = `${infra.key}:${rangeSpec}:${since ?? ''}:${until ?? ''}:${limit}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (!fresh && hit !== undefined && now - hit.at < CACHE_MS) return hit.value;

  const { rows, stats, path } = syncHistory();
  const timeline = buildTimeline({ factors, rows, infra: infraOverride, range: rangeSpec, since, until, now });
  const windowRows = rowsInRange(rows, resolveRange(rangeSpec, now, { since, until }));
  const summary = buildSummary({ factors, sessions: sessionsForSummary(windowRows, factors, limit), infra, limit });

  const value = {
    ...timeline,
    path,
    methodologyVersion: factors._methodology_version,
    models: summary.models,
    sessions: summary.sessions,
    equivalences: summary.equivalences,
    homepage: HOMEPAGE,
    totals: {
      ...timeline.totals,
      measured: windowRows.filter((row) => (row.tier ?? '') === 'measured').length,
      unmeasured: windowRows.filter((row) => (row.tier ?? '') !== 'measured').length,
    },
    coverage: {
      ...timeline.coverage,
      onDisk: stats.onDisk,
      missing: stats.missing,
      parsed: stats.parsed,
      duplicates: stats.duplicates,
      skippedLines: stats.skippedLines,
    },
  };
  cache.set(key, { at: now, value });
  return value;
}

function parseLimit(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value));
}

function rangeParams(url) {
  return {
    rangeSpec: url.searchParams.get('range') ?? '30d',
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
  };
}

function sendJson(res, status, payloadValue) {
  const body = Buffer.from(JSON.stringify(payloadValue));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendSvg(res, svg, { download = null } = {}) {
  const body = Buffer.from(svg);
  const headers = {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  };
  if (download !== null) headers['content-disposition'] = `attachment; filename="${download}"`;
  res.writeHead(200, headers);
  res.end(body);
}

/** Loopback + same-origin fence; refuses anything else with 403. */
function refused(req) {
  const plain = req.socket?.remoteAddress?.startsWith('::ffff:')
    ? req.socket.remoteAddress.slice('::ffff:'.length)
    : req.socket?.remoteAddress;
  if (plain !== '::1' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain ?? '')) return true;
  const host = req.headers.host;
  if (typeof host === 'string') {
    if (!URL.canParse(`http://${host}`)) return true;
    const hostname = new URL(`http://${host}`).hostname;
    if (hostname !== 'localhost' && hostname !== '[::1]' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (!URL.canParse(origin)) return true;
  return new URL(origin).host !== host;
}

export function apply(ctx) {
  const register = (scope) => {
    const server = scope.webServer;
    if (server === undefined || server === null) {
      ctx.logger?.warn?.('dsh-carbon: no webServer service, HTTP routes not registered (CLI still works)');
      return;
    }

    scope.effect(() => {
      const disposers = [];
      const add = (label, route) => {
        try {
          const dispose = server.register(route);
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-carbon: ${label} route unavailable: ${error?.message ?? String(error)}`);
        }
      };

      /** Wrap a GET/HEAD route with the method and origin fences. */
      const guard = (handler) => (req, res) => {
        if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        if (refused(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        try {
          handler(url, req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? String(error)) });
        }
      };

      const summary = guard((url, req, res) => {
        const infraOverride = url.searchParams.get('infra') ?? process.env.DSH_CARBON_INFRA;
        const limit = parseLimit(url.searchParams.get('limit'));
        const fresh = url.searchParams.get('fresh') === '1';
        sendJson(res, 200, payload({ infraOverride, ...rangeParams(url), limit, fresh }));
      });

      add('summary', { kind: 'exact', path: ROUTE_PREFIX, handler: summary });
      add('summary', { kind: 'exact', path: `${ROUTE_PREFIX}/summary`, handler: summary });

      add('timeline', {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/timeline`,
        handler: guard((url, req, res) => {
          const infraOverride = url.searchParams.get('infra') ?? process.env.DSH_CARBON_INFRA;
          const value = payload({ infraOverride, ...rangeParams(url), limit: DEFAULT_LIMIT, fresh: url.searchParams.get('fresh') === '1' });
          const { models, sessions, path, ...timeline } = value;
          sendJson(res, 200, { ...timeline, store: path });
        }),
      });

      add('sessions', {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/sessions`,
        handler: guard((url, req, res) => {
          const infraOverride = url.searchParams.get('infra') ?? process.env.DSH_CARBON_INFRA;
          const limit = parseLimit(url.searchParams.get('limit'));
          const value = payload({ infraOverride, ...rangeParams(url), limit });
          sendJson(res, 200, {
            ok: true,
            generatedAt: value.generatedAt,
            infrastructure: value.infrastructure,
            range: value.range,
            sessions: value.sessions,
          });
        }),
      });

      add('methodology', {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/methodology`,
        handler: guard((url, req, res) => {
          sendJson(res, 200, buildMethodology(loadFactors(), loadCrossChecks()));
        }),
      });

      add('card', {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/card.svg`,
        handler: guard((url, req, res) => {
          const infraOverride = url.searchParams.get('infra') ?? process.env.DSH_CARBON_INFRA;
          const value = payload({ infraOverride, ...rangeParams(url), limit: DEFAULT_LIMIT, fresh: url.searchParams.get('fresh') === '1' });
          const filename = `dsh-carbon-${value.range.since}.svg`;
          sendSvg(res, renderCard({ timeline: value }), {
            download: url.searchParams.get('download') === '1' ? filename : null,
          });
        }),
      });

      add('badge', {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/badge.svg`,
        handler: guard((url, req, res) => {
          const infraOverride = url.searchParams.get('infra') ?? process.env.DSH_CARBON_INFRA;
          const rangeSpec = url.searchParams.get('range') ?? 'all';
          const value = payload({ infraOverride, rangeSpec, limit: DEFAULT_LIMIT, fresh: url.searchParams.get('fresh') === '1' });
          sendSvg(res, renderBadge({ grams: value.totals.grams, measuredAt: Date.parse(value.generatedAt) }));
        }),
      });

      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  };

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register);
  else register(ctx);
}

export { historyPath, sessionAt };
