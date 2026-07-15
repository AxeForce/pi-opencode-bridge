import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage',
  'vendor', '.venv', 'venv', '__pycache__', '.cache', 'target', '.idea',
]);

const MAX_FILE_BYTES = 512_000;
const MAX_RESULTS = 100;
const MAX_DEPTH = 12;

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  if (r.status === 0) return r.stdout.trim() || null;
  return null;
}

/** Find files by name fragment */
export async function findFilesByName(root: string, query: string, limit = 50): Promise<string[]> {
  const q = query.toLowerCase();
  const rootAbs = resolve(root);

  const fd = which('fd') || which('fdfind');
  if (fd) {
    const r = spawnSync(fd, ['--type', 'f', '--hidden', '--exclude', '.git', query, rootAbs], {
      encoding: 'utf-8',
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout) {
      return r.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(p => relative(rootAbs, p) || p)
        .filter(p => p.toLowerCase().includes(q) || true)
        .slice(0, limit);
    }
  }

  const results: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || results.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.example') {
        if (entry.name !== '.' && entry.isDirectory()) continue;
      }
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.name.toLowerCase().includes(q)) {
        results.push(relative(rootAbs, full));
      }
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  };
  await walk(rootAbs, 0);
  return results.slice(0, limit);
}

export interface TextMatch {
  path: string;
  line_number: number;
  lines: string;
  absolute_offset: number;
  submatches: Array<{ match: { text: string }; start: number; end: number }>;
}

/** Content search — prefer ripgrep, then git grep, then walk */
export async function findInFiles(root: string, pattern: string, limit = MAX_RESULTS): Promise<TextMatch[]> {
  const rootAbs = resolve(root);
  if (!pattern) return [];

  const rg = which('rg');
  if (rg) {
    const r = spawnSync(
      rg,
      ['--json', '--max-count', '5', '--max-filesize', '512K', '-m', String(limit), '--', pattern, rootAbs],
      { encoding: 'utf-8', timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (r.status === 0 || (r.stdout && r.stdout.length > 0)) {
      const out: TextMatch[] = [];
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type !== 'match') continue;
          const path = relative(rootAbs, ev.data.path.text);
          const text = ev.data.lines.text.replace(/\n$/, '');
          const lineNumber = ev.data.line_number as number;
          const submatches = (ev.data.submatches || []).map((s: any) => ({
            match: { text: s.match.text },
            start: s.start,
            end: s.end,
          }));
          out.push({
            path,
            line_number: lineNumber,
            lines: text,
            absolute_offset: 0,
            submatches: submatches.length
              ? submatches
              : [{ match: { text: pattern }, start: Math.max(0, text.indexOf(pattern)), end: Math.max(pattern.length, text.indexOf(pattern) + pattern.length) }],
          });
          if (out.length >= limit) break;
        } catch { /* skip */ }
      }
      if (out.length) return out;
    }
  }

  // git grep if inside a repo
  const gg = spawnSync('git', ['-C', rootAbs, 'grep', '-nI', '-e', pattern, '--', '.'], {
    encoding: 'utf-8',
    timeout: 12000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (gg.status === 0 && gg.stdout) {
    const out: TextMatch[] = [];
    for (const line of gg.stdout.split('\n')) {
      if (!line) continue;
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const [, path, ln, text] = m;
      const idx = text.indexOf(pattern);
      out.push({
        path,
        line_number: parseInt(ln, 10),
        lines: text,
        absolute_offset: 0,
        submatches: [{
          match: { text: pattern },
          start: idx >= 0 ? idx : 0,
          end: idx >= 0 ? idx + pattern.length : pattern.length,
        }],
      });
      if (out.length >= limit) break;
    }
    if (out.length) return out;
  }

  // Fallback walk
  const out: TextMatch[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      try {
        const st = await stat(full);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        const content = await readFile(full, 'utf-8');
        if (content.includes('\0')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const idx = lines[i].indexOf(pattern);
          if (idx < 0) continue;
          out.push({
            path: relative(rootAbs, full),
            line_number: i + 1,
            lines: lines[i],
            absolute_offset: 0,
            submatches: [{ match: { text: pattern }, start: idx, end: idx + pattern.length }],
          });
          if (out.length >= limit) return;
        }
      } catch { /* skip */ }
    }
  };
  await walk(rootAbs, 0);
  return out;
}

/** Lightweight symbol search via regex heuristics */
export async function findSymbols(root: string, query: string, limit = 50): Promise<Array<{ name: string; kind: string; path: string; line: number }>> {
  if (!query) return [];
  const pattern = query;
  const matches = await findInFiles(root, pattern, limit * 3);
  const out: Array<{ name: string; kind: string; path: string; line: number }> = [];
  const re = new RegExp(
    String.raw`(?:(?:export\s+)?(?:async\s+)?function|class|def|interface|type|const|let|var|fn|struct|enum)\s+` +
    pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'i',
  );
  for (const m of matches) {
    if (re.test(m.lines) || m.lines.includes(query)) {
      let kind = 'symbol';
      if (/\bclass\b/.test(m.lines)) kind = 'class';
      else if (/\bfunction\b|\bdef\b|\bfn\b/.test(m.lines)) kind = 'function';
      else if (/\binterface\b|\btype\b/.test(m.lines)) kind = 'type';
      out.push({ name: query, kind, path: m.path, line: m.line_number });
      if (out.length >= limit) break;
    }
  }
  return out;
}
