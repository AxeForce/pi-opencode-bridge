import { resolve } from 'node:path';
import type { Context } from 'hono';

/**
 * OpenCode desktop/TUI pass the active project directory as:
 *  1. Header: x-opencode-directory
 *  2. Query:  ?directory=
 *  3. Body:   { directory }
 * Real opencode uses the header as the primary signal.
 */
export function getRequestDirectory(c: Context, fallback?: string): string {
  const header =
    c.req.header('x-opencode-directory') ||
    c.req.header('X-Opencode-Directory') ||
    c.req.header('x-directory');
  const query = c.req.query('directory') || c.req.query('dir');

  let raw = header || query || fallback || process.cwd();
  // Desktop sometimes sends the header already percent-encoded
  try {
    // Decode repeatedly until stable (handles double-encoding)
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(raw);
      if (next === raw) break;
      raw = next;
    }
  } catch { /* keep raw */ }
  return resolve(raw);
}

export async function getBodyDirectory(c: Context): Promise<string | undefined> {
  try {
    // Clone-safe: only call if content-type is json and body not yet consumed
    const ct = c.req.header('content-type') || '';
    if (!ct.includes('application/json')) return undefined;
    // Can't re-read body easily; callers should pass body.directory themselves
    return undefined;
  } catch {
    return undefined;
  }
}
