import type { Session, SessionStatus, Todo } from './types/sessions.js';
import type { AnyMessageWithParts } from './types/messages.js';
import type { Part } from './types/parts.js';
import type { OpenCodeEvent } from './types/events.js';
import { PiSession } from './pi-session.js';
import { newSessionID, newMessageID, newPartID, importedSessionID } from './id.js';
import { SessionStore, type PersistedSession } from './storage.js';
import { getDefaultModelRef } from './pi-models.js';
import { getAgent } from './pi-agents.js';
import { AsyncQueue } from './queue.js';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { getProjectId } from './project.js';
import { titleFromUserText } from './title-gen.js';
export { titleFromUserText } from './title-gen.js';
import { discoverPiSessions, parsePiSessionMessages } from './pi-discovery.js';

export interface PendingPermission {
  tool: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  piRequestId: string;
  permission: string;
  always: boolean;
}

export interface PendingQuestion {
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
  piRequestId: string;
}

export interface ManagedSession {
  id: string;
  opencodeSession: Session;
  piSession: PiSession;
  status: SessionStatus;
  messages: Map<string, AnyMessageWithParts>;
  todos: Todo[];
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  currentMessageId: string | null;
  currentParts: Map<string, Part>;
  workingDir: string;
  agent: string;
  model: { providerID: string; modelID: string };
  piSessionId?: string;
  adapter?: any;
  /** Once set (user rename or auto-title), don't overwrite */
  titleLocked?: boolean;
  /** Heuristic title applied; LLM title may still upgrade once */
  llmTitleDone?: boolean;
  /** Files touched by edit/write tools this session (for /diff) */
  touchedFiles?: Set<string>;
}

const SLUG_LEFT = [
  'jolly', 'curious', 'silent', 'quick', 'brave', 'calm', 'bright', 'clever',
  'gentle', 'lucky', 'noble', 'proud', 'rapid', 'steady', 'vivid', 'witty',
];
const SLUG_RIGHT = [
  'rocket', 'pixel', 'wolf', 'tiger', 'meadow', 'cactus', 'harbor', 'comet',
  'falcon', 'orchid', 'river', 'summit', 'ember', 'nova', 'cedar', 'prism',
];

function randomSessionSlug(): string {
  const a = SLUG_LEFT[Math.floor(Math.random() * SLUG_LEFT.length)];
  const b = SLUG_RIGHT[Math.floor(Math.random() * SLUG_RIGHT.length)];
  return `${a}-${b}`;
}

