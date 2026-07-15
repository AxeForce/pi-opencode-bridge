import { Hono } from 'hono';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ServerState } from '../state.js';
import { getRequestDirectory } from '../directory.js';
import { findFilesByName, findInFiles, findSymbols } from '../search.js';
import { getFileStatus } from '../git.js';

function getRoot(state: ServerState, c: any): string {
  try {
    return getRequestDirectory(c, state.workingDir);
  } catch {
    return state.workingDir;
  }
}

export function createFileRoutes(state: ServerState): Hono {
  const app = new Hono();

  // List directory
  app.get('/file', async (c) => {
    const root = getRoot(state, c);
    const path = c.req.query('path') || '.';
    const fullPath = resolve(root, path);

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const nodes = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: relative(root, join(fullPath, e.name)),
          type: e.isDirectory() ? 'directory' : 'file',
        }));
      return c.json(nodes);
    } catch {
      return c.json({ error: 'Directory not found' }, 404);
    }
  });

  // Read file content
  app.get('/file/content', async (c) => {
    const root = getRoot(state, c);
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'Path required' }, 400);

    const fullPath = resolve(root, path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      return c.json({
        path: path,
        content,
        mime: getMimeType(path),
      });
    } catch {
      return c.json({ error: 'File not found' }, 404);
    }
  });

  // Find files by name
  app.get('/find/file', async (c) => {
    const query = c.req.query('query') || c.req.query('q') || '';
    if (!query) return c.json([]);
    const root = getRoot(state, c);
    const results = await findFilesByName(root, query, 50);
    return c.json(results);
  });

  // Find text in files
  app.get('/find', async (c) => {
    const pattern = c.req.query('pattern') || c.req.query('query') || c.req.query('q') || '';
    if (!pattern) return c.json([]);
    const root = getRoot(state, c);
    const results = await findInFiles(root, pattern, 100);
    return c.json(results);
  });

  // Find symbols (heuristic)
  app.get('/find/symbol', async (c) => {
    const query = c.req.query('query') || c.req.query('q') || '';
    if (!query) return c.json([]);
    const root = getRoot(state, c);
    const results = await findSymbols(root, query, 50);
    return c.json(results);
  });

  // Git dirty status as FileDiff[]
  app.get('/file/status', (c) => {
    const root = getRoot(state, c);
    return c.json(getFileStatus(root));
  });

  return app;
}

function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    json: 'application/json',
    md: 'text/markdown',
    py: 'text/x-python',
    css: 'text/css',
    html: 'text/html',
    txt: 'text/plain',
  };
  return map[ext || ''] || 'text/plain';
}
