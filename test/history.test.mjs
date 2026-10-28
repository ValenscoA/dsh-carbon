/**
 * The durable store: what it keeps, what it re-reads, and how it slices time.
 *
 * The point of these tests is not that JSON round-trips. It is that a session
 * survives the deletion of its log, that an unchanged log is not parsed again,
 * and that a window lands on calendar boundaries rather than on 168-hour spans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { foldSession } from '../lib/core/sessions.mjs';
import {
  readHistory,
  writeHistory,
  syncHistory,
  resolveRange,
  bucketKey,
  bucketsFor,
  median,
  sessionAt,
  historyPath,
  rowsInRange,
} from '../lib/core/history.mjs';

/** One zstd frame, the way the harness appends a flush. */
function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'));
}

function message(id, { input = 100, output = 50, cacheRead = 1000, cacheWrite = 0, at = 1_700_000_000_000, model = 'deepseek-v4.1-flash' } = {}) {
  return {
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
      message: { id, role: 'assistant', source: { model } },
    },
  };
}

/** A throwaway harness home with one session holding the given events. */
function makeHome(id = 'session-test-0001', events = null) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-carbon-history-'));
  const dir = join(home, 'sessions', 'ws', id);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  const body = events ?? [
    { type: 'session', id, createdAt: 1_700_000_000_000, cwd: '/tmp/project' },
    { type: 'turn/start' },
    message('m1'),
  ];
  writeFileSync(log, frame(body));
  return { home, dir, log, id };
}

test('a sync writes one row per session and keeps the raw token counts', () => {
  const { home, log } = makeHome();
  try {
    const result = syncHistory({ home });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.added, 1);
    assert.equal(result.stats.parsed, 1);
    assert.equal(result.path, historyPath(home));

    const [row] = result.rows;
    assert.equal(row.tokens, 1150);
    assert.equal(row.models[0].model, 'deepseek-v4.1-flash');
    assert.equal(row.models[0].cacheRead, 1000);
    assert.equal(row.cwd, '/tmp/project');
    // Grams are derived, never stored: the row must not carry a footprint.
    assert.equal(row.grams, undefined);

    // The file on disk is the same row.
    const reread = readHistory(result.path);
    assert.equal(reread.rows.length, 1);
    assert.equal(reread.rows[0].id, row.id);
    assert.ok(log.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unchanged log is not parsed again, and a grown one is', () => {
  const { home, log } = makeHome();
  try {
    const first = syncHistory({ home });
    assert.equal(first.stats.parsed, 1);

    const second = syncHistory({ home });
    assert.equal(second.stats.parsed, 0, 'second sync must not re-parse');
    assert.equal(second.stats.reused, 1);

    appendFileSync(log, frame([message('m2', { output: 500 })]));
    const third = syncHistory({ home });
    assert.equal(third.stats.parsed, 1, 'a grown log is re-parsed');
    assert.equal(third.stats.updated, 1);
    assert.equal(third.rows[0].models[0].output, 550);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a session whose log is gone survives, and is reported as unverified', () => {
  const { home, log } = makeHome();
  try {
    syncHistory({ home });
    rmSync(log);

    const after = syncHistory({ home });
    assert.equal(after.rows.length, 1, 'the row is kept');
    assert.equal(after.stats.missing, 1);
    assert.equal(after.stats.onDisk, 0);
    assert.equal(after.rows[0].tokens, 1150);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a replayed assistant message is counted once and reported', () => {
  const events = [
    { type: 'session', id: 'session-dup', createdAt: 1_700_000_000_000, cwd: '/tmp/x' },
    message('same-id', { output: 100 }),
    message('same-id', { output: 100 }),
  ];
  const fold = foldSession(events);
  assert.equal(fold.duplicates, 1);
  assert.equal(fold.byModel[0].output, 100, 'the replay does not double the tokens');
});

test('the store tolerates a corrupt line instead of losing the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-carbon-corrupt-'));
  try {
    const path = historyPath(home);
    writeHistory(path, [{ id: 'a', models: [], tokens: 0 }]);
    appendFileSync(path, '{not json\n');
    const { rows, skipped } = readHistory(path);
    assert.equal(rows.length, 1);
    assert.equal(skipped, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a window is calendar days, not 168 hours', () => {
  const now = new Date(2026, 9, 28, 15, 30, 0).getTime();
  const range = resolveRange('7d', now);
  assert.equal(range.days, 7);
  const from = new Date(range.from);
  assert.equal(from.getHours(), 0, 'starts at local midnight');
  assert.equal(from.getDate(), 22, 'seven days including today');
  assert.equal(range.unit, 'day');
});

test('a year of history is bucketed by month, a quarter by week', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  assert.equal(resolveRange('12mo', now).unit, 'week');
  assert.equal(resolveRange('90d', now).unit, 'week');
  assert.equal(resolveRange('30d', now).unit, 'day');
});

test('a custom range is inclusive of both dates', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const range = resolveRange('custom', now, { since: '2026-10-01', until: '2026-10-10' });
  assert.equal(range.from, new Date(2026, 9, 1).getTime());
  assert.equal(range.to, new Date(2026, 9, 11).getTime(), 'the upper bound is the end of the 10th');
  assert.equal(range.days, 10);
});

test('a malformed custom range falls back instead of throwing', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const range = resolveRange('custom', now, { since: 'yesterday' });
  assert.equal(range.key, '30d');
});

test('week buckets are stable inside a week and change across one', () => {
  const monday = new Date(2026, 9, 26, 9, 0, 0).getTime();
  const friday = new Date(2026, 9, 30, 23, 0, 0).getTime();
  const nextMonday = new Date(2026, 10, 2, 9, 0, 0).getTime();
  assert.equal(bucketKey(monday, 'week'), bucketKey(friday, 'week'));
  assert.notEqual(bucketKey(friday, 'week'), bucketKey(nextMonday, 'week'));
  assert.match(bucketKey(monday, 'week'), /^2026-W\d{2}$/);
});

test('every bucket in a window is present, empty ones included', () => {
  const range = resolveRange('7d', new Date(2026, 9, 28, 12, 0, 0).getTime());
  const buckets = bucketsFor(range);
  assert.equal(buckets.length, 7);
  assert.equal(new Set(buckets.map((bucket) => bucket.key)).size, 7);
  for (let index = 1; index < buckets.length; index += 1) {
    assert.equal(buckets[index].from, buckets[index - 1].to, 'buckets are contiguous');
  }
});

test('the median is the middle value, ignoring nothing and averaging pairs', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, Number.NaN, 3]), 2);
});

test('a session is counted on the day it last did work', () => {
  const row = { lastUsageAt: 2, firstUsageAt: 1, createdAt: 0 };
  assert.equal(sessionAt(row), 2);
  assert.equal(sessionAt({ firstUsageAt: 1, createdAt: 0 }), 1);
  assert.equal(sessionAt({ createdAt: 0 }), 0);
});

test('rows are filtered by the window half-open at the end', () => {
  const range = { from: 100, to: 200 };
  const rows = [{ lastUsageAt: 99 }, { lastUsageAt: 100 }, { lastUsageAt: 199 }, { lastUsageAt: 200 }];
  assert.equal(rowsInRange(rows, range).length, 2);
});
