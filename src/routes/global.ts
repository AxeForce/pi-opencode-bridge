import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ServerState } from '../state.js';
import type { OpenCodeEvent } from '../types/events.js';
import {
  getPiModels,
  getPiSettings,
  getDefaultModelRef,
  buildProvidersResponse,
  buildProviderResponse,
} from '../pi-models.js';
import { getPiAgents } from '../pi-agents.js';
import { StreamAdapter } from '../stream-adapter.js';
import { getRequestDirectory } from '../directory.js';
import { getProjectId } from '../project.js';
import { getBranch } from '../git.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled)
const fixturesDir = join(__dirname, '../fixtures');

function loadFixture<T = unknown>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

const agentFixture = loadFixture('agent.json', []);
const commandFixture = loadFixture('command.json', []);
const skillFixture = loadFixture('skill.json', []);
const mcpFixture = loadFixture('mcp.json', {});
const pathFixture = loadFixture('path.json', {});
const projectCurrentFixture = loadFixture('project-current.json', {});

export function createGlobalRoutes(state: ServerState): Hono {
  const app = new Hono();

  // Instance SSE: data: {"type":"...","properties":{...}}
  app.get('/event', async (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'server.connected', properties: {} }),
      });

      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'server.heartbeat', properties: {} }),
          });
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);

      const unsubscribe = state.subscribe((event) => {
        // Instance bus: raw event, no payload wrapper
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      });

      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      while (!stream.aborted) {
        await stream.sleep(1000);
      }

      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Global SSE (what desktop uses):
  // data: {"directory":"...","payload":{"type":"...","properties":{...}}}
  app.get('/global/event', async (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({
          payload: { type: 'server.connected', properties: {} },
        }),
      });

      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              payload: { type: 'server.heartbeat', properties: {} },
            }),
          });
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);

      const unsubscribe = state.subscribe((event) => {
        // Attach directory when available on the event properties
        const props = (event as any).properties || {};
        const directory =
          props.info?.directory ||
          props.directory ||
          (props.sessionID && state.getSession(props.sessionID)?.workingDir) ||
          (props.part?.sessionID && state.getSession(props.part.sessionID)?.workingDir) ||
          undefined;

        const frame: Record<string, unknown> = { payload: event };
        if (directory) frame.directory = directory;

        stream.writeSSE({ data: JSON.stringify(frame) }).catch(() => {});
      });

      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      while (!stream.aborted) {
        await stream.sleep(1000);
      }

      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Health check
  app.get('/global/health', (c) => {
    return c.json({
      healthy: true,
      version: '1.1.61',
    });
  });

  // Project info — desktop resolves session lists via project.worktree.
  // Non-git: stable per-directory id + worktree=directory (not global+"/").
  // Git:     root-commit id + worktree=toplevel
  app.get('/project/current', (c) => {
    const dir = getRequestDirectory(c, state.workingDir);
    const project = getProjectId(dir);
    const body: any = {
      id: project.id,
      worktree: project.worktree,
      sandboxes: [],
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    };
    if (project.vcs) body.vcs = project.vcs;
    return c.json(body);
  });

  app.get('/project', (c) => {
    // Include every known project so desktop can map projectID → worktree
    return c.json(state.listProjects());
  });

  // Path info - honor x-opencode-directory + ?directory=
  app.get('/path', (c) => {
    const dir = getRequestDirectory(c, state.workingDir);
    const project = getProjectId(dir);
    return c.json({
      ...pathFixture,
      directory: dir,
      // For git: repo root; for non-git: the directory itself (never force "/")
      worktree: project.worktree,
      home: process.env.HOME || '',
      state: (pathFixture as any).state || '',
      config: (pathFixture as any).config || '',
    });
  });

  // VCS info
  app.get('/vcs', (c) => {
    const dir = getRequestDirectory(c, state.workingDir);
    return c.json({ branch: getBranch(dir) });
  });

  function buildConfig() {
    const settings = getPiSettings();
    const models = getPiModels();
    const modelKey = `${settings.defaultProvider}/${settings.defaultModel}`;
    // Build provider config map so desktop can resolve model metadata
    const provider: Record<string, any> = {};
    for (const m of models) {
      if (!provider[m.provider]) {
        provider[m.provider] = { models: {} };
      }
      provider[m.provider].models[m.id] = {
        name: m.name,
        reasoning: m.reasoning,
        limit: { context: m.contextWindow, output: m.maxTokens },
        variants: m.reasoning ? { high: {}, max: {} } : {},
      };
    }
    return {
      $schema: 'https://opencode.ai/config.json',
      disabled_providers: [],
      model: modelKey,
      small_model: modelKey,
      provider,
      mcp: mcpFixture,
      agent: {},
      mode: {},
      plugin: [],
      command: {},
    };
  }

  // Config - model from Pi settings
  app.get('/config', (c) => c.json(buildConfig()));
  app.patch('/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ ...buildConfig(), ...body });
  });

  // Global config - desktop hits this hard; 404 breaks the UI
  app.get('/global/config', (c) => c.json(buildConfig()));
  app.patch('/global/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ ...buildConfig(), ...body });
  });

  // Providers - REAL Pi models
  app.get('/provider', (c) => {
    const models = getPiModels();
    const settings = getPiSettings();
    return c.json(buildProviderResponse(models, settings));
  });

  app.get('/provider/auth', (c) => {
    return c.json({});
  });

  // Agents - Pi-backed (build/plan/explore + Pi prompts)
  app.get('/agent', (c) => {
    const agents = getPiAgents().map(a => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native,
      permission: a.permission || [],
      options: {},
    }));
    return c.json(agents.length ? agents : agentFixture);
  });

  // Config providers - REAL Pi models (what ModelTooltip needs)
  app.get('/config/providers', (c) => {
    const models = getPiModels();
    const settings = getPiSettings();
    return c.json(buildProvidersResponse(models, settings));
  });

  // Commands
  app.get('/command', (c) => {
    return c.json(commandFixture);
  });

  // Skills
  app.get('/skill', (c) => {
    return c.json(skillFixture);
  });

  // Tools
  app.get('/experimental/tool/ids', (c) => {
    return c.json({
      ids: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'list', 'task', 'todowrite', 'todoread', 'webfetch'],
    });
  });

  app.get('/experimental/tool', (c) => {
    return c.json({
      tools: [
        { id: 'read', description: 'Read a file', parameters: {} },
        { id: 'bash', description: 'Run a shell command', parameters: {} },
        { id: 'edit', description: 'Edit a file', parameters: {} },
        { id: 'write', description: 'Write a file', parameters: {} },
        { id: 'grep', description: 'Search for patterns in files', parameters: {} },
        { id: 'glob', description: 'Find files matching a pattern', parameters: {} },
        { id: 'list', description: 'List directory contents', parameters: {} },
      ],
    });
  });

  // MCP resources (desktop polls this)
  app.get('/experimental/resource', (c) => c.json({}));
  app.get('/experimental/session', (c) => {
    const sessions = state.listSessions();
    return c.json({ data: sessions, next: null });
  });

  // Desktop probes these; return empty JSON not 404
  app.get('/api/reference', (c) => c.json({}));
  app.get('/api/session', (c) => {
    // Desktop home uses v2.session.list → GET /api/session with cursor pagination:
    //   { data: SessionV2[], cursor: { next?: string } }
    // V2 sessions use location.directory (see toLegacySummary in desktop).
    const header = c.req.header('x-opencode-directory');
    const directory = c.req.query('directory') || (header ? getRequestDirectory(c) : undefined);
    const limit = parseInt(c.req.query('limit') || '100', 10);

    // Discover Pi-native sessions, including when the client asks for all projects.
    void state.discoverPiSessions(directory);

    let sessions = state.listSessions(directory);
    if (c.req.query('roots') === 'true') {
      sessions = sessions.filter(s => !s.parentID);
    }
    // Home index drops parent + archived
    sessions = sessions.filter(s => !s.parentID && typeof s.time.archived !== 'number');
    if (c.req.query('order') === 'asc') {
      sessions = sessions.sort((a, b) => a.time.updated - b.time.updated);
    } else {
      sessions = sessions.sort((a, b) => b.time.updated - a.time.updated);
    }

    const cursor = c.req.query('cursor');
    let start = 0;
    if (cursor) {
      const idx = sessions.findIndex(s => s.id === cursor);
      if (idx >= 0) start = idx + 1;
    }
    const page = sessions.slice(start, start + limit);
    const next = start + limit < sessions.length ? page[page.length - 1]?.id : undefined;

    const data = page.map(s => ({
      id: s.id,
      projectID: s.projectID,
      title: s.title,
      parentID: s.parentID,
      time: s.time,
      location: {
        directory: s.directory,
        workspaceID: s.projectID,
      },
      subpath: '',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      agent: 'build',
      model: null,
    }));

    console.log(`[api/session] directory=${directory || '(all)'} count=${data.length} total=${sessions.length}`);
    return c.json({
      data,
      cursor: next ? { next } : {},
    });
  });
  app.post('/api/session', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; directory?: string; agent?: string; parentID?: string };
    const directory = getRequestDirectory(c, body.directory || state.workingDir);
    const managed = state.createSession({
      title: body.title || 'New session',
      parentID: body.parentID,
      directory,
      agent: body.agent || 'build',
    });
    // Lazy-start Pi
    try {
      const { StreamAdapter: SA } = await import('../stream-adapter.js');
      const adapter = new SA(state, managed, managed.model);
      await adapter.start();
      managed.adapter = adapter;
    } catch (err) {
      console.error('[api/session] start failed', err);
    }
    state.broadcast({
      type: 'session.created',
      properties: { info: managed.opencodeSession } as any,
    });
    return c.json(managed.opencodeSession);
  });

  // LSP
  app.get('/lsp', (c) => c.json([]));
  app.get('/formatter', (c) => c.json([]));

  // MCP
  app.get('/mcp', (c) => c.json(mcpFixture));
  app.post('/mcp', async (c) => c.json({}));
  app.post('/mcp/:name/connect', (c) => c.json(true));
  app.post('/mcp/:name/disconnect', (c) => c.json(true));

  // Mode - empty array is fine (HTML was wrong)
  app.get('/mode', (c) => {
    return c.json([]);
  });

  // PTY
  app.get('/pty', (c) => c.json([]));
  app.get('/pty/shells', (c) => {
    // Real opencode returned error shape; empty list is safer
    return c.json([]);
  });
  app.post('/pty', async (c) => {
    return c.json({ id: 'pty_' + Date.now(), status: 'created' });
  });
  app.get('/pty/:id', (c) => c.json({ id: c.req.param('id') }));
  app.delete('/pty/:id', (c) => c.json(true));

  // Permission global — scan all sessions
  app.get('/permission', (c) => {
    const all: any[] = [];
    for (const session of state.sessions.values()) {
      for (const [id, perm] of session.pendingPermissions) {
        all.push({
          id,
          sessionID: session.id,
          tool: perm.tool,
          patterns: perm.patterns,
          permission: perm.permission,
          always: perm.always,
          metadata: perm.metadata,
        });
      }
    }
    return c.json(all);
  });

  app.post('/permission/:requestID/reply', async (c) => {
    const requestID = c.req.param('requestID');
    const body = await c.req.json() as { response?: 'once' | 'always' | 'reject'; reply?: 'once' | 'always' | 'reject' };
    const reply = body.response || body.reply || 'once';

    for (const session of state.sessions.values()) {
      if (session.pendingPermissions.has(requestID)) {
        const adapter = session.adapter as StreamAdapter | undefined;
        if (adapter) adapter.respondToPermission(requestID, reply);
        return c.json(true);
      }
    }
    return c.json(true);
  });

  // Question global
  app.get('/question', (c) => {
    const all: any[] = [];
    for (const session of state.sessions.values()) {
      for (const [id, q] of session.pendingQuestions) {
        all.push({ id, sessionID: session.id, questions: q.questions });
      }
    }
    return c.json(all);
  });

  app.post('/question/:requestID/reply', async (c) => {
    const requestID = c.req.param('requestID');
    const body = await c.req.json() as { answers?: string[][] };
    for (const session of state.sessions.values()) {
      if (session.pendingQuestions.has(requestID)) {
        const adapter = session.adapter as StreamAdapter | undefined;
        if (adapter) adapter.respondToQuestion(requestID, body.answers || []);
        return c.json(true);
      }
    }
    return c.json(true);
  });

  app.post('/question/:requestID/reject', async (c) => {
    const requestID = c.req.param('requestID');
    for (const session of state.sessions.values()) {
      if (session.pendingQuestions.has(requestID)) {
        const adapter = session.adapter as StreamAdapter | undefined;
        if (adapter) adapter.rejectQuestion(requestID);
        return c.json(true);
      }
    }
    return c.json(true);
  });

  // TUI stubs
  app.post('/tui/append-prompt', (c) => c.json(true));
  app.post('/tui/open-help', (c) => c.json(true));
  app.post('/tui/open-sessions', (c) => c.json(true));
  app.post('/tui/open-themes', (c) => c.json(true));
  app.post('/tui/open-models', (c) => c.json(true));
  app.post('/tui/submit-prompt', (c) => c.json(true));
  app.post('/tui/clear-prompt', (c) => c.json(true));
  app.post('/tui/execute-command', (c) => c.json(true));
  app.post('/tui/show-toast', (c) => c.json(true));
  app.post('/tui/select-session', (c) => c.json(true));
  app.post('/tui/publish', (c) => c.json(true));

  // Instance
  app.post('/instance/dispose', (c) => c.json(true));
  app.post('/global/dispose', (c) => c.json(true));

  // Log
  app.post('/log', (c) => c.json(true));

  // Auth
  app.put('/auth/:id', async (c) => c.json(true));
  app.delete('/auth/:id', async (c) => c.json(true));

  return app;
}
