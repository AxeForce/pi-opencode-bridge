import type { PiSession } from './pi-session.js';
import type { ServerState, ManagedSession } from './state.js';
import type {
  PartUpdatedEvent,
  MessageUpdatedEvent,
  PartDeltaEvent,
  SessionStatusEvent,
  SessionIdleEvent,
} from './types/events.js';
import type {
  TextPart,
  ToolPart,
  ReasoningPart,
  StepStartPart,
  StepFinishPart,
  Part,
  ToolState,
} from './types/parts.js';
import { newPartID, newCallID } from './id.js';
import type { Tokens } from './types/common.js';

// Map Pi tool names to OpenCode tool names for UI rendering
function mapToolName(name: string): string {
  const map: Record<string, string> = {
    read: 'read',
    bash: 'bash',
    edit: 'edit',
    write: 'write',
    grep: 'grep',
    find: 'glob',
    ls: 'list',
  };
  return map[name.toLowerCase()] || name;
}

// Convert snake_case params to camelCase for OpenCode TUI
const PARAM_NAME_MAP: Record<string, string> = {
  path: 'filePath',
  file_path: 'filePath',
  old_string: 'oldString',
  new_string: 'newString',
  replace_all: 'replaceAll',
  line_hint: 'lineHint',
};

function convertParams(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const camelKey = PARAM_NAME_MAP[key] || key;
    result[camelKey] = value;
  }
  return result;
}

interface PiUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function emptyUsage(): PiUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Extract Pi usage from assistant message / turn_end / message_end payloads */
function extractPiUsage(source: any): PiUsage | null {
  if (!source) return null;
  const usage = source.usage || source.message?.usage || source.assistantMessage?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const costObj = usage.cost && typeof usage.cost === 'object' ? usage.cost : null;
  const cost =
    typeof usage.cost === 'number'
      ? usage.cost
      : typeof costObj?.total === 'number'
        ? costObj.total
        : 0;
  return {
    input: Number(usage.input || usage.inputTokens || 0) || 0,
    output: Number(usage.output || usage.outputTokens || 0) || 0,
    reasoning: Number(usage.reasoning || usage.reasoningTokens || 0) || 0,
    cacheRead: Number(usage.cacheRead || usage.cache_read || usage.cache?.read || 0) || 0,
    cacheWrite: Number(usage.cacheWrite || usage.cache_write || usage.cache?.write || 0) || 0,
    cost: Number(cost) || 0,
  };
}

function addUsage(a: PiUsage, b: PiUsage): PiUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

function toOpenCodeTokens(u: PiUsage): Tokens {
  return {
    input: u.input,
    output: u.output,
    reasoning: u.reasoning,
    cache: { read: u.cacheRead, write: u.cacheWrite },
  };
}

export class StreamAdapter {
  private state: ServerState;
  private session: ManagedSession;
  private pi: PiSession;
  private model: { providerID: string; modelID: string };
  private activeTextPart: TextPart | null = null;
  private activeReasoningPart: ReasoningPart | null = null;
  private activeToolParts = new Map<string, ToolPart>(); // toolCallId -> ToolPart
  private stepStartTime = 0;
  /** Real usage for the current LLM turn (from Pi) */
  private turnUsage: PiUsage = emptyUsage();
  /** Sum of turn usages for the whole agent run (multi-step tool loops) */
  private agentUsage: PiUsage = emptyUsage();
  private idleWaiters = new Set<{
    afterGeneration: number;
    resolve: () => void;
    timer: NodeJS.Timeout;
  }>();
  private runGeneration = 0;

  constructor(state: ServerState, session: ManagedSession, model: { providerID: string; modelID: string }) {
    this.state = state;
    this.session = session;
    this.pi = session.piSession;
    this.model = model;
  }

