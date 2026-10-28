/**
 * Third-party cross-checks.
 *
 * Loaded from `lib/factors/cross-checks.json` and returned by the methodology
 * route so the GUI can show them beside the factor table. They are deliberately
 * not part of `factors.json`: that file is generated and drives the arithmetic,
 * and a cross-check must never be mistaken for an input to it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, '..', 'factors', 'cross-checks.json');

export function loadCrossChecks(path = DEFAULT_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return {
    accessed: parsed.accessed ?? null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}
