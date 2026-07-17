import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { timingSafeEqual } from 'node:crypto';
import { ServerState } from './state.js';
import { createGlobalRoutes } from './routes/global.js';
import { createSessionRoutes } from './routes/session.js';
import { createMessageRoutes } from './routes/message.js';
import { createFileRoutes } from './routes/file.js';
import { getPiModels, getPiSettings } from './pi-models.js';
import { getPiAgents } from './pi-agents.js';

const PORT = parseInt(process.env.OPENCODE_API_PORT || '4096');
const HOST = process.env.OPENCODE_API_HOST || '127.0.0.1';
const WORKING_DIR = process.env.PI_WORKING_DIR || process.cwd();
// Auth is OPT-IN via BRIDGE_PASSWORD so we don't pick up the user's OpenCode password
// and lock out the desktop app (which often doesn't send basic auth to custom servers).
const PASSWORD = process.env.BRIDGE_PASSWORD || '';
const ALLOW_REMOTE = process.env.OPENCODE_ALLOW_REMOTE === '1';

// --- Security: refuse non-loopback binds unless explicitly allowed ---
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!isLoopback && !ALLOW_REMOTE) {
  console.error(`[bridge] refusing to bind ${HOST}: set OPENCODE_ALLOW_REMOTE=1 to expose beyond localhost`);
  console.error(`[bridge] WARNING: without auth this would allow remote code execution via Pi tools`);
  process.exit(1);
}
if (!isLoopback) {
  console.warn(`[bridge] WARNING: listening on ${HOST} (remote). Set BRIDGE_PASSWORD for basic auth.`);
  if (!PASSWORD) {
    console.warn(`[bridge] WARNING: no BRIDGE_PASSWORD set — unauthenticated remote access!`);
  }
}

console.log(`[bridge] starting on ${HOST}:${PORT}`);
console.log(`[bridge] working directory: ${WORKING_DIR}`);

// Pre-warm Pi models/agents so first desktop request isn't 3s
try {
  const models = getPiModels();
  const settings = getPiSettings();
  const agents = getPiAgents();
  console.log(`[bridge] pi models: ${models.length} (default ${settings.defaultProvider}/${settings.defaultModel})`);
  console.log(`[bridge] pi agents: ${agents.map(a => a.name).join(', ')}`);
} catch (err) {
  console.error('[bridge] failed to pre-warm pi models:', err);
}

const state = new ServerState(WORKING_DIR);
void state.discoverPiSessions();

const app = new Hono();

app.use('*', logger());

// CORS: localhost only by default; * only when remote is explicitly allowed
const corsOrigin = isLoopback
  ? (origin: string) => {
      // Allow local desktop/web origins
      if (!origin) return 'http://127.0.0.1';
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
      if (origin.startsWith('oc://') || origin.startsWith('app://')) return origin;
      return 'http://127.0.0.1';
    }
  : '*';

app.use('*', cors({
  origin: corsOrigin as any,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'x-opencode-directory',
    'X-Opencode-Directory',
    'x-directory',
    'x-opencode-project',
  ],
  exposeHeaders: ['*'],
}));

// Optional HTTP basic auth — only when BRIDGE_PASSWORD is set
if (PASSWORD) {
  app.use('*', async (c, next) => {
    // Health always open for probes
    if (c.req.path === '/global/health' || c.req.path === '/') {
      return next();
    }
    const header = c.req.header('authorization') || '';
    if (!header.startsWith('Basic ')) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="opencode"' });
    }
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : '';
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      const expectedUser = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
      const userOk = user === expectedUser;
      const a = Buffer.from(pass);
      const b = Buffer.from(PASSWORD);
      const passOk = a.length === b.length && timingSafeEqual(a, b);
      if (!userOk || !passOk) {
        return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="opencode"' });
      }
    } catch {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="opencode"' });
    }
    return next();
  });
  console.log(`[bridge] basic auth enabled (user=${process.env.OPENCODE_SERVER_USERNAME || 'opencode'})`);
}

// Debug: log directory header on every request
app.use('*', async (c, next) => {
  const dir = c.req.header('x-opencode-directory') || c.req.query('directory');
  if (dir && (c.req.method === 'POST' || c.req.path.includes('session'))) {
    console.log(`[dir] ${c.req.method} ${c.req.path} x-opencode-directory=${c.req.header('x-opencode-directory') || '(none)'} query=${c.req.query('directory') || '(none)'}`);
  }
  await next();
});

// Mount routes
app.route('/', createGlobalRoutes(state));
app.route('/session', createSessionRoutes(state));
app.route('/session', createMessageRoutes(state));
// Desktop sometimes probes /api/session/* — mount same handlers under /api
app.route('/api/session', createSessionRoutes(state));
app.route('/api/session', createMessageRoutes(state));
app.route('/', createFileRoutes(state));

// Trailing-slash normalization for session message routes
app.get('/session/:id/message/', async (c) => {
  const id = c.req.param('id');
  const limit = c.req.query('limit');
  const messages = state.getMessages(id);
  const lim = parseInt(limit || '0', 10);
  return c.json(lim > 0 ? messages.slice(-lim) : messages);
});

// Catch-all for unknown GET API probes — return empty JSON not HTML/404
app.get('/api/*', (c) => c.json({}));

// OpenAPI spec stub
app.get('/doc', (c) => {
  return c.json({
    openapi: '3.1.0',
    info: { title: 'Pi-OpenCode Bridge', version: '0.1.0' },
    paths: {
      '/session': { get: {}, post: {} },
      '/session/{id}/message': { get: {}, post: {} },
      '/event': { get: {} },
      '/global/event': { get: {} },
      '/global/config': { get: {} },
      '/global/health': { get: {} },
      '/provider': { get: {} },
      '/config/providers': { get: {} },
    },
  });
});

// Root
app.get('/', (c) => {
  return c.json({
    name: 'Pi-OpenCode Bridge',
    version: '0.1.0',
    status: 'running',
    sessions: state.sessions.size,
    auth: Boolean(PASSWORD),
    host: HOST,
  });
});

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
}, (info) => {
  console.log(`[bridge] listening on http://${info.address}:${info.port}`);
  console.log(`[bridge] point your OpenCode client at: OPENCODE_API_URL=http://${info.address}:${info.port}`);
  console.log(`[bridge] pi sessions dir: ~/.pi-opencode-bridge/pi-sessions`);
});