  async start(): Promise<void> {
    // Start the Pi subprocess (resumes prior session if session-dir is set)
    await this.pi.start();

    // Set the model from Pi settings / OpenCode selection
    try {
      await this.pi.setModel(this.model.providerID, this.model.modelID);
    } catch (err) {
      console.warn('[stream-adapter] setModel failed (using Pi default):', err);
    }

    // Subscribe to all relevant Pi events
    this.pi.on('message_update', (event: any) => this.onMessageUpdate(event));
    this.pi.on('message_end', (event: any) => this.onMessageEnd(event));
    this.pi.on('tool_execution_start', (event: any) => this.onToolStart(event));
    this.pi.on('tool_execution_update', (event: any) => this.onToolUpdate(event));
    this.pi.on('tool_execution_end', (event: any) => this.onToolEnd(event));
    this.pi.on('turn_start', (event: any) => this.onTurnStart(event));
    this.pi.on('turn_end', (event: any) => this.onTurnEnd(event));
    this.pi.on('agent_start', () => this.onAgentStart());
    this.pi.on('agent_end', (event: any) => this.onAgentEnd(event));
    this.pi.on('auto_retry_start', (event: any) => this.onAutoRetryStart(event));
    this.pi.on('auto_retry_end', () => this.onAutoRetryEnd());
    this.pi.on('compaction_start', () => this.onCompactionStart());
    this.pi.on('compaction_end', () => this.onCompactionEnd());
    this.pi.on('extension_ui_request', (event: any) => this.onExtensionUIRequest(event));
    this.pi.on('exit', (code: number) => this.onPiExit(code));
  }

  private applyUsageToMessage(msgId: string | null, usage: PiUsage): void {
    if (!msgId) return;
    const msg = this.session.messages.get(msgId);
    if (!msg || msg.info.role !== 'assistant') return;
    (msg.info as any).tokens = toOpenCodeTokens(usage);
    (msg.info as any).cost = usage.cost;
    this.state.broadcast({
      type: 'message.updated',
      properties: { info: msg.info } as any,
    });
  }

  private onPiExit(code: number | null): void {
    if (
      this.pi.stopping ||
      this.state.sessions.get(this.session.id) !== this.session ||
      this.session.piSession !== this.pi
    ) {
      this.forceResolveIdleWaiters();
      return;
    }

    console.error(`[stream-adapter] pi exited code=${code} session=${this.session.id}`);
    this.pi.markIdle();
    // Finalize any in-flight assistant message
    const msgId = this.session.currentMessageId;
    if (msgId) {
      const msg = this.session.messages.get(msgId);
      if (msg && msg.info.role === 'assistant' && !(msg.info as any).time?.completed) {
        (msg.info as any).time.completed = Date.now();
        (msg.info as any).finish = 'error';
        (msg.info as any).error = {
          name: 'ProcessExited',
          message: `Pi process exited (code ${code})`,
        };
        this.state.broadcast({
          type: 'message.updated',
          properties: { info: msg.info } as any,
        });
      }
    }
    this.session.status = { type: 'idle' };
    this.session.adapter = undefined; // force recreate on next prompt
    this.state.broadcast({
      type: 'session.error',
      properties: {
        sessionID: this.session.id,
        error: { name: 'ProcessExited', data: { message: `Pi exited with code ${code}` } },
      } as any,
    });
    this.setStatus({ type: 'idle' });
    this.state.broadcast({
      type: 'session.idle',
      properties: { sessionID: this.session.id },
    });
    this.state.persist(this.session);
    this.forceResolveIdleWaiters();
  }

  async setModel(providerID: string, modelID: string): Promise<void> {
    this.model = { providerID, modelID };
    try {
      await this.pi.setModel(providerID, modelID);
    } catch (err) {
      console.warn('[stream-adapter] setModel failed:', err);
    }
  }

  private ensureAssistantMessage(): string {
    if (this.session.currentMessageId) {
      const existing = this.session.messages.get(this.session.currentMessageId);
      if (existing && existing.info.role === 'assistant' && !(existing.info as any).time?.completed) {
        return this.session.currentMessageId;
      }
    }
    const messageId = this.state.createAssistantMessage(this.session.id, this.model);
    const msg = this.session.messages.get(messageId)!;
    // CRITICAL: desktop must learn about the assistant message before any parts
    this.state.broadcast({
      type: 'message.updated',
      properties: { info: msg.info } as any,
    });
    return messageId;
  }

  private emitPartUpdated(part: Part, delta?: string): void {
    // Real OpenCode streams via message.part.updated with full part + delta
    this.state.broadcast({
      type: 'message.part.updated',
      properties: {
        part,
        ...(delta !== undefined ? { delta } : {}),
      } as any,
    });
  }

  private onAgentStart(): void {
    this.runGeneration++;
    this.stepStartTime = Date.now();
    this.activeTextPart = null;
    this.activeReasoningPart = null;
    this.turnUsage = emptyUsage();
    this.agentUsage = emptyUsage();
    this.ensureAssistantMessage();
    this.setStatus({ type: 'busy' });
  }

