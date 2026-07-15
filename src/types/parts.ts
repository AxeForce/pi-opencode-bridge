import type { TimeStartEnd, TimeStartEndOptional, TimeStart, TimeStartEndCompacted } from './common.js';

export interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
}

export interface TextPart extends PartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: TimeStartEndOptional;
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart extends PartBase {
  type: 'reasoning';
  text: string;
  time: TimeStartEndOptional;
  metadata?: Record<string, unknown>;
}

export interface FilePart extends PartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export interface AgentPart extends PartBase {
  type: 'agent';
  name: string;
}

export interface SnapshotPart extends PartBase {
  type: 'snapshot';
  snapshot: string;
}

export interface PatchPart extends PartBase {
  type: 'patch';
  hash: string;
  files: string[];
}

export interface CompactionPart extends PartBase {
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
}

export interface SubtaskPart extends PartBase {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  command?: string;
}

export interface RetryPart extends PartBase {
  type: 'retry';
  attempt: number;
  error: { name: string; message: string; data?: Record<string, unknown> };
  time: { created: number };
}

export interface StepStartPart extends PartBase {
  type: 'step-start';
  snapshot?: string;
}

export interface StepFinishPart extends PartBase {
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

export type Part =
  | TextPart
  | ToolPart
  | FilePart
  | AgentPart
  | SnapshotPart
  | PatchPart
  | ReasoningPart
  | CompactionPart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart;

// ToolState union
export interface ToolStatePending {
  status: 'pending';
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: 'running';
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: TimeStart;
}

export interface ToolStateCompleted {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: TimeStartEndCompacted;
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: 'error';
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: TimeStartEnd;
}

export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

export interface ToolPart extends PartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}
