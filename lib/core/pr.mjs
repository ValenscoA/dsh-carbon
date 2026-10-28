/**
 * The footprint of a pull request.
 *
 * This is the number reviewers never see: what it cost, in grams, to develop
 * the branch under review. claude-carbon gets per-branch attribution from a
 * `SubagentStop` hook that records the git branch as each session ends. DeepSeek
 * Harness does not record a branch in its session log, and this plugin is not
 * going to guess one from a transcript it only reads.
 *
 * So the attribution here is weaker *and says so*: sessions whose working
 * directory is inside this repository, since the point where the branch left
 * the default branch. That counts a session that ran on `main` at the same
 * time, and it misses commits old enough to have had their sessions pruned
 * before the store existed. The comment names both limits instead of reporting
 * a number that looks exact.
 *
 * Nothing is posted unless the command is run: no hook, no background job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
}

function gh(args, { input = null, cwd } = {}) {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      input: input ?? undefined,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim();
  } catch (error) {
    const detail = typeof error?.stderr === 'string' && error.stderr.trim() !== '' ? error.stderr.trim() : error?.message;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

/** The repository root for a directory, or null when it is not in one. */
export function repoRoot(cwd) {
  if (typeof cwd !== 'string' || cwd === '' || !existsSync(cwd)) return null;
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** Branch name and the commit that the branch would merge into. */
export function branchInfo(cwd) {
  const root = repoRoot(cwd);
  if (root === null) return null;
  let branch = null;
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    branch = null;
  }

  // The default branch is whatever origin points at; fall back to the two names
  // every repository uses when there is no remote.
  const candidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  let base = null;
  for (const candidate of candidates) {
    try {
      base = git(cwd, ['merge-base', 'HEAD', candidate]);
      break;
    } catch {
      // Try the next candidate.
    }
  }

  let baseAt = null;
  if (base !== null) {
    try {
      baseAt = Number(git(cwd, ['show', '-s', '--format=%ct', base])) * 1000;
    } catch {
      baseAt = null;
    }
  }

  let ahead = null;
  if (base !== null) {
    try {
      ahead = Number(git(cwd, ['rev-list', '--count', `${base}..HEAD`]));
    } catch {
      ahead = null;
    }
  }

  return { root, branch, base, baseAt, ahead };
}

/** Rows whose working directory is inside `root`. */
export function rowsInRepo(rows, root) {
  if (typeof root !== 'string') return [];
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return rows.filter((row) => {
    if (typeof row.cwd !== 'string') return false;
    const cwd = resolve(row.cwd);
    return cwd === root || cwd.startsWith(prefix);
  });
}

/**
 * The comment body.
 *
 * A hidden marker makes re-running the command update the same comment instead
 * of stacking a second one; GitHub keeps the marker out of the rendered text.
 */
export function prComment({
  grams,
  total,
  sessions,
  branch,
  base,
  since,
  repo,
  unverifiedSessions = 0,
  rangeDays = null,
}) {
  const kg = grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams.toFixed(0)} g`;
  const car = grams / 170;
  const lines = [];
  lines.push('<!-- dsh-carbon:pr -->');
  lines.push(`**DeepSeek Harness carbon report** · developing this branch`);
  lines.push('');
  lines.push(
    `${kg} CO₂e · $${total.cost.toFixed(2)} at API list prices · ${compact(total.tokens)} tokens · ${compact(total.cacheRead)} cache reads · ${sessions} session${sessions === 1 ? '' : 's'}`,
  );
  lines.push('');
  lines.push(
    `≈ ${car.toFixed(car >= 10 ? 0 : 1)} km by car. Estimated from token counts with factors from Jegham et al. 2025; an order of magnitude, not a measurement.`,
  );
  lines.push('');
  lines.push('<details><summary>How this was attributed</summary>');
  lines.push('');
  lines.push(
    `Sessions whose working directory is inside \`${repo}\`, counted from the point this branch left \`${base ?? 'the default branch'}\`${branch === null ? '' : ` (\`${branch}\`)`}${rangeDays === null ? '' : `, ${rangeDays} day window`}.`,
  );
  lines.push('');
  lines.push(
    'A branch is not recorded in a harness session log, so this is a repository-and-time attribution, not a per-branch one: it includes any session that ran in this repository in the same window, on any branch, and excludes work done before the branch point.',
  );
  if (unverifiedSessions > 0) {
    lines.push('');
    lines.push(
      `${unverifiedSessions} stored session${unverifiedSessions === 1 ? '' : 's'} no longer ${unverifiedSessions === 1 ? 'has' : 'have'} a session log on disk; ${unverifiedSessions === 1 ? 'it is' : 'they are'} included, since the store keeps the tokens.`,
    );
  }
  lines.push('');
  lines.push('_Generated by `dsh-carbon pr`. Nothing is posted unless that command is run._');
  lines.push('</details>');
  return lines.join('\n');
}

function compact(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

/** The open pull request for the current branch, or null. */
export function openPullRequest(cwd) {
  try {
    const raw = gh(['pr', 'view', '--json', 'number,url,state,title'], { cwd });
    const parsed = JSON.parse(raw);
    return parsed ?? null;
  } catch {
    return null;
  }
}

/**
 * Post (or update) the comment.
 *
 * `gh pr comment --edit-last` only edits a comment this user wrote, and it
 * edits the *last* one — which is the marker comment when the marker is present.
 * Trying the edit first keeps re-runs idempotent without a lookup API.
 */
export function postComment({ body, cwd, pr = null }) {
  const target = typeof pr === 'number' ? [String(pr)] : [];
  try {
    gh(['pr', 'comment', ...target, '--edit-last', '--body-file', '-'], { cwd, input: body });
    return { edited: true };
  } catch {
    gh(['pr', 'comment', ...target, '--body-file', '-'], { cwd, input: body });
    return { edited: false };
  }
}

export function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
