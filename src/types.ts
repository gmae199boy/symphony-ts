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
  | { type: 'turn_complete'; cost?: number; tokens?: number }
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
  issueIdentifier: string | null;
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
  path?: string | null;    // inline 댓글의 파일 경로
  line?: number | null;    // inline 댓글의 줄 번호
}

export type RepoEventKind = 'new_comments' | 'pr_merged';

export type DispatchReason = 'new_issue' | 'recovery' | 'pr_feedback' | 'slack_response' | 'retry';

export interface RepoEvent {
  kind: RepoEventKind;
  pr: PullRequest;
  comment?: Comment;
  comments?: Comment[];  // new_comments 이벤트용
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

/**
 * Runtime file I/O and workspace queries — abstracts Docker exec, local fs,
 * and (future) SSH exec behind a single interface.
 */
export interface WorkspaceIO {
  /** Read a file relative to the workspace root. Returns null if not found. */
  readFile(ref: WorkspaceRef, relativePath: string): Promise<string | null>;
  /** Write a file relative to the workspace root. Creates parent dirs. */
  writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void>;
  /** Get git diff of uncommitted or last commit changes. */
  getDiff(ref: WorkspaceRef): Promise<string | null>;
  /** Check if the workspace exists (container running / directory exists). */
  exists(ref: WorkspaceRef): Promise<boolean>;
  /** List all managed workspaces. Returns name + issue identifier. */
  list(): Promise<{ name: string; identifier: string }[]>;
  /** Extract issue identifier from a workspace name. */
  identifierFromName(name: string): string | null;
  /** Derive the workspace name for a given issue. */
  nameForIssue(issue: Issue): string;
  /** Build a WorkspaceRef for an issue (without creating the workspace). */
  refForIssue(issue: Issue): WorkspaceRef;
  /** Reconstruct a WorkspaceRef from a workspace name (reverse of nameForIssue). */
  refFromName(name: string): WorkspaceRef;
}

// ---------------------------------------------------------------------------
// Agent backend
// ---------------------------------------------------------------------------

export interface AgentRunResult {
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
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Messenger
// ---------------------------------------------------------------------------

export interface MessengerClient {
  sendMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string; channel: string } | null>;
  sendMessageChunked(channel: string, text: string, threadTs?: string, onMessageSent?: (ts: string) => void): Promise<{ ts: string; channel: string } | null>;
}

// ---------------------------------------------------------------------------
// Agent run options
// ---------------------------------------------------------------------------

export interface AgentRunOpts {
  maxTurns?: number;
  containerName?: string;
  workerHost?: string;
  onMessage?: AgentMessageHandler;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Model override (e.g. 'opus', 'sonnet') — passed as --model flag to Claude CLI. */
  model?: string;
}