  private onMessageEnd(event: any): void {
    // Assistant message_end carries final usage for that LLM call
    if (event?.message?.role !== 'assistant') return;
    const usage = extractPiUsage(event.message);
    if (!usage) return;
    // Prefer latest non-zero usage for the current turn (turn_end may also apply)
    if (usage.input || usage.output || usage.reasoning || usage.cacheRead || usage.cost) {
      this.turnUsage = usage;
      this.applyUsageToMessage(this.session.currentMessageId, addUsage(this.agentUsage, usage));
    }
  }

  private onMessageUpdate(event: any): void {
    const assistantEvent = event.assistantMessageEvent;
    if (!assistantEvent) return;

    switch (assistantEvent.type) {
      case 'text_delta': {
        const delta = assistantEvent.delta || assistantEvent.content || '';
        if (!delta) break;
        const messageId = this.ensureAssistantMessage();
        if (!this.activeTextPart) {
          this.activeTextPart = {
            id: newPartID(),
            sessionID: this.session.id,
            messageID: messageId,
            type: 'text',
            text: delta,
            time: { start: Date.now() },
          };
          this.state.addPartToCurrentMessage(this.session.id, this.activeTextPart);
          // First chunk: full part + delta so UI can create + stream
          this.emitPartUpdated(this.activeTextPart, delta);
        } else {
          this.activeTextPart.text += delta;
          this.emitPartUpdated(this.activeTextPart, delta);
        }
        break;
      }

      case 'thinking_delta': {
        const delta = assistantEvent.delta || assistantEvent.content || '';
        if (!delta) break;
        const messageId = this.ensureAssistantMessage();
        if (!this.activeReasoningPart) {
          this.activeReasoningPart = {
            id: newPartID(),
            sessionID: this.session.id,
            messageID: messageId,
            type: 'reasoning',
            text: delta,
            time: { start: Date.now() },
          };
          this.state.addPartToCurrentMessage(this.session.id, this.activeReasoningPart);
          this.emitPartUpdated(this.activeReasoningPart, delta);
        } else {
          this.activeReasoningPart.text += delta;
          this.emitPartUpdated(this.activeReasoningPart, delta);
        }
        break;
      }

      case 'done':
      case 'error':
        // Finalize handled in agent_end / message_end
        break;
    }
  }

  private onToolStart(event: any): void {
    const { toolCallId, toolName, args } = event;
    const messageId = this.ensureAssistantMessage();
    const part: ToolPart = {
      id: newPartID(),
      sessionID: this.session.id,
      messageID: messageId,
      type: 'tool',
      callID: toolCallId || newCallID(),
      tool: mapToolName(toolName || 'unknown'),
      state: {
        status: 'running',
        input: convertParams(args || {}),
        time: { start: Date.now() },
      },
    };
    this.activeToolParts.set(toolCallId, part);
    this.state.addPartToCurrentMessage(this.session.id, part);
    this.emitPartUpdated(part);
  }

  private onToolUpdate(event: any): void {
    const { toolCallId, title } = event;
    const part = this.activeToolParts.get(toolCallId);
    if (!part) return;
    if (part.state.status === 'running') {
      (part.state as any).title = title;
      this.emitPartUpdated(part);
    }
  }

  private onToolEnd(event: any): void {
    const { toolCallId, toolName, result, isError } = event;
    const part = this.activeToolParts.get(toolCallId);
    if (!part) return;

    const endTime = Date.now();
    const startTime = (part.state as any).time?.start || endTime;
    if (isError) {
      const errorMsg = typeof result === 'string' ? result : JSON.stringify(result);
      part.state = {
        status: 'error',
        input: part.state.input,
        error: errorMsg,
        time: { start: startTime, end: endTime },
      };
    } else {
      // Build output string from result
      let output = '';
      let metadata: Record<string, unknown> = {};

      if (typeof result === 'string') {
        output = result;
      } else if (result && typeof result === 'object') {
        // Pi returns content as array of {type, text} items
        const r = result as any;
        if (Array.isArray(r.content)) {
          output = r.content
            .map((c: any) => (typeof c === 'string' ? c : c.text || ''))
            .filter(Boolean)
            .join('\n');
        }
        if (r.details) {
          metadata = r.details;
        }
      }

      // Build tool-specific metadata
      const toolName = part.tool;
      if (toolName === 'bash') {
        const exit = metadata.exit ?? metadata.exitCode ?? 0;
        metadata = {
          ...metadata,
          output: output,
          exit: exit,
          description: metadata.description || part.state.input.command || '',
        };
        // output for OpenCode is the actual stdout
        output = metadata.output as string;
      } else if (toolName === 'read') {
        const lines = output.split('\n');
        const preview = lines.slice(0, 20).join('\n');
        metadata = {
          ...metadata,
          preview,
          truncated: lines.length > 20,
        };
      } else if (toolName === 'edit' || toolName === 'write') {
        if (metadata.diff) {
          metadata.filediff = metadata.diff;
        }
        if (metadata.patch) {
          metadata.filediff = metadata.patch;
        }
      }

      // Track files for session.diff
      const input = part.state.input || {};
      const filePath =
        (input.filePath as string) ||
        (input.path as string) ||
        (input.file as string) ||
        (metadata.path as string) ||
        (metadata.file as string);
      if (toolName === 'edit' || toolName === 'write' || toolName === 'read') {
        this.state.trackTouchedFile(this.session.id, filePath);
      }

      part.state = {
        status: 'completed',
        input: part.state.input,
        output,
        title: (part.state as any).title || toolName,
        metadata,
        time: { start: startTime, end: endTime },
      };
    }

    this.emitPartUpdated(part);
    this.activeToolParts.delete(toolCallId);
  }

