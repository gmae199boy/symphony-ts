/**
 * Core domain types shared across the entire system.
 */

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  assignedToWorker: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface BlockerRef {
  id: string;
  identifier: string;
  state: string | null;
}

// ---------------------------------------------------------------------------
// Agent messages
// ---------------------------------------------------------------------------

export type AgentEventKind =
  | { type: 'output'; line: string }
  | { type: 'turn_complete'; sessionId: string | null; cost?: number; tokens?: number }
  | { type: 'error'; reason: string };

export interface AgentMessage {
  event: AgentEventKind;
  timestamp: Date;
}

export type AgentMessageHandler = (message: AgentMessage) => void;

// ---------------------------------------------------------------------------
// Tracker interface
// ---------------------------------------------------------------------------

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;
  transitionIssue(id: string, toState: string): Promise<void>;
  createComment(id: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository (GitHub / Bitbucket) types
// ---------------------------------------------------------------------------

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branchName: string;
  labels: string[];
  linearIssueId: string | null;
  state: string; // 'open' | 'closed' | 'merged'
}

export interface Review {
  id: number;
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
  authorLogin: string;
  submittedAt: Date | null;
}

export interface Comment {
  /** Namespaced: "issue:{id}" or "review:{id}" to avoid cross-type ID collisions. */
  id: string;
  body: string;
  authorLogin: string;
  isBot: boolean;
  createdAt: Date | null;
}

export type RepoEventKind = 'review_approved' | 'changes_requested' | 'new_comment';

export interface RepoEvent {
  kind: RepoEventKind;
  pr: PullRequest;
  review?: Review;
  comment?: Comment;
}

export type RepoEventHandler = (event: RepoEvent) => void;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceRef {
  workspace: string; // absolute path
  containerName?: string; // Docker only
  workerHost?: string; // SSH worker only
}

export interface WorkspaceBackend {
  create(issue: Issue, workerHost?: string): Promise<WorkspaceRef>;
  runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void>;
  runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void>;
  cleanup(ref: WorkspaceRef, issue: Issue): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent backend
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  sessionId: string | null;
  cost?: number;
  tokensTotal?: number;
}

export interface AgentBackend {
  run(
    workspace: string,
    prompt: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult>;
}

export interface AgentRunOpts {
  sessionId?: string | null;
  maxTurns?: number;
  containerName?: string;
  workerHost?: string;
  onMessage?: AgentMessageHandler;
  timeoutMs?: number;
}
