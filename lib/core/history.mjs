/**
 * The durable record.
 *
 * Until this module existed, every reading re-parsed every session log. That
 * works only while the logs exist: the harness prunes old sessions, and a
 * footprint that disappears when the transcript does is not a record of
 * anything. This keeps one line per session, with the raw token counts, in
 * `<dsh home>/carbon/history.jsonl`.
 *
 * Rows store *tokens*, never grams. The conversion happens on every read, from
 * the factors in force at that moment. That is the opposite of the usual
 * store-the-result design and it is deliberate: when a factor is corrected the
 * whole history re-prices, with no migration step and no stale rows. What is
 * stored is what was measured — how many tokens of each kind crossed the wire —
 * and what is derived stays derived.
 *
 * The file is JSONL rather than SQLite because it has to be readable and
 * diffable by a person: this tool's whole claim is that you can check its
 * arithmetic, and a database file you need a shell to open works against that.
 * A few thousand rows is a few hundred kilobytes, far below the point where the
 * format matters.
 *
 * Sync is incremental. Each row remembers the size and mtime of the log it came
 * from; an unchanged log is not parsed again, only stat'd. A live session is
 * re-parsed whenever it grows, which is the one case where re-reading is the
 * point.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { harnessHome, listSessionDirs, readSessionEvents, foldSession } from './sessions.mjs';

export const HISTORY_VERSION = 1;

/** `<dsh home>/carbon/history.jsonl`, or `DSH_CARBON_HISTORY` verbatim. */
export function historyPath(home = harnessHome(), override = process.env.DSH_CARBON_HISTORY) {
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(home, 'carbon', 'history.jsonl');
}

/** Parse the store, tolerating truncated or hand-edited lines. */
export function readHistory(path) {
  if (!existsSync(path)) return { rows: [], skipped: 0 };
  const rows = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const row = JSON.parse(trimmed);
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') rows.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/** Write the store atomically, so a crash mid-write cannot truncate history. */
export function writeHistory(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, body === '' ? '' : `${body}\n`, 'utf8');
  renameSync(temp, path);
}

/** One row from a folded session. Tokens only; no grams, no cost. */
export function rowFromFold(dir, fold, now = Date.now()) {
  const models = fold.byModel.map((cell) => ({
    model: cell.model,
    input: cell.input,
    output: cell.output,
    cacheRead: cell.cacheRead,
    cacheWrite: cell.cacheWrite,
    calls: cell.calls,
  }));
  return {
    v: HISTORY_VERSION,
    id: fold.id ?? dir.id,
    workspace: dir.workspace ?? null,
    cwd: fold.cwd ?? null,
    createdAt: fold.createdAt ?? null,
    firstUsageAt: fold.firstUsageAt ?? null,
    lastUsageAt: fold.lastUsageAt ?? null,
    turns: fold.turns,
    steps: fold.steps,
    duplicates: fold.duplicates ?? 0,
    models,
    tokens: models.reduce(
      (acc, cell) => acc + cell.input + cell.output + cell.cacheRead + cell.cacheWrite,
      0,
    ),
    logBytes: dir.logBytes ?? null,
    logMtime: dir.logMtime ?? null,
    firstSeenAt: now,
    updatedAt: now,
  };
}

/** True when the log behind a row may have changed since the row was written. */
function stale(row, dir) {
  if (row === undefined) return true;
  if (dir.logBytes !== null && dir.logBytes !== undefined && row.logBytes !== dir.logBytes) return true;
  if (dir.logMtime === null || dir.logMtime === undefined) return false;
  // One millisecond of slack: some filesystems round timestamps.
  return dir.logMtime > (row.logMtime ?? 0) + 1;
}

/**
 * Bring the store up to date with the session logs on disk.
 *
 * Rows for sessions that are no longer on disk are kept, not dropped — that is
 * the entire point of the store. `stats.missing` says how many of them there
 * are, so the page can be honest about how much of the total comes from logs it
 * can still verify.
 *
 * @returns {{path: string, rows: object[], stats: object}}
 */
export function syncHistory({ home = harnessHome(), path = historyPath(home), now = Date.now(), force = false } = {}) {
  const store = readHistory(path);
  const byId = new Map(store.rows.map((row) => [row.id, row]));
  let parsed = 0;
  let reused = 0;
  let added = 0;
  let updated = 0;
  let unreadable = 0;
  let changed = store.skipped > 0;

  const dirs = listSessionDirs(home);
  const onDisk = new Set();

  for (const dir of dirs) {
    onDisk.add(dir.id);
    const existing = byId.get(dir.id);
    if (!force && existing !== undefined && !stale(existing, dir)) {
      reused += 1;
      continue;
    }
    let read;
    try {
      read = readSessionEvents(dir.log);
    } catch {
      unreadable += 1;
      continue;
    }
    const fold = foldSession(read.events);
    if (fold.byModel.length === 0) {
      // A session that has not called the model yet: leave any earlier row.
      reused += 1;
      continue;
    }
    const row = rowFromFold(dir, fold, now);
    if (existing !== undefined) {
      row.firstSeenAt = existing.firstSeenAt ?? now;
      updated += 1;
    } else {
      added += 1;
    }
    byId.set(row.id, row);
    parsed += 1;
    changed = true;
  }

  const rows = [...byId.values()].sort((a, b) => sessionAt(b) - sessionAt(a));
  if (changed) writeHistory(path, rows);

  let missing = 0;
  for (const row of rows) if (!onDisk.has(row.id)) missing += 1;

  return {
    path,
    rows,
    stats: {
      total: rows.length,
      onDisk: onDisk.size,
      missing,
      parsed,
      reused,
      added,
      updated,
      unreadable,
      duplicates: rows.reduce((acc, row) => acc + (row.duplicates ?? 0), 0),
      skippedLines: store.skipped,
    },
  };
}