  private onTurnStart(event: any): void {
    // Reset text/reasoning parts for new turn (tools may span)
    this.activeTextPart = null;
    this.activeReasoningPart = null;
    this.turnUsage = emptyUsage();
    this.stepStartTime = Date.now();
    const messageId = this.ensureAssistantMessage();

    const stepStart: StepStartPart = {
      id: newPartID(),
      sessionID: this.session.id,
      messageID: messageId,
      type: 'step-start',
    };
    this.state.addPartToCurrentMessage(this.session.id, stepStart);
    this.emitPartUpdated(stepStart);
  }

  private onTurnEnd(event: any): void {
    // Real Pi usage lives on turn_end.message.usage
    const usage =
      extractPiUsage(event?.message) ||
      extractPiUsage(event) ||
      this.turnUsage;
    this.turnUsage = usage;
    this.agentUsage = addUsage(this.agentUsage, usage);

    const messageId = this.session.currentMessageId || this.ensureAssistantMessage();
    const tokens = toOpenCodeTokens(usage);
    const cost = usage.cost;

    const stepFinish: StepFinishPart = {
      id: newPartID(),
      sessionID: this.session.id,
      messageID: messageId,
      type: 'step-finish',
      reason: event?.message?.stopReason || event?.reason || 'stop',
      cost,
      tokens,
    };
    this.state.addPartToCurrentMessage(this.session.id, stepFinish);
    this.emitPartUpdated(stepFinish);

    // Keep assistant message tokens as running sum across tool-loop turns
    this.applyUsageToMessage(messageId, this.agentUsage);
  }

  private onAgentEnd(event: any): void {
    // Prefer summing assistant usages from agent_end.messages when present
    if (Array.isArray(event?.messages)) {
      let summed = emptyUsage();
      let found = false;
      for (const m of event.messages) {
        if (m?.role !== 'assistant') continue;
        const u = extractPiUsage(m);
        if (!u) continue;
        summed = addUsage(summed, u);
        found = true;
      }
      if (found) this.agentUsage = summed;
    }

    // Finalize the assistant message
    const msgId = this.session.currentMessageId;
    if (msgId) {
      const msg = this.session.messages.get(msgId);
      if (msg) {
        if (msg.info.role === 'assistant') {
          (msg.info as any).time.completed = Date.now();
          (msg.info as any).tokens = toOpenCodeTokens(this.agentUsage);
          (msg.info as any).cost = this.agentUsage.cost;
          if (event?.messages) {
            const lastAsst = [...event.messages].reverse().find((m: any) => m?.role === 'assistant');
            if (lastAsst?.stopReason) (msg.info as any).finish = lastAsst.stopReason;
          }
        }
        this.state.broadcast({
          type: 'message.updated',
          properties: { info: msg.info } as any,
        });
      }
    }

    console.log(
      `[stream-adapter] usage session=${this.session.id} ` +
      `in=${this.agentUsage.input} out=${this.agentUsage.output} ` +
      `reason=${this.agentUsage.reasoning} cacheR=${this.agentUsage.cacheRead} ` +
      `cost=${this.agentUsage.cost}`,
    );

    // LLM session title after first completed reply (async, non-blocking)
    this.maybeGenerateLlmTitle();

    // Emit session.diff for any files touched this run
    this.emitSessionDiff();

    // Mark session as idle + persist
    this.pi.markIdle();
    this.setStatus({ type: 'idle' });
    const idleEvent: SessionIdleEvent = {
      type: 'session.idle',
      properties: { sessionID: this.session.id },
    };
    this.state.broadcast(idleEvent);
    this.state.broadcast({
      type: 'session.updated',
      properties: { info: this.session.opencodeSession } as any,
    });
    this.state.persist(this.session);
    this.resolveIdleWaiters();
  }