export class ServerState {
  sessions = new Map<string, ManagedSession>();
  eventSubscribers = new Set<(event: OpenCodeEvent) => void>();
  workingDir: string;
  store: SessionStore;
  /** Per-session prompt queue — only one prompt runs at a time */
  promptQueue = new AsyncQueue();
  /** Where Pi stores its own session jsonl files for resume */
  piSessionDir: string;

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
    this.store = new SessionStore();
    this.piSessionDir = join(homedir(), '.pi-opencode-bridge', 'pi-sessions');
    mkdirSync(this.piSessionDir, { recursive: true });
  }

  piOptionsFor(agent: string, model: { providerID: string; modelID: string }) {
    const agentDef = getAgent(agent);
    return {
      tools: agentDef?.tools,
      model: { provider: model.providerID, id: model.modelID },
      sessionDir: this.piSessionDir,
      ephemeral: process.env.PI_EPHEMERAL === '1',
    };
  }

  subscribe(fn: (event: OpenCodeEvent) => void): () => void {
    this.eventSubscribers.add(fn);
    return () => this.eventSubscribers.delete(fn);
  }

  broadcast(event: OpenCodeEvent): void {
    for (const sub of this.eventSubscribers) {
      try {
        sub(event);
      } catch (err) {
        console.error('[state] subscriber error:', err);
      }
    }
  }

  createSession(opts: {
    id?: string;
    piSessionId?: string;
    title?: string;
    parentID?: string;
    projectID?: string;
    directory?: string;
    agent?: string;
  } = {}): ManagedSession {
    const id = opts.id || newSessionID();
    const now = Date.now();
    const directory = opts.directory || this.workingDir;
    const agent = opts.agent || 'build';
    const model = getDefaultModelRef();
    // Match OpenCode: projectID = git root commit (or .git/opencode), not always "global"
    const project = getProjectId(directory);
    const projectID = opts.projectID || project.id;

    const opencodeSession: Session = {
      id,
      slug: randomSessionSlug(),
      projectID,
      directory,
      title: opts.title || 'New session',
      version: '1.1.61',
      time: { created: now, updated: now },
      ...(opts.parentID ? { parentID: opts.parentID } : {}),
    };

    const piSessionId = opts.piSessionId || id;
    const piSession = new PiSession(piSessionId, directory, this.piOptionsFor(agent, model));
    const managed: ManagedSession = {
      id,
      opencodeSession,
      piSession,
      status: { type: 'idle' },
      messages: new Map(),
      todos: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      currentMessageId: null,
      currentParts: new Map(),
      workingDir: directory,
      agent,
      model,
      ...(opts.piSessionId ? { piSessionId } : {}),
      // Only lock if caller gave a real custom title (not the default placeholder)
      titleLocked: Boolean(
        opts.title &&
        !/^new session\b/i.test(opts.title.trim()) &&
        opts.title.trim() !== 'New Session'
      ),
      llmTitleDone: Boolean(
        opts.title &&
        !/^new session\b/i.test(opts.title.trim()) &&
        opts.title.trim() !== 'New Session'
      ),
      touchedFiles: new Set<string>(),
    };

    this.sessions.set(id, managed);
    this.persist(managed);
    return managed;
  }

  /**
   * Fast title from first user message (instant UI).
   * LLM may refine once via applyLlmTitle after the first reply.
   */
  maybeAutoTitle(session: ManagedSession, userText: string): boolean {
    if (session.llmTitleDone) return false;
    const current = (session.opencodeSession.title || '').trim();
    const isDefault =
      !current ||
      /^new session\b/i.test(current) ||
      current === 'New Session';
    if (!isDefault) return false;

    const title = titleFromUserText(userText);
    if (!title) return false;

    session.opencodeSession.title = title;
    session.opencodeSession.time.updated = Date.now();
    this.persist(session);
    this.broadcast({
      type: 'session.updated',
      properties: { info: this.publicSession(session.opencodeSession) } as any,
    });
    return true;
  }

  /** Load a persisted session into memory (without starting Pi yet) */
  hydrateSession(data: PersistedSession): ManagedSession {
    const existing = this.sessions.get(data.opencodeSession.id);
    if (existing) return existing;

    const agent = data.agent || 'build';
    const model = data.model || getDefaultModelRef();
    // Same session-id + session-dir → Pi resumes prior conversation context
    const piSessionId = data.piSessionId || data.opencodeSession.id;
    const piSession = new PiSession(
      piSessionId,
      data.opencodeSession.directory,
      this.piOptionsFor(agent, model),
    );
    const messages = new Map<string, AnyMessageWithParts>();
    for (const msg of data.messages) {
      messages.set(msg.info.id, msg);
    }

    const title = (data.opencodeSession.title || '').trim();
    const inferredTitleLocked = Boolean(title && !/^new session\b/i.test(title) && title !== 'New Session');
    const titleLocked = data.titleLocked ?? inferredTitleLocked;

    const managed: ManagedSession = {
      id: data.opencodeSession.id,
      opencodeSession: data.opencodeSession,
      piSession,
      status: { type: 'idle' },
      messages,
      todos: (data.todos || []) as Todo[],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      currentMessageId: null,
      currentParts: new Map(),
      workingDir: data.opencodeSession.directory,
      agent,
      model,
      ...(data.piSessionId ? { piSessionId } : {}),
      titleLocked,
      llmTitleDone: data.llmTitleDone ?? titleLocked,
      touchedFiles: new Set<string>(),
    };

    this.sessions.set(managed.id, managed);
    return managed;
  }

  trackTouchedFile(sessionId: string, filePath: string | undefined | null): void {
    if (!filePath || typeof filePath !== 'string') return;
    const session = this.getSession(sessionId);
    if (!session) return;
    if (!session.touchedFiles) session.touchedFiles = new Set();
    // normalize relative-ish paths
    const cleaned = filePath.replace(/^\.\//, '').trim();
    if (!cleaned || cleaned.length > 500) return;
    session.touchedFiles.add(cleaned);
  }

  async applyLlmTitle(sessionId: string, userText: string, assistantText?: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session || session.llmTitleDone) return;
    // Manual renames lock both flags
    if (session.titleLocked) return;
    session.llmTitleDone = true;
    try {
      const { generateSessionTitle } = await import('./title-gen.js');
      const title = await generateSessionTitle({
        userText,
        assistantText,
        model: session.model,
      });
      if (!title) return;
      session.opencodeSession.title = title;
      session.opencodeSession.time.updated = Date.now();
      this.persist(session);
      this.broadcast({
        type: 'session.updated',
        properties: { info: this.publicSession(session.opencodeSession) } as any,
      });
      console.log(`[state] llm title session=${sessionId} → ${title}`);
    } catch (err) {
      console.warn('[state] llm title failed:', err);
    }
  }

  getSession(id: string): ManagedSession | undefined {
    // Decode in case client double-encodes
    let sid = id;
    try { sid = decodeURIComponent(id); } catch { /* keep */ }

    const live = this.sessions.get(sid);
    if (live) return live;
    const stored = this.store.load(sid);
    if (stored) return this.hydrateSession(stored);

    // Shadow session from Pi discovery — import on first access
    if (this.shadowPiSessionIds.has(sid)) {
      return this.importShadowSession(sid);
    }

    // Fallback: case-insensitive match (defensive against client mangling)
    const lower = sid.toLowerCase();
    for (const [k, v] of this.sessions) {
      if (k.toLowerCase() === lower) return v;
    }
    for (const s of this.store.list()) {
      if (s.opencodeSession.id.toLowerCase() === lower) {
        return this.hydrateSession(s);
      }
    }
    return undefined;
  }

  /** Import a shadow Pi session into a full bridge session */
  private importShadowSession(shadowId: string): ManagedSession | undefined {
    const shadow = this.shadowSessions.get(shadowId);
    const piSessionId = this.shadowPiSessionIds.get(shadowId);
    if (!shadow || !piSessionId) return undefined;

    // Create a proper bridge session that links to the Pi session
    const managed = this.createSession({
      id: shadowId,
      piSessionId,
      title: 'New session',
      directory: shadow.directory,
    });

    // Override the ID to match the shadow ID so desktop doesn't get confused
    // Actually — keep the new bridge ID but mark the Pi session ID for resume
    managed.opencodeSession.title = shadow.title;
    managed.opencodeSession.time = shadow.time;

    // Imported titles are heuristics; allow the next completed prompt to refine them.
    managed.titleLocked = false;
    managed.llmTitleDone = false;

    // Remove from shadow map (it's now a real session)
    this.shadowSessions.delete(shadowId);
    this.shadowPiSessionIds.delete(shadowId);

    // Update the session ID to use the Pi session ID for Pi resume
    // Bridge keeps its own ID, but PiSession uses the Pi UUID
    managed.piSession.sessionId = piSessionId;

    const messages = this.shadowMessages.get(shadowId) || [];
    this.shadowMessages.delete(shadowId);
    for (const msg of messages) {
      managed.messages.set(msg.info.id, msg as any);
      if (msg.info.role === 'assistant') managed.currentMessageId = msg.info.id;
    }

    this.persist(managed);
    console.log(`[discovery] imported shadow session ${shadowId} → ${managed.id} (pi: ${piSessionId})`);

    return managed;
  }

  /** Load messages from Pi JSONL into a managed session */
  private async loadPiMessages(session: ManagedSession, piSessionId: string): Promise<void> {
    try {
      const { readFileSync } = await import('node:fs');
      const { join: joinPath } = await import('node:path');
      const { homedir: home } = await import('node:os');

      // Try bridge pi-sessions first (flat)
      const bridgeDir = joinPath(home(), '.pi-opencode-bridge', 'pi-sessions');
      let jsonlPath: string | null = null;

      // Check bridge dir
      try {
        const files = await import('node:fs/promises').then(m => m.readdir(bridgeDir));
        for (const f of files) {
          if (f.includes(piSessionId)) {
            jsonlPath = joinPath(bridgeDir, f);
            break;
          }
        }
      } catch { /* */ }

      // Check Pi native dir
      if (!jsonlPath) {
        const nativeBase = joinPath(home(), '.pi', 'agent', 'sessions');
        try {
          const dirs = await import('node:fs/promises').then(m => m.readdir(nativeBase));
          for (const dir of dirs) {
            const subdir = joinPath(nativeBase, dir);
            try {
              const files = await import('node:fs/promises').then(m => m.readdir(subdir));
              for (const f of files) {
                if (f.endsWith('.jsonl') && f.includes(piSessionId)) {
                  jsonlPath = joinPath(subdir, f);
                  break;
                }
              }
            } catch { /* */ }
            if (jsonlPath) break;
          }
        } catch { /* */ }
      }

      if (!jsonlPath) return;

      const messages = await parsePiSessionMessages(jsonlPath, session.id);
      for (const msg of messages) {
        session.messages.set(msg.info.id, msg as any);
      }
      console.log(`[discovery] loaded ${messages.length} messages from Pi JSONL for ${session.id}`);
      this.persist(session);
    } catch (err) {
      console.warn('[discovery] loadPiMessages error:', err);
    }
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id) || this.getSession(id);
    if (!session) {
      this.store.delete(id);
      return false;
    }
    session.piSession.kill();
    if (session.adapter) {
      try { session.adapter.cleanup(); } catch {}
    }
    this.sessions.delete(id);
    this.store.delete(id);
    return true;
  }

  listSessions(directory?: string): Session[] {
    // Merge live + persisted. Desktop loads sessions by project.worktree path.
    const byId = new Map<string, Session>();
    const norm = (p?: string) => (p || '').replace(/\/+$/, '') || '/';
    const want = directory ? norm(directory) : undefined;
    let projectID: string | undefined;
    if (directory) {
      try {
        const p = getProjectId(directory);
        if (p.id) projectID = p.id;
      } catch { /* ignore */ }
    }

    const matches = (s: Session) => {
      if (!want) return true;
      if (norm(s.directory) === want) return true;
      // Same project (git worktrees / repaired non-git ids)
      if (projectID && s.projectID === projectID) return true;
      return false;
    };

    for (const s of this.store.list()) {
      const sess = this.repairSessionProject(s.opencodeSession);
      if (!matches(sess)) continue;
      byId.set(sess.id, this.publicSession(sess));
    }

    for (const s of this.sessions.values()) {
      const sess = this.repairSessionProject(s.opencodeSession);
      s.opencodeSession = sess;
      if (!matches(sess)) continue;
      byId.set(s.id, this.publicSession(sess));
    }

    // Merge in shadow sessions from Pi discovery (cached)
    for (const s of this.shadowSessions.values()) {
      if (!matches(s)) continue;
      byId.set(s.id, this.publicSession(s));
    }

    return Array.from(byId.values()).sort((a, b) => b.time.updated - a.time.updated);
  }

  /** Shadow sessions discovered from Pi's native session files */
  private shadowSessions = new Map<string, Session>();
  private shadowPiSessionIds = new Map<string, string>();
  private shadowMessages = new Map<string, Array<{ info: any; parts: any[] }>>();
  private lastDiscoveryDir: string | undefined;
  private lastDiscoveryTime = 0;
  private static DISCOVERY_TTL = 10_000; // 10s cache

  /** Discover Pi-native sessions and create shadow entries */
  async discoverPiSessions(directory?: string): Promise<void> {
    const targetDirectory = directory ? resolve(directory) : undefined;
    // Cache: don't re-scan more than once per 10s per dir
    if (this.lastDiscoveryDir === (targetDirectory || '*') && Date.now() - this.lastDiscoveryTime < ServerState.DISCOVERY_TTL) {
      return;
    }
    this.lastDiscoveryDir = targetDirectory || '*';
    this.lastDiscoveryTime = Date.now();

    // Collect known Pi session IDs (bridge sessions store their Pi session ID)
    const known = new Set<string>();
    for (const s of this.store.list()) {
      const piId = s.piSessionId;
      if (piId) known.add(piId);
    }
    for (const s of this.sessions.values()) {
      known.add(s.piSessionId || s.id);
    }

    try {
      const discovered = await discoverPiSessions(targetDirectory, known);
      for (const piMeta of discovered) {
        const project = getProjectId(piMeta.cwd);
        const title = titleFromUserText(piMeta.firstUserMessage) || 'Imported Pi session';
        const shadowId = importedSessionID(piMeta.piSessionId);
        const shadow: Session = {
          id: shadowId,
          slug: `pi-${piMeta.piSessionId.slice(-8)}`,
          projectID: project.id,
          directory: piMeta.cwd,
          title,
          version: '1.1.61',
          time: { created: piMeta.created, updated: piMeta.updated },
        };
        this.shadowSessions.set(shadow.id, shadow);
        this.shadowPiSessionIds.set(shadow.id, piMeta.piSessionId);
        this.shadowMessages.set(
          shadow.id,
          await parsePiSessionMessages(piMeta.jsonlPath, shadow.id),
        );
      }
      if (discovered.length) {
        console.log(`[discovery] found ${discovered.length} Pi sessions for ${targetDirectory || '(all projects)'}`);
      }
    } catch (err) {
      console.warn('[discovery] error:', err);
    }
  }

  /** Omit nullish parentID — desktop treats roots as !parentID */
  publicSession(session: Session): Session {
    const out: Session = { ...session };
    if (out.parentID == null || out.parentID === '') {
      delete out.parentID;
    }
    return out;
  }

  /** Fix projectID/worktree mapping for older sessions (esp. non-git "global") */
  repairSessionProject(session: Session): Session {
    if (!session.directory) return session;
    try {
      const { id } = getProjectId(session.directory);
      if (!id || id === session.projectID) return session;
      const fixed = { ...session, projectID: id };
      const stored = this.store.load(session.id);
      if (stored) {
        stored.opencodeSession = fixed;
        this.store.save(stored);
      }
      const live = this.sessions.get(session.id);
      if (live) live.opencodeSession = fixed;
      return fixed;
    } catch { /* keep */ }
    return session;
  }

  /** Unique project rows for GET /project (desktop maps id → worktree) */
  listProjects(): Array<{
    id: string;
    worktree: string;
    sandboxes: string[];
    time: { created: number; updated: number };
    vcs?: string;
  }> {
    const byId = new Map<string, {
      id: string;
      worktree: string;
      sandboxes: string[];
      time: { created: number; updated: number };
      vcs?: string;
    }>();

    const addDir = (directory: string, created?: number, updated?: number) => {
      if (!directory) return;
      try {
        const p = getProjectId(directory);
        const existing = byId.get(p.id);
        if (existing) {
          existing.time.updated = Math.max(existing.time.updated, updated || Date.now());
          return;
        }
        byId.set(p.id, {
          id: p.id,
          worktree: p.worktree,
          sandboxes: [],
          time: {
            created: created || Date.now(),
            updated: updated || Date.now(),
          },
          ...(p.vcs ? { vcs: p.vcs } : {}),
        });
      } catch { /* ignore */ }
    };

    addDir(this.workingDir);
    for (const s of this.store.list()) {
      const sess = this.repairSessionProject(s.opencodeSession);
      addDir(sess.directory, sess.time.created, sess.time.updated);
    }
    for (const s of this.sessions.values()) {
      addDir(s.workingDir, s.opencodeSession.time.created, s.opencodeSession.time.updated);
    }
    return Array.from(byId.values());
  }

  persist(session: ManagedSession): void {
    session.opencodeSession.time.updated = Date.now();
    this.store.save({
      opencodeSession: session.opencodeSession,
      messages: Array.from(session.messages.values()),
      todos: session.todos,
      agent: session.agent,
      model: session.model,
      ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
      titleLocked: session.titleLocked,
      llmTitleDone: session.llmTitleDone,
    });
  }

  createUserMessage(
    sessionId: string,
    text: string,
    model: { providerID: string; modelID: string },
    agent?: string,
  ): { messageId: string; partId: string } {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const messageId = newMessageID();
    const partId = newPartID();
    const now = Date.now();
    const userMessage = {
      info: {
        id: messageId,
        sessionID: sessionId,
        agent: agent || session.agent || 'build',
        role: 'user' as const,
        time: { created: now },
        model: { providerID: model.providerID, modelID: model.modelID },
      },
      parts: [{
        id: partId,
        sessionID: sessionId,
        messageID: messageId,
        type: 'text' as const,
        text,
        time: { start: now },
      }],
    };
    session.messages.set(messageId, userMessage);
    this.persist(session);
    return { messageId, partId };
  }

  /** Find the latest user message id in a session (for assistant parentID). */
  lastUserMessageId(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const msgs = Array.from(session.messages.values());
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === 'user' && msgs[i].info.id) {
        return msgs[i].info.id;
      }
    }
    return undefined;
  }

  createAssistantMessage(sessionId: string, model: { providerID: string; modelID: string }): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const messageId = newMessageID();
    const now = Date.now();

    // parentID MUST be a real user message id — empty string makes desktop call fetchMessage("")
    const parentID = this.lastUserMessageId(sessionId);
    if (!parentID) {
      console.warn(`[state] creating assistant with no parent user message in ${sessionId}`);
    }

    const assistantMessage: AnyMessageWithParts = {
      info: {
        id: messageId,
        sessionID: sessionId,
        agent: session.agent || 'build',
        role: 'assistant' as const,
        // Never empty string — desktop treats "" as a real id and crashes
        parentID: parentID || messageId,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: session.agent || 'build',
        path: { cwd: session.workingDir, root: session.workingDir },
        time: { created: now },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      },
      parts: [],
    };
    session.messages.set(messageId, assistantMessage);
    session.currentMessageId = messageId;
    return messageId;
  }

  /** Repair messages with empty parentID / ids before returning to client */
  sanitizeMessages(sessionId: string): AnyMessageWithParts[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    let lastUserId: string | undefined;
    let dirty = false;
    const out: AnyMessageWithParts[] = [];

    for (const msg of session.messages.values()) {
      const info: any = { ...msg.info };

      // Drop empty parentID
      if (info.parentID === '' || info.parentID === null) {
        delete info.parentID;
        dirty = true;
      }

      if (info.role === 'user' && info.id) {
        lastUserId = info.id;
        // User messages should not have parentID
        if ('parentID' in info) {
          delete info.parentID;
          dirty = true;
        }
      }

      if (info.role === 'assistant') {
        // Fix missing/empty parent to last user
        if (!info.parentID && lastUserId) {
          info.parentID = lastUserId;
          dirty = true;
        }
      }

      // Ensure every part has messageID
      const parts = (msg.parts || []).map((p: any) => {
        if (!p.messageID && info.id) {
          dirty = true;
          return { ...p, messageID: info.id, sessionID: sessionId };
        }
        return p;
      });

      const fixed = { info, parts };
      out.push(fixed as AnyMessageWithParts);
      // Write back repairs
      session.messages.set(info.id, fixed as AnyMessageWithParts);
    }

    if (dirty) this.persist(session);
    return out;
  }

  addPartToCurrentMessage(sessionId: string, part: Part): void {
    const session = this.getSession(sessionId);
    if (!session || !session.currentMessageId) return;
    const msg = session.messages.get(session.currentMessageId);
    if (msg) {
      msg.parts.push(part);
    }
    session.currentParts.set(part.id, part);
  }

  updatePart(sessionId: string, partId: string, updates: Partial<Part>): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const part = session.currentParts.get(partId);
    if (part) {
      Object.assign(part, updates);
    }
    for (const msg of session.messages.values()) {
      const idx = msg.parts.findIndex(p => p.id === partId);
      if (idx >= 0) {
        msg.parts[idx] = { ...msg.parts[idx], ...updates } as Part;
        break;
      }
    }
  }

  getMessages(sessionId: string): AnyMessageWithParts[] {
    return this.sanitizeMessages(sessionId);
  }
}
