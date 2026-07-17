import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from './types/sessions.js';
import type { AnyMessageWithParts } from './types/messages.js';

export interface PersistedSession {
  opencodeSession: Session;
  messages: AnyMessageWithParts[];
  todos: Array<{ content: string; status: string; priority: string }>;
  agent: string;
  model: { providerID: string; modelID: string };
  piSessionId?: string;
  titleLocked?: boolean;
  llmTitleDone?: boolean;
}

export class SessionStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir || join(homedir(), '.pi-opencode-bridge', 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(data: PersistedSession): void {
    try {
      writeFileSync(this.pathFor(data.opencodeSession.id), JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[store] save failed:', err);
    }
  }

  load(id: string): PersistedSession | null {
    try {
      const p = this.pathFor(id);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf-8')) as PersistedSession;
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    try {
      const p = this.pathFor(id);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      console.error('[store] delete failed:', err);
    }
  }

  list(): PersistedSession[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as PersistedSession;
          } catch {
            return null;
          }
        })
        .filter((x): x is PersistedSession => x !== null)
        .sort((a, b) => b.opencodeSession.time.updated - a.opencodeSession.time.updated);
    } catch {
      return [];
    }
  }

  listByDirectory(directory: string): PersistedSession[] {
    return this.list().filter(s => s.opencodeSession.directory === directory);
  }
}