  get generation(): number {
    return this.runGeneration;
  }

  async waitForIdle(
    afterGeneration = this.runGeneration - 1,
    timeoutMs = (() => {
      const v = Number(process.env.PI_SYNC_TIMEOUT_MS);
      return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
    })(),
  ): Promise<void> {
    if (
      this.runGeneration > afterGeneration &&
      !this.isStreaming &&
      this.session.status.type === 'idle'
    ) return;

    return new Promise((resolve, reject) => {
      const waiter = {
        afterGeneration,
        resolve: () => {
          clearTimeout(waiter.timer);
          this.idleWaiters.delete(waiter);
          resolve();
        },
        timer: setTimeout(() => {
          this.idleWaiters.delete(waiter);
          reject(new Error('Timed out waiting for Pi to finish'));
        }, timeoutMs),
      };
      this.idleWaiters.add(waiter);
    });
  }

  private resolveIdleWaiters(): void {
    for (const waiter of Array.from(this.idleWaiters)) {
      if (this.runGeneration > waiter.afterGeneration && !this.isStreaming && this.session.status.type === 'idle') {
        waiter.resolve();
      }
    }
  }

  private forceResolveIdleWaiters(): void {
    for (const waiter of Array.from(this.idleWaiters)) {
      waiter.resolve();
    }
  }

