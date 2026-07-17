import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';

const PROJECT_CACHE_TTL = 60_000;
const projectCache = new Map<string, {
  value: { id: string; worktree: string; vcs: string | null };
  expiresAt: number;
}>();

/**
 * Match OpenCode's Project.fromDirectory for git repos.
 *
 * For non-git directories, OpenCode uses id "global" + worktree "/".
 * That breaks OpenCode Desktop: it loads sessions via project.worktree,
 * so every non-git project lists directory="/" and shows an empty list.
 *
 * Bridge fix: give each non-git directory a stable project id and set
 * worktree to that directory so desktop session lists resolve correctly.
 */
export function getProjectId(directory: string): { id: string; worktree: string; vcs: string | null } {
  const dir = resolve(directory);
  const cached = projectCache.get(dir);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = resolveProjectId(dir);
  projectCache.set(dir, { value, expiresAt: Date.now() + PROJECT_CACHE_TTL });
  return value;
}

function resolveProjectId(dir: string): { id: string; worktree: string; vcs: string | null } {
  const gitDir = findGitDir(dir);
  if (!gitDir) {
    return {
      id: nonGitProjectId(dir),
      worktree: dir,
      vcs: null,
    };
  }

  const worktree = dirname(gitDir);
  const marker = join(gitDir, 'opencode');

  // Cached id
  try {
    if (existsSync(marker)) {
      const id = readFileSync(marker, 'utf-8').trim();
      if (id) return { id, worktree: resolveGitTopLevel(worktree) || worktree, vcs: 'git' };
    }
  } catch { /* continue */ }

  // First root commit(s), sorted — same as OpenCode
  try {
    const roots = execSync('git rev-list --max-parents=0 --all', {
      cwd: worktree,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .sort();
    const id = roots[0];
    if (id) {
      try { writeFileSync(marker, id); } catch { /* optional cache */ }
      return { id, worktree: resolveGitTopLevel(worktree) || worktree, vcs: 'git' };
    }
  } catch { /* fall through */ }

  return { id: 'global', worktree: worktree, vcs: 'git' };
}

/** Stable 40-hex id so non-git folders don't all collapse to worktree "/" */
export function nonGitProjectId(directory: string): string {
  return createHash('sha1').update(`opencode-bridge:non-git:${resolve(directory)}`).digest('hex');
}

function findGitDir(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 40; i++) {
    const candidate = join(cur, '.git');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolveGitTopLevel(cwd: string): string | null {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}
