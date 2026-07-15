import type { Part } from './parts.js';
import type { MessageInfo } from './messages.js';
import type { Session, SessionStatus, Todo } from './sessions.js';
import type { FileDiff, SessionErrorInfo } from './common.js';

// All SSE events follow this pattern:
// { type: "<event-type>", properties: { ... } }

export interface EventBase<T extends string> {
  type: T;
  properties: Record<string, unknown>;
}

// Helper type for events with named properties
export type Event<T extends string = string, P = Record<string, unknown>> = {
  type: T;
  properties: P;
};

// Server events
export type ServerConnectedEvent = Event<'server.connected', Record<string, never>>;
export type ServerHeartbeatEvent = Event<'server.heartbeat', Record<string, never>>;

// Session events
export type SessionCreatedEvent = Event<'session.created', {
  sessionID: string;
  info: Session;
}>;

export type SessionUpdatedEvent = Event<'session.updated', {
  sessionID: string;
  info: Session;
}>;

export type SessionDeletedEvent = Event<'session.deleted', {
  sessionID: string;
  info: Session;
}>;

export type SessionStatusEvent = Event<'session.status', {
  sessionID: string;
  status: SessionStatus;
}>;

export type SessionIdleEvent = Event<'session.idle', {
  sessionID: string;
}>;

export type SessionCompactedEvent = Event<'session.compacted', {
  sessionID: string;
}>;

export type SessionErrorEvent = Event<'session.error', {
  sessionID?: string;
  error?: SessionErrorInfo;
}>;

export type SessionDiffEvent = Event<'session.diff', {
  sessionID: string;
  diff: FileDiff[];
}>;

// Message events
export type MessageUpdatedEvent = Event<'message.updated', {
  sessionID: string;
  info: MessageInfo;
}>;

export type MessageRemovedEvent = Event<'message.removed', {
  sessionID: string;
  messageID: string;
}>;

// Part events
export interface PartUpdatedEventProperties {
  sessionID: string;
  part: Part;
  time: number;
  delta?: string;
}

export type PartUpdatedEvent = Event<'message.part.updated', PartUpdatedEventProperties>;

export type PartDeltaEvent = Event<'message.part.delta', {
  sessionID: string;
  messageID: string;
  partID: string;
  delta: string;
  time: number;
}>;

export type PartRemovedEvent = Event<'message.part.removed', {
  sessionID: string;
  messageID: string;
  partID: string;
}>;

// Permission events
export type PermissionAskedEvent = Event<'permission.asked', {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: boolean;
  tool: string;
}>;

export type PermissionRepliedEvent = Event<'permission.replied', {
  sessionID: string;
  requestID: string;
  reply: 'once' | 'always' | 'reject';
}>;

export type PermissionUpdatedEvent = Event<'permission.updated', {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: boolean;
  tool: string;
}>;

// Question events
export type QuestionAskedEvent = Event<'question.asked', {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    header?: string;
  }>;
  tool?: string;
}>;

export type QuestionRepliedEvent = Event<'question.replied', {
  sessionID: string;
  requestID: string;
  answers: string[][];
}>;

export type QuestionRejectedEvent = Event<'question.rejected', {
  sessionID: string;
  requestID: string;
}>;

// Todo events
export type TodoUpdatedEvent = Event<'todo.updated', {
  sessionID: string;
  todos: Todo[];
}>;

// File events
export type FileEditedEvent = Event<'file.edited', {
  file: string;
}>;

export type FileWatcherUpdatedEvent = Event<'file.watcher.updated', {
  file: string;
  event: 'add' | 'change' | 'unlink';
}>;

export type VcsBranchUpdatedEvent = Event<'vcs.branch.updated', {
  branch: string | null;
}>;

// Project events
export type ProjectUpdatedEvent = Event<'project.updated', Record<string, unknown>>;

// Command events
export type CommandExecutedEvent = Event<'command.executed', {
  name: string;
  sessionID: string;
  arguments: string;
  messageID: string;
}>;

// LSP events
export type LspUpdatedEvent = Event<'lsp.updated', Record<string, never>>;
export type LspClientDiagnosticsEvent = Event<'lsp.client.diagnostics', {
  serverID: string;
  path: string;
}>;

// Union of all events
export type OpenCodeEvent =
  | ServerConnectedEvent
  | ServerHeartbeatEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | SessionStatusEvent
  | SessionIdleEvent
  | SessionCompactedEvent
  | SessionErrorEvent
  | SessionDiffEvent
  | MessageUpdatedEvent
  | MessageRemovedEvent
  | PartUpdatedEvent
  | PartDeltaEvent
  | PartRemovedEvent
  | PermissionAskedEvent
  | PermissionRepliedEvent
  | PermissionUpdatedEvent
  | QuestionAskedEvent
  | QuestionRepliedEvent
  | QuestionRejectedEvent
  | TodoUpdatedEvent
  | FileEditedEvent
  | FileWatcherUpdatedEvent
  | VcsBranchUpdatedEvent
  | ProjectUpdatedEvent
  | CommandExecutedEvent
  | LspUpdatedEvent
  | LspClientDiagnosticsEvent;

export function createEvent<T extends OpenCodeEvent>(event: T): T {
  return event;
}
