export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface TokenCache {
  read: number;
  write: number;
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: TokenCache;
}

export interface TimeCreated {
  created: number;
}

export interface TimeStart {
  start: number;
}

export interface TimeStartEnd {
  start: number;
  end?: number;
}

export interface TimeStartEndCompacted {
  start: number;
  end: number;
  compacted?: number;
}

export type TimeStartEndOptional = TimeStartEnd;

export interface FileDiff {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

export interface APIError {
  name: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SessionErrorInfo {
  name: string;
  message: string;
  data?: Record<string, unknown>;
}
