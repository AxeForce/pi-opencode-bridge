import { Hono } from 'hono';
import type { ServerState } from '../state.js';
import { StreamAdapter } from '../stream-adapter.js';
import { getDefaultModelRef } from '../pi-models.js';
import { getAgent } from '../pi-agents.js';
import { newMessageID, newPartID } from '../id.js';
import type { AnyMessageWithParts } from '../types/messages.js';

type PromptResult =
  | { ok: true; message?: AnyMessageWithParts }
  | { ok: false; status: number; error: string };

function latestAssistantMessage(state: ServerState, sessionId: string): AnyMessageWithParts | undefined {
  const session = state.getSession(sessionId);
  if (!session) return undefined;

  if (session.currentMessageId) {
    const current = session.messages.get(session.currentMessageId);
    if (current?.info.role === 'assistant') return current;
  }

  return state.getMessages(sessionId).reverse().find(message => message.info.role === 'assistant');
}

async function ensureAdapter(state: ServerState, sessionId: string): Promise<StreamAdapter | null> {
  const session = state.getSession(sessionId);
  if (!session) return null;

  // Reuse live adapter if Pi process is still alive
  if (session.adapter && !session.piSession.dead) {
    return session.adapter as StreamAdapter;
  }

  // Dead process or first start — (re)create Pi with session-dir so history resumes
  if (session.adapter) {
    try { session.adapter.cleanup(); } catch { /* ignore */ }
    session.adapter = undefined;
  }

  // Recreate PiSession with persistence options (hydration may have old options)
  const model = session.model || getDefaultModelRef();
  const { PiSession } = await import('../pi-session.js');
  session.piSession = new PiSession(
    session.id,
    session.workingDir,
    state.piOptionsFor(session.agent || 'build', model),
  );

  const adapter = new StreamAdapter(state, session, model);
  try {
    await adapter.start();
    session.adapter = adapter;
    return adapter;
  } catch (err) {
    console.error('[message] failed to start pi for session:', err);
    return null;
  }
}

interface PromptBody {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: Record<string, boolean>;
  parts?: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

function extractText(parts: PromptBody['parts']): string {
  if (!parts || !Array.isArray(parts)) return '';
  return parts
    .filter(p => p.type === 'text')
    .map(p => p.text || '')
    .join('\n');
}

async function handlePrompt(
  state: ServerState,
  sessionId: string,
  body: PromptBody,
  mode: 'sync' | 'async',
): Promise<PromptResult> {

  const session = state.getSession(sessionId);
  if (!session) {
    console.error(`[message] session not found: ${sessionId}`);
    return { ok: false as const, status: 404, error: 'Session not found' };
  }

  // Every prompt uses the queue. The task stays queued until Pi emits agent_end,
  // so concurrent requests cannot become implicit follow-ups.
  const task = state.promptQueue.run(sessionId, async () => {
    const session = state.getSession(sessionId);
    if (!session) {
      console.error(`[message] session not found: ${sessionId}`);
      return { ok: false as const, status: 404, error: 'Session not found' };
    }

    const adapter = await ensureAdapter(state, sessionId);
    if (!adapter) {
      return { ok: false as const, status: 500, error: 'Session not initialized' };
    }

    const userText = extractText(body.parts);
    if (!userText) {
      return { ok: false as const, status: 400, error: 'No text in message' };
    }

    // Auto-title from first real user prompt (before agent prefix)
    state.maybeAutoTitle(session, userText);

    // Agent
    const agentName = body.agent || session.agent || 'build';
    if (body.agent) session.agent = body.agent;
    const agentDef = getAgent(agentName);
    let text = userText;
    if (agentDef?.promptPrefix && !text.startsWith('/')) {
      text = agentDef.promptPrefix + text;
    }

    // Model
    const model = body.model || session.model || getDefaultModelRef();
    session.model = model;
    if (body.model?.providerID && body.model?.modelID) {
      await adapter.setModel(body.model.providerID, body.model.modelID);
    }

    // Use client-supplied messageID if valid, else generate
    const userMsgId = (body.messageID && body.messageID.startsWith('msg'))
      ? body.messageID
      : newMessageID();
    const partId = newPartID();
    const now = Date.now();

    const userMessage = {
      info: {
        id: userMsgId,
        sessionID: sessionId,
        agent: agentName,
        role: 'user' as const,
        time: { created: now },
        model: { providerID: model.providerID, modelID: model.modelID },
      },
      parts: [{
        id: partId,
        sessionID: sessionId,
        messageID: userMsgId,
        type: 'text' as const,
        text,
        time: { start: now },
      }],
    };
    session.messages.set(userMsgId, userMessage);
    session.status = { type: 'busy' };
    state.persist(session);

    // Emit the same event sequence as real OpenCode
    state.broadcast({
      type: 'message.updated',
      properties: { info: userMessage.info } as any,
    });
    state.broadcast({
      type: 'message.part.updated',
      properties: { part: userMessage.parts[0] } as any,
    });
    state.broadcast({
      type: 'session.updated',
      properties: { info: session.opencodeSession } as any,
    });
    state.broadcast({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type: 'busy' } },
    });

    console.log(`[message] ${mode} prompt session=${sessionId} dir=${session.workingDir} model=${model.providerID}/${model.modelID} text=${text.slice(0, 80)}`);

    try {
      await adapter.sendPrompt(text);
      // Keep the queue occupied for the entire agent run, not just until the
      // RPC acceptance response arrives.
      await adapter.waitForIdle();
      if (mode === 'sync') {
        const message = latestAssistantMessage(state, sessionId);
        if (!message) {
          throw new Error('Pi produced no assistant message');
        }
        return { ok: true as const, message };
      }
    } catch (err: any) {
      console.error('[message] send to pi error:', err);
      session.status = { type: 'idle' };
      // Finalize orphan assistant if any
      const mid = session.currentMessageId;
      if (mid) {
        const msg = session.messages.get(mid);
        if (msg && msg.info.role === 'assistant' && !(msg.info as any).time?.completed) {
          (msg.info as any).time.completed = Date.now();
          (msg.info as any).finish = 'error';
          (msg.info as any).error = { name: 'SendError', message: String(err) };
          state.broadcast({ type: 'message.updated', properties: { info: msg.info } as any });
        }
      }
      state.broadcast({
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: { name: 'UnknownError', data: { message: String(err) } },
        } as any,
      });
      state.broadcast({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      });
      state.broadcast({
        type: 'session.idle',
        properties: { sessionID: sessionId },
      });
      state.persist(session);
      if (mode === 'sync') {
        return { ok: false as const, status: 500, error: String(err) };
      }
    }

