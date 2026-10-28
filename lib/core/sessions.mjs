/**
 * Reads DeepSeek Harness session logs.
 *
 * A session log is a JSONL file that the harness *appends* to, one zstd frame
 * per flush — a live log here had 168 frames. Node's zstdDecompressSync decodes
 * only the first frame and silently returns a truncated log, so the frames have
 * to be walked individually. Because a frame boundary is not reliably
 * distinguishable from a 0x28B52FFD byte sequence inside compressed data, each
 * candidate split is validated by attempting the decode rather than trusted.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_LOOKAHEAD = 8;

/** Decode every zstd frame in a buffer, tolerating a partial trailing frame. */
export function decodeZstdFrames(buffer) {
  const candidates = [];
  for (let i = 0; i <= buffer.length - MAGIC.length; i += 1) {
    if (
      buffer[i] === MAGIC[0] &&
      buffer[i + 1] === MAGIC[1] &&
      buffer[i + 2] === MAGIC[2] &&
      buffer[i + 3] === MAGIC[3]
    ) {
      candidates.push(i);
    }
  }
  if (candidates.length === 0) return buffer.toString('utf8');

  const parts = [];
  let cursor = 0;
  while (cursor < candidates.length) {
    let advanced = false;
    const limit = Math.min(candidates.length, cursor + MAX_LOOKAHEAD);
    for (let next = cursor + 1; next <= limit; next += 1) {
      const start = candidates[cursor];
      const end = next < candidates.length ? candidates[next] : buffer.length;
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, end)));
        cursor = next;
        advanced = true;
        break;
      } catch {
        // Not a real frame boundary; try a later candidate.
      }
    }
    if (!advanced) break;
  }
  return trimToCompleteLines(Buffer.concat(parts).toString('utf8'));
}

/**
 * Drop a trailing partial line.
 *
 * The log is appended to while it is read, so the final frame is routinely
 * half-written. Node's decoder does not reject a truncated frame — it returns
 * whatever prefix it managed to decompress, e.g. `{"type":"se"`. That is not a
 * JSON line and must not reach the parser. Everything up to the last newline is
 * complete by construction, because the harness writes one event per line.
 */
function trimToCompleteLines(text) {
  if (text === '' || text.endsWith('\n')) return text;
  const lastBreak = text.lastIndexOf('\n');
  return lastBreak === -1 ? '' : text.slice(0, lastBreak + 1);
}

export function harnessHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Every session directory under `<dsh home>/sessions`, newest first. */
export function listSessionDirs(home = harnessHome()) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  const found = [];
  for (const workspace of readdirSync(root)) {
    const workspaceDir = join(root, workspace);
    let entries;
    try {
      if (!statSync(workspaceDir).isDirectory()) continue;
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(workspaceDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const log = join(dir, 'session.v4.jsonl.zstd');
      if (!existsSync(log)) continue;
      const stat = statSync(log);
      found.push({
        id: entry,
        workspace,
        dir,
        log,
        logMtime: stat.mtimeMs,
        logBytes: stat.size,
      });
    }
  }
  return found.sort((a, b) => b.logMtime - a.logMtime);
}

/** Parse one log into events, skipping any line that is not valid JSON. */
export function readSessionEvents(logPath) {
  const text = decodeZstdFrames(readFileSync(logPath));
  const events = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/**
 * Fold a session log into per-model token counts.
 *
 * Usage lives on `assistant/message` events as
 * `data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
 * The model is `data.message.source.model`, e.g. `deepseek/deepseek-v4.1-flash`.
 * It is read per message rather than per session because a session can switch
 * models mid-flight, and each call has to be attributed to the model that
 * actually served it.
 *
 * `inputTokens` already excludes cached tokens: it is the cache-miss count, with
 * `cacheReadTokens` reported separately.
 *
 * Assistant messages are deduplicated by `message.id`. A resumed or compacted
 * session can replay messages that are already in the log, and counting a
 * replay twice inflates the token sum with no visible symptom other than a
 * footprint larger than the work. claude-carbon found roughly 3x inflation from
 * this; across the logs read while writing this, no session had a repeat, so
 * `duplicates` is reported rather than silently absorbed — a non-zero value
 * means the logs are not what this parser assumes.
 */
export function foldSession(events) {
  const header = events.find((event) => event.type === 'session') ?? {};
  const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null;
  const byModel = new Map();
  const seenMessages = new Set();
  let duplicates = 0;
  let firstUsageAt = null;
  let lastUsageAt = null;
  let turns = 0;
  let steps = 0;

  for (const event of events) {
    if (event.type === 'turn/start') turns += 1;
    if (event.type === 'step/start') steps += 1;
    if (event.type !== 'assistant/message') continue;

    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;

    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;

    const messageId = event.data?.message?.id;
    if (typeof messageId === 'string' && messageId !== '') {
      if (seenMessages.has(messageId)) {
        duplicates += 1;
        continue;
      }
      seenMessages.add(messageId);
    }

    const model = event.data?.message?.source?.model ?? 'unknown';

    let cell = byModel.get(model);
    if (cell === undefined) {
      cell = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      byModel.set(model, cell);
    }
    cell.input += Number.isFinite(input) ? input : 0;
    cell.output += Number.isFinite(output) ? output : 0;
    cell.cacheRead += Number.isFinite(cacheRead) ? cacheRead : 0;
    cell.cacheWrite += Number.isFinite(cacheWrite) ? cacheWrite : 0;
    cell.calls += 1;

    if (typeof event.time === 'number') {
      if (firstUsageAt === null || event.time < firstUsageAt) firstUsageAt = event.time;
      if (lastUsageAt === null || event.time > lastUsageAt) lastUsageAt = event.time;
    }
  }

  return {
    id: header.id ?? null,
    createdAt,
    cwd: header.cwd ?? null,
    workspace: header.workspace ?? null,
    turns,
    steps,
    duplicates,
    byModel: [...byModel.values()].sort((a, b) => b.output - a.output),
    firstUsageAt,
    lastUsageAt,
  };
}