/**
 * When a session is counted.
 *
 * A session's last usage, not its first: a session that starts on Sunday and
 * runs past midnight belongs to the day it did its work, and a long session
 * should not be attributed to an empty first minute. Falls back through
 * `firstUsageAt` and `createdAt` for a session that never completed a call.
 */
export function sessionAt(row) {
  return row.lastUsageAt ?? row.firstUsageAt ?? row.createdAt ?? 0;
}

/* ------------------------------------------------------------------ *
 * Ranges
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

export const RANGE_KEYS = ['7d', '30d', '90d', '12mo', 'all'];

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfWeek(ms) {
  const date = new Date(startOfDay(ms));
  // ISO weeks start on Monday; getDay() is 0 for Sunday.
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

function startOfMonth(ms) {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * Bucket width for a span: a day up to six weeks, a week up to about a year,
 * a month beyond. The thresholds keep the stripe count in the 14-60 range at
 * every range, which is what a stripe row can actually show.
 */
export function unitForSpan(from, to) {
  const days = Math.max(1, Math.round((to - from) / DAY));
  if (days <= 45) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

/**
 * Resolve a range selector into an absolute window.
 *
 * `until` is exclusive and both ends are local midnights, so "the last 7 days"
 * means seven whole calendar days including today, not 168 hours.
 */
export function resolveRange(spec = '30d', now = Date.now(), { since, until, oldest = null } = {}) {
  const endOfToday = startOfDay(now) + DAY;
  const key = RANGE_KEYS.includes(spec) ? spec : 'custom';

  if (key === 'all') {
    const from = oldest === null ? startOfDay(now) : startOfDay(oldest);
    return { key, from, to: endOfToday, unit: unitForSpan(from, endOfToday), days: Math.round((endOfToday - from) / DAY) };
  }
  if (key === '7d' || key === '30d' || key === '90d') {
    const days = Number.parseInt(key, 10);
    const from = startOfDay(now) - (days - 1) * DAY;
    return { key, from, to: endOfToday, unit: unitForSpan(from, endOfToday), days };
  }
  if (key === '12mo') {
    const from = startOfMonth(now);
    const date = new Date(from);
    date.setMonth(date.getMonth() - 11);
    return { key, from: date.getTime(), to: endOfToday, unit: unitForSpan(date.getTime(), endOfToday), days: Math.round((endOfToday - date.getTime()) / DAY) };
  }

  const from = parseDay(since);
  const to = parseDay(until);
  if (from === null) {
    // A malformed custom range falls back to the default rather than throwing:
    // this is reachable from a URL, and a 500 is a worse answer than 30 days.
    return resolveRange('30d', now, { oldest });
  }
  const windowFrom = from;
  const windowTo = to === null ? endOfToday : to + DAY;
  return {
    key: 'custom',
    from: windowFrom,
    to: windowTo,
    unit: unitForSpan(windowFrom, windowTo),
    days: Math.round((windowTo - windowFrom) / DAY),
  };
}

/** The same-length window immediately before `range`, for the delta. */
export function previousRange(range) {
  const span = range.to - range.from;
  return { ...range, from: range.from - span, to: range.from, previous: true };
}

/* ------------------------------------------------------------------ *
 * Buckets
 * ------------------------------------------------------------------ */

function pad(value) {
  return String(value).padStart(2, '0');
}

/** A stable key for the bucket a timestamp falls in, in local time. */
export function bucketKey(ms, unit) {
  const date = new Date(ms);
  if (unit === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  if (unit === 'week') {
    const thursday = new Date(startOfWeek(ms) + 3 * DAY);
    const year = thursday.getFullYear();
    const firstThursday = new Date(year, 0, 4);
    const week = 1 + Math.round((startOfWeek(thursday.getTime()) - startOfWeek(firstThursday.getTime())) / (7 * DAY));
    return `${year}-W${pad(week)}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Every bucket in the window, empty ones included, in order. */
export function bucketsFor(range) {
  const out = [];
  const unit = range.unit;
  let cursor = unit === 'month' ? startOfMonth(range.from) : unit === 'week' ? startOfWeek(range.from) : startOfDay(range.from);
  let guard = 0;
  while (cursor < range.to && guard < 5000) {
    guard += 1;
    const next =
      unit === 'month'
        ? (() => {
            const date = new Date(cursor);
            date.setMonth(date.getMonth() + 1);
            return date.getTime();
          })()
        : unit === 'week'
          ? cursor + 7 * DAY
          : cursor + DAY;
    out.push({ key: bucketKey(cursor, unit), from: cursor, to: next, unit });
    cursor = next;
  }
  return out;
}

/** Median of the non-zero values; zero when there is nothing to take. */
export function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 0 ? (numbers[middle - 1] + numbers[middle]) / 2 : numbers[middle];
}

/** Fold rows into the window, newest first. */
export function rowsInRange(rows, range) {
  return rows.filter((row) => {
    const at = sessionAt(row);
    return at >= range.from && at < range.to;
  });
}