    return { ok: true as const };
  });

  if (mode === 'async') {
    void task.then(result => {
      if (!result.ok) {
        console.error(`[message] async prompt failed session=${sessionId}: ${result.error}`);
      }
    });
    return { ok: true as const };
  }

  return task;
}

export function createMessageRoutes(state: ServerState): Hono {
  const app = new Hono();

  const listMessages = (c: any) => {
    const sessionId = c.req.param('id');
    const session = state.getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    // sanitizeMessages repairs empty parentID (desktop fetchMessage("") crash)
    const messages = state.getMessages(sessionId).filter(m => {
      const id = m?.info?.id;
      if (!id) {
        console.warn('[message] dropping message with empty id in', sessionId);
        return false;
      }
      return true;
    });
    const limit = parseInt(c.req.query('limit') || '0', 10);
    if (limit > 0 && messages.length > limit) {
      return c.json(messages.slice(-limit));
    }
    return c.json(messages);
  };

  // List messages — with and without trailing slash (desktop hits both)
  app.get('/:id/message', listMessages);
  app.get('/:id/message/', listMessages);

  // Get single message
  app.get('/:id/message/:messageID', (c) => {
    const sessionId = c.req.param('id');
    let messageId = c.req.param('messageID') || '';
    // Trailing-slash / empty id → treat as list
    if (!messageId || messageId === '/') {
      return listMessages(c);
    }
    try { messageId = decodeURIComponent(messageId); } catch { /* keep */ }

    const session = state.getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const msg = session.messages.get(messageId);
    if (!msg) {
      // Case-insensitive fallback
      for (const [k, v] of session.messages) {
        if (k.toLowerCase() === messageId.toLowerCase()) return c.json(v);
      }
      return c.json({ error: 'Message not found' }, 404);
    }
    return c.json(msg);
  });

  // Send message (sync) — wait for the completed assistant message
  app.post('/:id/message', async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as PromptBody;
    const result = await handlePrompt(state, sessionId, body, 'sync');
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    if (!result.message) return c.json({ error: 'No assistant message' }, 500);
    return c.json(result.message, 200);
  });

  // Send message async — desktop uses this
  app.post('/:id/prompt_async', async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as PromptBody;
    const result = await handlePrompt(state, sessionId, body, 'async');
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.body(null, 204);
  });

  // Delete message
  app.delete('/:id/message/:messageID', (c) => {
    const sessionId = c.req.param('id');
    const messageId = c.req.param('messageID');
    const session = state.getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    session.messages.delete(messageId);
    state.persist(session);
    state.broadcast({
      type: 'message.removed',
      properties: {
        sessionID: sessionId,
        messageID: messageId,
      },
    });
    return c.json(true);
  });

  // Delete part
  app.delete('/:id/message/:messageID/part/:partID', (c) => {
    const sessionId = c.req.param('id');
    const messageId = c.req.param('messageID');
    const partId = c.req.param('partID');
    const session = state.getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const msg = session.messages.get(messageId);
    if (msg) {
      msg.parts = msg.parts.filter(p => p.id !== partId);
      state.persist(session);
    }
    state.broadcast({
      type: 'message.part.removed',
      properties: {
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
      },
    });
    return c.json(true);
  });

  // Update part
  app.patch('/:id/message/:messageID/part/:partID', async (c) => {
    return c.json({ id: 'part_', type: 'text', text: '' });
  });

  return app;
}
