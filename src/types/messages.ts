import type { ModelRef, Tokens } from './common.js';
import type { Part } from './parts.js';

export interface BaseMessage {
  id: string;
  sessionID: string;
  agent: string;
  variant?: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  time: { created: number };
  model: ModelRef;
  format?: OutputFormat;
  summary?: MessageSummary;
  system?: string;
  tools?: Record<string, boolean>;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  path: MessagePath;
  time: { created: number; completed?: number };
  tokens: Tokens;
  cost: number;
  error?: MessageError;
  summary?: boolean;
  finish?: FinishReason;
  structured?: unknown;
}

export type MessageInfo = UserMessage | AssistantMessage;

export interface MessageWithParts<T extends MessageInfo = MessageInfo> {
  info: T;
  parts: Part[];
}

export type AnyMessageWithParts =
  | MessageWithParts<UserMessage>
  | MessageWithParts<AssistantMessage>;

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'unknown';

export interface OutputFormat {
  type: string;
  [key: string]: unknown;
}

export interface MessageSummary {
  [key: string]: unknown;
}

export interface MessagePath {
  cwd: string;
  root: string;
}

export interface MessageError {
  name: string;
  message: string;
  data?: Record<string, unknown>;
}

// Input parts for sending messages
export interface TextPartInput {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface FilePartInput {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export type PartInput = TextPartInput | FilePartInput;
