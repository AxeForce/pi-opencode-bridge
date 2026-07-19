import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiPromptCommand {
  type: 'prompt';
  message: string;
  images?: Array<{ type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }>;
  streamingBehavior?: 'steer' | 'followUp';
}

export interface PiResponse {
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiSessionState {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  messages?: unknown[];
  [key: string]: unknown;
}

export class PiRPCError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface PiSessionOptions {
  tools?: string[]; // restrict to these tools
  model?: { provider: string; id: string };
  /** Directory where Pi stores session jsonl (enables resume after restart) */
  sessionDir?: string;
  /** If true, don't persist Pi session (ephemeral) */
  ephemeral?: boolean;
}

export class PiSession extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private commandPromises = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private pendingCommands: string[] = [];
  private commandCounter = 0;
  private isReady = false;
  private isStreaming = false;
  private intentionalStop = false;
  public sessionId: string;
  public cwd: string;
  public options: PiSessionOptions;
  public dead = false;

  constructor(sessionId: string, cwd: string = process.cwd(), options: PiSessionOptions = {}) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.options = options;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  get stopping(): boolean {
    return this.intentionalStop;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalStop = false;
      // Persist Pi conversation under sessionDir so restarts keep model context.
      // Use a stable session-id derived from our OpenCode session id.
      const args = ['--mode', 'rpc', '--session-id', this.sessionId];
      if (this.options.ephemeral) {
        args.push('--no-session');
      } else if (this.options.sessionDir) {
        args.push('--session-dir', this.options.sessionDir);
      }
      if (this.options.tools && this.options.tools.length > 0) {
        args.push('--tools', this.options.tools.join(','));
      }
      if (this.options.model) {
        const modelArg = `${this.options.model.provider}/${this.options.model.id}`;
        args.push('--model', modelArg);
      }
      if (process.platform === 'win32') {
        for (const arg of args) {
          if (arg.startsWith('--')) continue;
          if (/["&|<>^%!()\r\n]/.test(arg)) {
            reject(new PiRPCError('INVALID_ARGUMENT', 'Unsafe argument for Windows shell execution'));
            return;
          }
        }
      }

      this.dead = false;
      this.process = spawn('pi', args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      this.process.stdout!.on('data', (data: Buffer) => this.handleData(data));
      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[pi stderr] ${data.toString()}`);
      });

      this.process.on('error', (err) => {
        console.error('[pi process error]', err);
        this.dead = true;
        this.isReady = false;
        this.isStreaming = false;
        this.emit('exit', -1);
        this.cleanup();
        reject(err);
      });

      this.process.on('exit', (code) => {
        console.log(`[pi] process exited with code ${code}`);
        this.isReady = false;
        this.isStreaming = false;
        this.dead = true;
        this.process = null;
        this.emit('exit', code);
        // Reject all pending commands
        for (const [id, { reject }] of this.commandPromises) {
          reject(new PiRPCError('PROCESS_EXITED', `Pi process exited (code ${code}) while waiting for command ${id}`));
        }
        this.commandPromises.clear();
      });

      // Wait for initial ready signal (first event from pi)
      const onReady = () => {
        this.isReady = true;
        this.off('extension_ui_request', onReady);
        resolve();
      };
      this.on('extension_ui_request', onReady);

      // Timeout if pi doesn't respond
      setTimeout(() => {
        if (!this.isReady) {
          // Pi might not send an initial event; just resolve
          this.isReady = true;
          this.off('extension_ui_request', onReady);
          resolve();
        }
      }, 2000);
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    // Pi uses LF as record delimiter (strict JSONL)
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.warn(`[pi] failed to parse line: ${line.slice(0, 200)}`);
      return;
    }

    if (parsed.type === 'response') {
      // Command response
      const cmdId = parsed.id;
      if (cmdId) {
        const pending = this.commandPromises.get(cmdId);
        if (pending) {
          this.commandPromises.delete(cmdId);
          if (parsed.success) {
            pending.resolve(parsed.data);
          } else {
            pending.reject(new PiRPCError('COMMAND_FAILED', parsed.error || 'Unknown error'));
          }
        }
      } else {
        // Response without ID - emit as event
        this.emit('response', parsed);
      }
      return;
    }

    if (parsed.type === 'extension_ui_request') {
      // Pi is asking us for input (dialog, permission, etc.)
      this.emit('extension_ui_request', parsed);
      return;
    }

    // All other events
    this.emit(parsed.type, parsed);
  }

  private sendCommand(command: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.isReady) {
        reject(new PiRPCError('NOT_READY', 'Pi process is not running'));
        return;
      }
      const id = randomUUID();
      this.commandPromises.set(id, { resolve, reject });
      const cmdWithId = { ...command, id };
      this.process.stdin!.write(JSON.stringify(cmdWithId) + '\n');
    });
  }

  async prompt(message: string, options?: { images?: any[]; streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    // If already streaming, use followUp/steer so Pi doesn't reject concurrent prompts
    if (this.isStreaming && !options?.streamingBehavior) {
      options = { ...options, streamingBehavior: 'followUp' };
    }
    this.isStreaming = true;
    try {
      await this.sendCommand({
        type: 'prompt',
        message,
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      });
    } catch (err) {
      this.isStreaming = false;
      throw err;
    }
  }

  markIdle(): void {
    this.isStreaming = false;
  }

  async steer(message: string): Promise<void> {
    await this.sendCommand({ type: 'steer', message });
  }

  async followUp(message: string): Promise<void> {
    await this.prompt(message, { streamingBehavior: 'followUp' });
  }

  async abort(): Promise<void> {
    try {
      await this.sendCommand({ type: 'abort' });
    } finally {
      this.isStreaming = false;
    }
  }

  async newSession(): Promise<boolean> {
    return this.sendCommand({ type: 'new_session' });
  }

  async getState(): Promise<PiSessionState> {
    return this.sendCommand({ type: 'get_state' });
  }

  async getCommands(): Promise<unknown> {
    return this.sendCommand({ type: 'get_commands' });
  }

  async getMessages(): Promise<unknown[]> {
    return this.sendCommand({ type: 'get_messages' });
  }

  async getModels(): Promise<unknown[]> {
    return this.sendCommand({ type: 'get_models' });
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.sendCommand({ type: 'set_model', provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<unknown> {
    return this.sendCommand({ type: 'set_thinking_level', thinkingLevel: level });
  }

  async compact(): Promise<unknown> {
    return this.sendCommand({ type: 'compact' });
  }

  /**
   * Pi RPC expects the response fields at the TOP level of the message,
   * not nested under "response". See docs/rpc.md:
   *   {"type":"extension_ui_response","id":"...","confirmed":true}
   */
  respondToExtensionUI(id: string, fields: Record<string, unknown>): void {
    if (!this.process || !this.isReady) return;
    this.process.stdin!.write(JSON.stringify({
      type: 'extension_ui_response',
      id,
      ...fields,
    }) + '\n');
  }

  kill(): void {
    this.intentionalStop = true;
    this.dead = true;
    this.isReady = false;
    this.isStreaming = false;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.process) {
      try {
        this.process.stdin?.end();
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
    this.isReady = false;
  }
}
