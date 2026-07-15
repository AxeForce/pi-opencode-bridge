import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
  before?: string;
  after?: string;
}

function runGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

export function findGitRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function getBranch(directory: string): string | null {
  const root = findGitRoot(directory);
  if (!root) return null;
  const r = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  const b = r.out.trim();
  return b && b !== 'HEAD' ? b : b || null;
}

function parseNumstat(line: string): { file: string; additions: number; deletions: number } | null {
  // additions\tdeletions\tpath  (binary: -\t-\tpath)
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [a, d, ...rest] = parts;
  const file = rest.join('\t');
  if (!file) return null;
  const additions = a === '-' ? 0 : parseInt(a, 10) || 0;
  const deletions = d === '-' ? 0 : parseInt(d, 10) || 0;
  return { file, additions, deletions };
}

function filePatch(root: string, file: string, staged: boolean): string {
  const args = staged
    ? ['diff', '--cached', '--', file]
    : ['diff', 'HEAD', '--', file];
  // For untracked, show as /dev/null diff via no-index is awkward; use empty before
  const r = runGit(root, args);
  if (r.ok && r.out.trim()) return r.out;
  // Untracked: invent a simple patch header + content preview
  try {
    const full = join(root, file);
    if (!existsSync(full)) return '';
    const content = readFileSync(full, 'utf-8');
    const lines = content.split('\n');
    const body = lines.slice(0, 200).map(l => `+${l}`).join('\n');
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${Math.min(lines.length, 200)} @@\n${body}\n`;
  } catch {
    return '';
  }
}

function classifyStatus(code: string): 'added' | 'deleted' | 'modified' {
  // porcelain XY codes
  if (code.includes('A') || code === '??') return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

/** OpenCode /file/status → FileDiff[] for dirty worktree */
export function getFileStatus(directory: string): FileDiff[] {
  const root = findGitRoot(directory);
  if (!root) return [];

  const status = runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall']);
  if (!status.ok && !status.out.trim()) return [];

  const byFile = new Map<string, FileDiff>();

  for (const line of status.out.split('\n')) {
    if (!line || line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    // renames: "R  old -> new"
    if (path.includes(' -> ')) path = path.split(' -> ').pop() || path;
    path = path.replace(/^"|"$/g, '');
    if (!path) continue;

    const statusKind = classifyStatus(code);
    const num = runGit(root, ['diff', '--numstat', 'HEAD', '--', path]);
    let additions = 0;
    let deletions = 0;
    if (num.ok) {
      for (const nl of num.out.split('\n')) {
        const p = parseNumstat(nl.trim());
        if (p && (p.file === path || path.endsWith(p.file))) {
          additions = p.additions;
          deletions = p.deletions;
        }
      }
    }
    if (statusKind === 'added' && additions === 0 && deletions === 0) {
      try {
        const content = readFileSync(join(root, path), 'utf-8');
        additions = content ? content.split('\n').length : 0;
      } catch { /* */ }
    }

    const patch = filePatch(root, path, code[0] !== ' ' && code[0] !== '?');
    byFile.set(path, {
      file: path,
      patch,
      additions,
      deletions,
      status: statusKind,
    });
  }

  return Array.from(byFile.values()).sort((a, b) => a.file.localeCompare(b.file));
}

/** Diff for specific files (session-touched), falling back to full worktree status */
export function getDiffsForFiles(directory: string, files?: string[]): FileDiff[] {
  const root = findGitRoot(directory);
  if (!root) return [];

  if (!files || files.length === 0) {
    return getFileStatus(directory);
  }

  const unique = [...new Set(files.map(f => f.replace(/^\.\//, '')).filter(Boolean))];
  const out: FileDiff[] = [];

  for (const file of unique) {
    // Resolve relative to root
    let rel = file;
    if (rel.startsWith('/')) {
      rel = relative(root, rel);
      if (rel.startsWith('..')) continue;
    }

    const num = runGit(root, ['diff', '--numstat', 'HEAD', '--', rel]);
    let additions = 0;
    let deletions = 0;
    let found = false;
    if (num.ok) {
      for (const nl of num.out.split('\n')) {
        const p = parseNumstat(nl.trim());
        if (p) {
          additions = p.additions;
          deletions = p.deletions;
          found = true;
        }
      }
    }

    const exists = existsSync(join(root, rel));
    const inHead = runGit(root, ['cat-file', '-e', `HEAD:${rel}`]);
    let status: FileDiff['status'] = 'modified';
    if (!inHead.ok && exists) {
      status = 'added';
      found = true;
      if (additions === 0) {
        try {
          additions = readFileSync(join(root, rel), 'utf-8').split('\n').length;
        } catch { /* */ }
      }
    } else if (inHead.ok && !exists) {
      status = 'deleted';
      found = true;
    }

    const patch = filePatch(root, rel, false);
    if (!found && !patch.trim()) continue;

    out.push({
      file: rel,
      patch,
      additions,
      deletions,
      status,
    });
  }

  return out;
}

export function summarizeDiffs(diffs: FileDiff[]): { additions: number; deletions: number; files: number } {
  return {
    additions: diffs.reduce((s, d) => s + d.additions, 0),
    deletions: diffs.reduce((s, d) => s + d.deletions, 0),
    files: diffs.length,
  };
}
