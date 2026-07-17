import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { titleFromUserText } from './title-gen.js';

export interface PiSessionMeta {
  piSessionId: string;
  cwd: string;
  created: number;
  updated: number;
  firstUserMessage: string;
  firstAssistantMessage: string;
  messageCount: number;
  jsonlPath: string;
}

function stableID(prefix: 'msg' | 'prt', value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 26);
  return `${prefix}_${digest}`;
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text || '')
    .join('\n');
}

function toolOutput(content: unknown): string {
  return textContent(content);
}

function mapToolName(name: string): string {
  const map: Record<string, string> = { find: 'glob', ls: 'list' };
  return map[name.toLowerCase()] || name;
}

const PI_AGENT_DIR = join(homedir(), '.pi', 'agent', 'sessions');
const PI_BRIDGE_DIR = join(homedir(), '.pi-opencode-bridge', 'pi-sessions');

function isoToEpoch(ts: string | undefined): number {
  if (!ts) return 0;
  try {
    return Date.parse(ts);
  } catch {
    return 0;
  }
}

/** Read a Pi JSONL session file and extract metadata from just the message lines */
async function readPiSessionMeta(filePath: string): Promise<PiSessionMeta | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let piSessionId = '';
  let cwd = '';
  let created = 0;
  let updated = 0;
  let messageCount = 0;
  let firstUserMessage = '';
  let firstAssistantMessage = '';

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const type = d.type;
    const ts = isoToEpoch(d.timestamp);

    if (type === 'session') {
      piSessionId = d.id || piSessionId;
      cwd = d.cwd || cwd;
      if (!created && ts) created = ts;
    } else if (type === 'message') {
      messageCount++;
      if (ts) updated = Math.max(updated, ts);
      const msg = d.message || {};
      const role = msg.role;
       if (role === 'user' && !firstUserMessage) {
         firstUserMessage = textContent(msg.content).replace(/\s+/g, ' ').slice(0, 300);
       }
       if (role === 'assistant' && !firstAssistantMessage) {
         firstAssistantMessage = textContent(msg.content).replace(/\s+/g, ' ').slice(0, 300);
       }
    }
  }

  if (!piSessionId || !cwd) return null;

  return {
    piSessionId,
    cwd: resolve(cwd),
    created: created || updated || Date.now(),
    updated: updated || created || Date.now(),
    firstUserMessage,
    firstAssistantMessage,
    messageCount,
    jsonlPath: filePath,
  };
}

/** Scan both Pi's native session dir and our bridge pi-sessions dir */
async function scanDir(dir: string): Promise<PiSessionMeta[]> {
  let entries: import('node:fs').Dirent[];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return [];
  }

  const results: PiSessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subdir = join(dir, entry.name);
    let files: string[];
    try {
      files = await readdir(subdir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const meta = await readPiSessionMeta(join(subdir, file));
      if (meta) results.push(meta);
    }
  }
  return results;
}

/** Scan flat dir for .jsonl files (bridge pi-sessions format) */
async function scanFlatDir(dir: string): Promise<PiSessionMeta[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const results: PiSessionMeta[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const meta = await readPiSessionMeta(join(dir, file));
    if (meta) results.push(meta);
  }
  return results;
}

/**
 * Discover Pi sessions for a specific directory.
 * Returns sessions that are NOT already tracked by the bridge.
 */
export async function discoverPiSessions(
  directory: string | undefined,
  knownPiSessionIds: Set<string>,
): Promise<PiSessionMeta[]> {
  const targetDir = directory ? resolve(directory) : undefined;
  const [native, bridge] = await Promise.all([
    scanDir(PI_AGENT_DIR),
    scanFlatDir(PI_BRIDGE_DIR),
  ]);

  const unique = new Map<string, PiSessionMeta>();
  for (const meta of [...native, ...bridge]) {
    if (targetDir && meta.cwd !== targetDir) continue;
    if (knownPiSessionIds.has(meta.piSessionId)) continue;
    const previous = unique.get(meta.piSessionId);
    if (!previous || meta.updated > previous.updated) unique.set(meta.piSessionId, meta);
  }
  return Array.from(unique.values()).sort((a, b) => b.updated - a.updated);
}

/**
 * Reconstruct OpenCode-format messages from a Pi JSONL file.
 * This is a simplified parser — enough to show history in the desktop.
 */