  private maybeGenerateLlmTitle(): void {
    if (this.session.llmTitleDone || this.session.titleLocked) return;
    let userText = '';
    let assistantText = '';
    for (const msg of this.session.messages.values()) {
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
    if (!userText) return;
    void this.state.applyLlmTitle(this.session.id, userText, assistantText);
  }

  private emitSessionDiff(): void {
    try {
      const files = this.session.touchedFiles ? Array.from(this.session.touchedFiles) : [];
      if (!files.length) return;
      // dynamic to avoid circular import weight at load
      import('./git.js').then(({ getDiffsForFiles, summarizeDiffs }) => {
        const diffs = getDiffsForFiles(this.session.workingDir, files);
        const summary = summarizeDiffs(diffs);
        (this.session.opencodeSession as any).summary = {
          additions: summary.additions,
          deletions: summary.deletions,
          files: summary.files,
        };
        this.state.broadcast({
          type: 'session.diff',
          properties: { sessionID: this.session.id, diff: diffs as any },
        });
        this.state.persist(this.session);
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  private onAutoRetryStart(event: any): void {
    this.setStatus({
      type: 'retry',
      attempt: event?.attempt || 0,
      message: event?.message || 'Retrying...',
    });
  }

  private onAutoRetryEnd(): void {
    this.setStatus({ type: 'busy' });
  }

  private onCompactionStart(): void {
    // Could add a CompactionPart
  }

  private onCompactionEnd(): void {
    const event = {
      type: 'session.compacted',
      properties: { sessionID: this.session.id },
    } as const;
    this.state.broadcast(event);
  }

  private onExtensionUIRequest(event: any): void {
    const { id, method, ...rest } = event;
    // Pi nests method-specific fields at top level of the event
    const params = { ...rest, ...(rest.params || {}), ...(rest.args || {}) };

    // Fire-and-forget UI methods — no response expected
    if (
      method === 'setStatus' || method === 'setWidget' || method === 'setTitle' ||
      method === 'notify' || method === 'set_editor_text' || method === 'setEditorText'
    ) {
      return;
    }

    // confirm → response must be { confirmed: true/false } or { cancelled: true }
    if (method === 'confirm' || method === 'confirmAction' || method === 'requestPermission' || method === 'request_permission') {
      const auto = process.env.PI_AUTO_APPROVE === '1';
      if (auto) {
        this.pi.respondToExtensionUI(id, { confirmed: true });
        return;
      }
      const permId = newCallID();
      this.session.pendingPermissions.set(permId, {
        tool: params.tool || params.toolName || 'bash',
        patterns: params.patterns || params.paths || [],
        metadata: { ...params, piMethod: method },
        piRequestId: id,
        permission: params.permission || params.kind || 'execute',
        always: params.always ?? false,
      });
      this.state.broadcast({
        type: 'permission.asked',
        properties: {
          id: permId,
          sessionID: this.session.id,
          permission: params.permission || params.kind || 'execute',
          patterns: params.patterns || params.paths || [],
          metadata: params,
          always: params.always ?? false,
          tool: params.tool || params.toolName || 'bash',
        },
      });
      return;
    }

    // select / input / editor → response { value } or { cancelled: true }
    if (method === 'select' || method === 'input' || method === 'editor' ||
        method === 'requestQuestion' || method === 'request_question') {
      const auto = process.env.PI_AUTO_APPROVE === '1';
      if (auto && method === 'select') {
        const opts = params.options || [];
        const first = typeof opts[0] === 'string' ? opts[0] : opts[0]?.value ?? opts[0]?.label ?? opts[0];
        this.pi.respondToExtensionUI(id, { value: first });
        return;
      }
      const questionId = newCallID();
      const questions = params.questions || [{
        question: params.prompt || params.message || params.title || '?',
        options: (params.options || []).map((o: any) =>
          typeof o === 'string' ? { label: o } : { label: o.label || o.name || String(o), description: o.description },
        ),
      }];
      this.session.pendingQuestions.set(questionId, {
        questions,
        piRequestId: id,
      });
      // Stash method so we can format the response correctly
      (this.session.pendingQuestions.get(questionId) as any).piMethod = method;
      this.state.broadcast({
        type: 'question.asked',
        properties: {
          id: questionId,
          sessionID: this.session.id,
          questions,
          tool: params.tool,
        },
      });
      return;
    }

    // Unknown dialog — cancel rather than auto-accept dangerous ops
    console.warn(`[stream-adapter] unknown extension_ui method=${method}, cancelling`);
    this.pi.respondToExtensionUI(id, { cancelled: true });
  }

  private setStatus(status: { type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string }): void {
    this.session.status = status;
    const event: SessionStatusEvent = {
      type: 'session.status',
      properties: {
        sessionID: this.session.id,
        status,
      },
    };
    this.state.broadcast(event);
  }

  async sendPrompt(message: string): Promise<void> {
    const streaming = this.pi.streaming;
    return this.pi.prompt(message, streaming ? { streamingBehavior: 'followUp' } : undefined);
  }

  async sendFollowUp(message: string): Promise<void> {
    return this.pi.prompt(message, { streamingBehavior: 'followUp' });
  }

  async sendSteer(message: string): Promise<void> {
    return this.pi.steer(message);
  }

  get isStreaming(): boolean {
    return this.pi.streaming;
  }

  async abort(): Promise<void> {
    return this.pi.abort();
  }

  respondToPermission(requestId: string, reply: 'once' | 'always' | 'reject'): void {
    const perm = this.session.pendingPermissions.get(requestId);
    if (!perm) return;
    this.session.pendingPermissions.delete(requestId);

    // Pi confirm protocol: { confirmed: boolean } or { cancelled: true }
    if (reply === 'reject') {
      this.pi.respondToExtensionUI(perm.piRequestId, { confirmed: false });
    } else {
      this.pi.respondToExtensionUI(perm.piRequestId, { confirmed: true });
    }

    this.state.broadcast({
      type: 'permission.replied',
      properties: {
        sessionID: this.session.id,
        requestID: requestId,
        reply,
      },
    });
  }

  respondToQuestion(requestId: string, answers: string[][]): void {
    const q = this.session.pendingQuestions.get(requestId) as any;
    if (!q) return;
    this.session.pendingQuestions.delete(requestId);
    // Pi select/input: { value: string }
    const value = answers?.[0]?.[0] ?? answers?.[0]?.join(', ') ?? '';
    this.pi.respondToExtensionUI(q.piRequestId, { value });
    this.state.broadcast({
      type: 'question.replied',
      properties: {
        sessionID: this.session.id,
        requestID: requestId,
        answers,
      },
    });
  }

  rejectQuestion(requestId: string): void {
    const q = this.session.pendingQuestions.get(requestId);
    if (!q) return;
    this.session.pendingQuestions.delete(requestId);
    this.pi.respondToExtensionUI(q.piRequestId, { cancelled: true });
    this.state.broadcast({
      type: 'question.rejected',
      properties: {
        sessionID: this.session.id,
        requestID: requestId,
      },
    });
  }

  cleanup(): void {
    this.pi.kill();
  }
}
