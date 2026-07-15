export interface Session {
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    archived?: number;
  };
  parentID?: string;
  summary?: string;
  share?: { url: string };
}

export type SessionStatusType = 'idle' | 'busy' | 'retry';

export interface SessionStatus {
  type: SessionStatusType;
  attempt?: number;
  message?: string;
  next?: number;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

export interface Project {
  id: string;
  worktree: string;
  vcs?: { branch: string };
  time: { created: number; initialized?: number };
}
