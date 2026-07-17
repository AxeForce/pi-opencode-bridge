import { Hono } from 'hono';
import type { ServerState } from '../state.js';
import { StreamAdapter } from '../stream-adapter.js';
import { getDefaultModelRef } from '../pi-models.js';
import { getRequestDirectory } from '../directory.js';
import { getDiffsForFiles, summarizeDiffs } from '../git.js';
import { generateSessionTitle, titleFromUserText } from '../title-gen.js';

export function createSessionRoutes(state: ServerState): Hono {
  const app = new Hono();

  // List sessions — honor x-opencode-directory header + ?directory=
  app.get('/', (c) => {
    const header = c.req.header('x-opencode-directory') || c.req.header('X-Opencode-Directory');
    const query = c.req.query('directory') || c.req.query('dir');
    const dir = header || query ? getRequestDirectory(c) : undefined;

    // Discover Pi-native sessions for this directory or all projects.
    void state.discoverPiSessions(dir);

    let sessions = state.listSessions(dir);

    // roots=true → only top-level sessions (no parentID), like real OpenCode
    if (c.req.query('roots') === 'true') {
      sessions = sessions.filter(s => s.parentID == null || s.parentID === '');
    }

    // search filter
    const search = c.req.query('search');
    if (search) {
      const q = search.toLowerCase();
      sessions = sessions.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.id || '').toLowerCase().includes(q),
      );
    }

    // limit
    const limit = parseInt(c.req.query('limit') || '0', 10);
    if (limit > 0) sessions = sessions.slice(0, limit);

    // order
    if (c.req.query('order') === 'asc') {
      sessions = sessions.sort((a, b) => a.time.updated - b.time.updated);
    } else {
      sessions = sessions.sort((a, b) => b.time.updated - a.time.updated);
    }

    // Never emit parentID:null — desktop root filter is !parentID
    sessions = sessions.map(s => {
      if (s.parentID != null && s.parentID !== '') return s;
      const { parentID: _p, ...rest } = s as any;
      return rest;
    });
    console.log(`[session] list directory=${dir || '(all)'} roots=${c.req.query('roots')} count=${sessions.length}`);
    return c.json(sessions);
  });

  // Get session status for all sessions
  app.get('/status', (c) => {
    const result: Record<string, any> = {};
    // Include live sessions
    for (const session of state.sessions.values()) {
      result[session.id] = session.status;
    }
    // Persisted-only sessions are idle
    for (const s of state.listSessions()) {
      if (!result[s.id]) result[s.id] = { type: 'idle' };
    }
    return c.json(result);
  });

  // Create session — honor x-opencode-directory (primary), body, query
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      parentID?: string;
      title?: string;
      directory?: string;
      agent?: string;
    };
    // Header wins (this is what OpenCode desktop sends)
    const directory = getRequestDirectory(c, body.directory || state.workingDir);

    console.log(`[session] create directory=${directory} header=${c.req.header('x-opencode-directory') || '(none)'}`);

    const managed = state.createSession({
      title: body.title || 'New session',
      parentID: body.parentID,
      directory,
      agent: body.agent || 'build',
    });

    const model = managed.model || getDefaultModelRef();
    const adapter = new StreamAdapter(state, managed, model);

    try {
      await adapter.start();
      managed.adapter = adapter;
    } catch (err) {
      console.error('[session] failed to start pi session:', err);
    }

    state.broadcast({
      type: 'session.created',
      properties: { info: managed.opencodeSession } as any,
    });
    state.broadcast({
      type: 'session.updated',
      properties: { info: managed.opencodeSession } as any,
    });

    return c.json(managed.opencodeSession);
  });

  // Get session
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    session.opencodeSession = state.repairSessionProject(session.opencodeSession);
    return c.json(state.publicSession(session.opencodeSession));
  });

  // Update session
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const body = await c.req.json() as { title?: string; time?: { archived?: number }; agent?: string };
    if (body.title !== undefined) {
      session.opencodeSession.title = body.title;
      session.titleLocked = true;
      session.llmTitleDone = true;
    }
    if (body.time?.archived !== undefined) {
      session.opencodeSession.time.archived = body.time.archived;
    }
    if (body.agent !== undefined) {
      session.agent = body.agent;
    }
    session.opencodeSession.time.updated = Date.now();
    state.persist(session);

    state.broadcast({
      type: 'session.updated',
      properties: { info: session.opencodeSession } as any,
    });

    return c.json(session.opencodeSession);
  });

  // Delete session
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const adapter = session.adapter as StreamAdapter | undefined;
    if (adapter) adapter.cleanup();

    state.broadcast({
      type: 'session.deleted',
      properties: { info: session.opencodeSession } as any,
    });

    state.deleteSession(id);
    return c.json(true);
  });

  // Abort session
  app.post('/:id/abort', async (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const adapter = session.adapter as StreamAdapter | undefined;
    if (adapter) {
      try { await adapter.abort(); } catch (err) {
        console.error('[session] abort error:', err);
      }
    }
    return c.json(true);
  });

  // Fork session
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id');
    const source = state.getSession(id);
    if (!source) return c.json({ error: 'Session not found' }, 404);

    const managed = state.createSession({
      title: `${source.opencodeSession.title} (fork)`,
      parentID: id,
      directory: source.workingDir,
      agent: source.agent,
    });

    // Copy messages into the fork
    for (const msg of source.messages.values()) {
      managed.messages.set(msg.info.id, JSON.parse(JSON.stringify(msg)));
    }
    state.persist(managed);

    const model = managed.model;
    const adapter = new StreamAdapter(state, managed, model);
    try {
      await adapter.start();
      managed.adapter = adapter;
    } catch (err) {
      console.error('[session] fork pi start error:', err);
    }

    state.broadcast({
      type: 'session.created',
      properties: { info: managed.opencodeSession } as any,
    });

    return c.json(managed.opencodeSession);
  });

  // Share session
  app.post('/:id/share', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    session.opencodeSession.share = { url: `http://localhost:4096/share/${id}` };
    state.persist(session);
    return c.json(session.opencodeSession);
  });

  // Unshare session
  app.delete('/:id/share', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    delete session.opencodeSession.share;
    state.persist(session);
    return c.json(session.opencodeSession);
  });

  // Children sessions
  app.get('/:id/children', (c) => {
    const id = c.req.param('id');
    const children = state.listSessions().filter(s => s.parentID === id);
    return c.json(children);
  });

  // Todos
  app.get('/:id/todo', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json([]);
    return c.json(session.todos);
  });

  // Diff
  app.get('/:id/diff', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json([]);
    const files = session.touchedFiles ? Array.from(session.touchedFiles) : [];
    const diffs = getDiffsForFiles(session.workingDir, files.length ? files : undefined);
    // Keep session.summary in sync for desktop badges
    const summary = summarizeDiffs(diffs);
    (session.opencodeSession as any).summary = {
      additions: summary.additions,
      deletions: summary.deletions,
      files: summary.files,
    };
    state.broadcast({
      type: 'session.diff',
      properties: { sessionID: id, diff: diffs as any },
    });
    return c.json(diffs);
  });

  app.post('/:id/init', async (c) => c.json(true));

  // Generate / refresh session title via Pi one-shot
  app.post('/:id/summarize', async (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    let userText = '';
    let assistantText = '';
    for (const msg of session.messages.values()) {
      if (msg.info.role === 'user' && !userText) {
        userText = (msg.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('\n');
      }
      if (msg.info.role === 'assistant') {
        assistantText = (msg.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('\n');
      }
    }
    if (!userText) userText = session.opencodeSession.title || 'Conversation';

    // Force regenerate even if previously titled
    session.llmTitleDone = false;
    session.titleLocked = false;
    const generatedTitle = await generateSessionTitle({
      userText,
      assistantText,
    });
    const title = generatedTitle || titleFromUserText(userText) || 'Conversation';
    session.opencodeSession.title = title;
    session.opencodeSession.time.updated = Date.now();
    session.llmTitleDone = true;
    session.titleLocked = true;
    state.persist(session);
    state.broadcast({
      type: 'session.updated',
      properties: { info: state.publicSession(session.opencodeSession) } as any,
    });
    return c.json(true);
  });

  app.post('/:id/revert', async (c) => c.json(true));
  app.post('/:id/unrevert', async (c) => c.json(true));
  app.post('/:id/shell', async (c) => c.json({ info: { id: 'msg_' + Date.now(), role: 'assistant' }, parts: [] }));
  app.post('/:id/command', async (c) => c.json({ info: { id: 'msg_' + Date.now(), role: 'user' }, parts: [] }));

  // Permissions
  app.get('/:id/permissions', (c) => {
    const id = c.req.param('id');
    const session = state.getSession(id);
    if (!session) return c.json([]);
    return c.json(Array.from(session.pendingPermissions.entries()).map(([pid, perm]) => ({
      id: pid,
      sessionID: session.id,
      tool: perm.tool,
      patterns: perm.patterns,
      permission: perm.permission,
      always: perm.always,
      metadata: perm.metadata,
    })));
  });

  app.post('/:id/permissions/:permissionID', async (c) => {
    const permId = c.req.param('permissionID');
    const sessionId = c.req.param('id');
    const session = state.getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const body = await c.req.json() as { response?: 'once' | 'always' | 'reject'; reply?: 'once' | 'always' | 'reject' };
    const reply = body.response || body.reply || 'once';

    const adapter = session.adapter as StreamAdapter | undefined;
    if (adapter) {
      adapter.respondToPermission(permId, reply);
    } else {
      // No live adapter — just clear
      session.pendingPermissions.delete(permId);
      state.broadcast({
        type: 'permission.replied',
        properties: { sessionID: sessionId, requestID: permId, reply },
      });
    }

    return c.json(true);
  });

  return app;
}
