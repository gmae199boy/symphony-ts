/**
 * 시스템 전체에서 공유되는 핵심 도메인 타입.
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
  assigneeEmail: string | null;
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
// 에이전트 메시지
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
// 트래커 인터페이스
// ---------------------------------------------------------------------------

export interface TrackerComment {
  id: string;
  body: string;
  authorId: string;
  authorEmail?: string;
  isBot: boolean;
  createdAt: Date | null;
}

export interface FeedbackResponseEvent {
  issueIdentifier: string;
  issueId: string;
  responseText: string;
  workspaceName: string;
  isApproval: boolean;
  source: 'slack';
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;
  transitionIssue(id: string, toState: string): Promise<void>;
  createComment(id: string, body: string): Promise<void>;
  fetchComments(issueId: string, since?: Date): Promise<TrackerComment[]>;
  getBotIdentity(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// 저장소 (GitHub / Bitbucket) 타입
// ---------------------------------------------------------------------------

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branchName: string;
  labels: string[];
  issueIdentifier: string | null;
  state: string; // 'open' | 'closed' | 'merged' (열림 | 닫힘 | 병합됨)
}

export interface Review {
  id: number;
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' (승인됨 | 변경 요청 | 코멘트 | 해제됨)
  authorLogin: string;
  submittedAt: Date | null;
}

export interface Comment {
  /** 네임스페이스 적용: 타입 간 ID 충돌 방지를 위해 "issue:{id}" 또는 "review:{id}" 형식 사용. */
  id: string;
  body: string;
  authorLogin: string;
  isBot: boolean;
  createdAt: Date | null;
  path?: string | null;    // inline 댓글의 파일 경로
  line?: number | null;    // inline 댓글의 줄 번호
}

export type RepoEventKind = 'new_comments' | 'pr_merged';

export type DispatchReason = 'new_issue' | 'recovery' | 'pr_feedback' | 'slack_response' | 'retry' | 'review_fix';

export type IssuePhase =
  | 'initial'
  | 'plan_sent'
  | 'pr_plan_sent'   // PR 피드백 계획 대기 (plan_sent와 달리 승인 시 pr_fixing으로 복귀)
  | 'implementing'
  | 'question_sent'
  | 'review_sent'
  | 'review_fixing'
  | 'pr_fixing';

export interface RepoEvent {
  kind: RepoEventKind;
  pr: PullRequest;
  comment?: Comment;
  comments?: Comment[];  // new_comments 이벤트용
}

export type RepoEventHandler = (event: RepoEvent) => void;

// ---------------------------------------------------------------------------
// 워크스페이스
// ---------------------------------------------------------------------------

export interface WorkspaceRef {
  workspace: string; // 절대 경로
  containerName?: string; // Docker 전용
  workerHost?: string; // SSH 워커 전용
}

export interface WorkspaceBackend {
  create(issue: Issue, workerHost?: string): Promise<WorkspaceRef>;
  runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void>;
  runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void>;
  cleanup(ref: WorkspaceRef, issue: Issue): Promise<void>;
}

/**
 * 런타임 파일 I/O 및 워크스페이스 조회 — Docker exec, 로컬 fs,
 * (미래의) SSH exec를 단일 인터페이스로 추상화.
 */
export interface WorkspaceIO {
  /** 워크스페이스 루트 기준 상대 경로로 파일 읽기. 없으면 null 반환. */
  readFile(ref: WorkspaceRef, relativePath: string): Promise<string | null>;
  /** 워크스페이스 루트 기준 상대 경로로 파일 쓰기. 상위 디렉토리 자동 생성. */
  writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void>;
  /** git diff 조회. base가 제공되면 해당 커밋에서 HEAD까지의 diff 반환; 없으면 전체 PR diff (origin/main...HEAD) 반환. */
  getDiff(ref: WorkspaceRef, base?: string): Promise<string | null>;
  /** 워크스페이스 존재 여부 확인 (컨테이너 실행 중 / 디렉토리 존재). */
  exists(ref: WorkspaceRef): Promise<boolean>;
  /** 관리 중인 모든 워크스페이스 목록 반환. 이름 + 이슈 식별자 포함. */
  list(): Promise<{ name: string; identifier: string }[]>;
  /** 워크스페이스 이름에서 이슈 식별자 추출. */
  identifierFromName(name: string): string | null;
  /** 주어진 이슈의 워크스페이스 이름 도출. */
  nameForIssue(issue: Issue): string;
  /** 이슈에 대한 WorkspaceRef 생성 (워크스페이스를 실제로 만들지는 않음). */
  refForIssue(issue: Issue): WorkspaceRef;
  /** 워크스페이스 이름으로 WorkspaceRef 재구성 (nameForIssue의 역방향). */
  refFromName(name: string): WorkspaceRef;
}

// ---------------------------------------------------------------------------
// 에이전트 백엔드
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  cost?: number;
  tokensTotal?: number;
}

export interface AgentBackend {
  run(
    workspace: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 메신저
// ---------------------------------------------------------------------------

export interface MessengerClient {
  sendMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string; channel: string } | null>;
  sendMessageChunked(channel: string, text: string, threadTs?: string, onMessageSent?: (ts: string) => void): Promise<{ ts: string; channel: string } | null>;
}

// ---------------------------------------------------------------------------
// 에이전트 실행 옵션
// ---------------------------------------------------------------------------

export interface AgentRunOpts {
  maxTurns?: number;
  containerName?: string;
  workerHost?: string;
  onMessage?: AgentMessageHandler;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 모델 오버라이드 (예: 'opus', 'sonnet') — Claude CLI의 --model 플래그로 전달. */
  model?: string;
  /** 렌더링된 WORKFLOW 프롬프트. 백엔드가 주입 방식을 결정. */
  workflow: string;
  /** dispatch 시 에이전트에게 전달할 메시지. */
  resumeMessage?: string;
}