export async function parsePiSessionMessages(
  jsonlPath: string,
  sessionId: string,
): Promise<Array<{ info: any; parts: any[] }>> {
  let content: string;
  try {
    content = await readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const messages: Array<{ info: any; parts: any[] }> = [];
  const entryToMessageId = new Map<string, string>();
  const toolPartsByCallId = new Map<string, any>();
  let lastUserId: string | undefined;
  let currentProvider = 'unknown';
  let currentModel = 'unknown';

  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    if (d.type === 'model_change') {
      currentProvider = d.provider || currentProvider;
      currentModel = d.modelId || currentModel;
      continue;
    }
    if (d.type !== 'message') continue;
    const msg = d.message || {};
    const role = msg.role;
    const ts = isoToEpoch(d.timestamp) || Date.now();
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const entryKey = String(d.id || `line-${lineIndex}`);
    const msgId = stableID('msg', `${sessionId}:${entryKey}`);

    if (role === 'user') {
      const textParts = textContent(msg.content);
      if (!textParts) continue;

      entryToMessageId.set(entryKey, msgId);
      lastUserId = msgId;
      messages.push({
        info: {
          id: msgId,
          sessionID: sessionId,
          role: 'user',
          agent: 'build',
          model: { providerID: currentProvider, modelID: currentModel },
          time: { created: ts },
        },
        parts: [{
          id: stableID('prt', `${sessionId}:${entryKey}:0`),
          sessionID: sessionId,
          messageID: msgId,
          type: 'text',
          text: textParts,
          time: { start: ts },
        }],
      });
    } else if (role === 'toolResult') {
      const toolPart = toolPartsByCallId.get(msg.toolCallId);
      if (toolPart) {
        const output = toolOutput(msg.content);
        toolPart.state = {
          status: msg.isError ? 'error' : 'completed',
          input: toolPart.state.input,
          ...(msg.isError ? { error: output || 'Tool failed' } : {
            output,
            title: toolPart.tool,
            metadata: {},
          }),
          time: { start: toolPart.state.time.start, end: ts },
        };
      }
    } else if (role === 'assistant') {
      entryToMessageId.set(entryKey, msgId);
      const ocParts: any[] = [];

      for (const c of parts) {
        if (c?.type === 'thinking' && c.thinking) {
          ocParts.push({
            id: stableID('prt', `${sessionId}:${entryKey}:${ocParts.length}`),
            sessionID: sessionId,
            messageID: msgId,
            type: 'reasoning',
            text: c.thinking,
            time: { start: ts, end: ts },
          });
        } else if (c?.type === 'text' && c.text) {
          ocParts.push({
            id: stableID('prt', `${sessionId}:${entryKey}:${ocParts.length}`),
            sessionID: sessionId,
            messageID: msgId,
            type: 'text',
            text: c.text,
            time: { start: ts, end: ts },
          });
        } else if (c?.type === 'toolCall') {
          const callID = c.id || `${entryKey}-${ocParts.length}`;
          ocParts.push({
            id: stableID('prt', `${sessionId}:${entryKey}:${ocParts.length}`),
            sessionID: sessionId,
            messageID: msgId,
            type: 'tool',
            tool: mapToolName(c.name || 'unknown'),
            callID,
            state: {
              status: 'completed',
              input: c.arguments || {},
              output: '',
              title: mapToolName(c.name || 'unknown'),
              metadata: {},
              time: { start: ts, end: ts },
            },
          });
          toolPartsByCallId.set(callID, ocParts[ocParts.length - 1]);
        }
      }

      if (!ocParts.length) continue;

      const usage = msg.usage || {};
      messages.push({
        info: {
          id: msgId,
          sessionID: sessionId,
          role: 'assistant',
          agent: 'build',
           parentID: entryToMessageId.get(String(d.parentId || '')) || lastUserId || msgId,
           model: {
             providerID: msg.provider || currentProvider,
             modelID: msg.model || currentModel,
           },
          mode: 'build',
          time: { created: ts, completed: ts },
          tokens: {
            input: usage.input || 0,
            output: usage.output || 0,
            reasoning: usage.reasoning || 0,
            cache: { read: usage.cacheRead || 0, write: usage.cacheWrite || 0 },
          },
           cost: usage.cost?.total || 0,
           ...(msg.stopReason ? { finish: msg.stopReason === 'toolUse' ? 'tool-calls' : msg.stopReason } : {}),
        },
        parts: ocParts,
      });
    }
  }

  return messages;
}
