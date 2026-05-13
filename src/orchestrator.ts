/**
 * Orchestrator — 메인 폴링 및 디스패치 루프.
 * elixir/lib/symphony_elixir/orchestrator.ex 를 미러링함.
 *
 * 하나의 Orchestrator 인스턴스가 하나의 TrackerConfig(및 선택적 레포지토리 통합)를 관리한다.
 * 멀티 트래커 설정의 경우 여러 오케스트레이터가 병렬로 실행될 수 있다 (index.ts에서 관리).
 *
 * 책임:
 *  - 트래커에서 후보 이슈 폴링
 *  - 각 이슈에 실행할 에이전트 선택 (트리거 매칭)
 *  - 에이전트 러너에 이슈 디스패치 (동시 실행 제한 준수)
 *  - 실행 중/완료/실패 에이전트 추적
 *  - 레포지토리 PR 이벤트 처리 (new_comments → pr_feedback.json으로 재스케줄,
 *    pr_merged → 정리)
 *  - 중단된 에이전트 감지 및 정리
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { logger, logContext, addFileSink, removeFileSink, formatLogLine } from './logger.js';
import type { LogSink } from './logger.js';
import { runIssue } from './agent-runner.js';
import { RepoPoller } from './repository/poller.js';
import { TrackerPoller } from './tracker/poller.js';
import { LinearClient } from './tracker/linear.js';
import { JiraClient } from './tracker/jira.js';
import { createWorkspaceIO, createWorkspaceBackend } from './workspace/io.js';
import { isContainerRunning, restartStoppedContainer, killClaudeProcesses, containerNameForIssue, injectClaudeCredentials } from './workspace/docker.js';
import { SlackChannel } from './channel/slack.js';
import type { HumanChannel } from './channel/types.js';
import type { FeedbackResponseEvent } from './types.js';
import { spawn } from 'node:child_process';
import { shellEscape } from './shell-utils.js';
import { CostTracker } from './cost-tracker.js';
import { ContainerAdmissionSet } from './concurrency-limiter.js';
import { DiffQueueStore } from './slack/diff-queue.js';
import { DiffSender } from './slack/diff-sender.js';
import { parseDiffToFiles } from './slack/diff-parser.js';
import type { Issue, TrackerClient, RepoEvent, AgentMessage, Comment, WorkspaceRef, WorkspaceIO, DispatchReason, IssuePhase, PullRequest } from './types.js';
import type { Config, TrackerConfig, AgentConfig, ClaudeAgentConfig, CodexAgentConfig, RepositoryConfig } from './config/schema.js';
import { runSemgrep } from './review/semgrep-runner.js';
import { formatIssueLabel } from './utils.js';

const WAITING_PHASES: ReadonlySet<IssuePhase> = new Set(['plan_sent', 'pr_plan_sent', 'question_sent', 'review_sent', 'pr_fixing', 'auth_error_waiting']);

type RecoveryDecision =
  | { action: 'wait';     inferredPhase: IssuePhase }
  | { action: 'dispatch'; resumeMessage: string }
  | { action: 'forget' }
  | { action: 'skip' };

function isAuthenticationError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('authentication_error') || msg.includes('Invalid authentication credentials');
}

/** diff snippet 업로드에서 제외할 파일 경로 패턴 (lockfile + 시크릿 파일). */
const DIFF_EXCLUDED_PATH_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\..+)?|(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|[^/]*\.key|secrets?(?:\.ya?ml)?|credentials?(?:\.json)?|kubeconfig|\.netrc)(?:\s+\(part \s*\d+\/\d+\))?$/i;

export interface RunningEntry {
  issue: Issue;
  promise: Promise<void>;
  startedAt: Date;
  workerHost: string | null;
  workspacePath: string | null;
  containerName: string | null;
  agentLogLines: string[];
  /** 이 에이전트가 디스패치된 이유 */
  reason: DispatchReason;
  abortController: AbortController;
  retryCount: number;
}

export interface OrchestratorSnapshot {
  trackerId: string;
  running: RunningEntry[];
  completedCount: number;
  failedCount: number;
  repoEvents: RepoEventRecord[];
  /** 공유 limiter 전역 값 (다중 트래커 환경에서 모든 오케스트레이터가 동일한 수를 반환). */
  admittedCount: number;
  maxContainers: number;
}

export interface RepoEventRecord {
  kind: string;
  prNumber: number;
  issueIdentifier: string | null;
  timestamp: Date;
}

const MAX_REPO_EVENTS = 20;
const STALE_AGENT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4시간
const MAX_RECOVERY_WORKSPACES = 50;
const MAX_QUEUED_COMMENTS_PER_ISSUE = 200;

export interface TransferableState {
  issuePhases: Map<string, IssuePhase>;
  pendingDispatch: Set<string>;
  watchedIssues: Map<string, Issue>;
  queuedComments: Map<string, { comments: Comment[]; prLabels: string[] }>;
  recentlyMerged: Map<string, number>;
  recentlyTerminated: Map<string, number>;
  missingTickCounts: Map<string, number>;
  canceledPendingMap?: Map<string, number>;
  completedCount: number;
  failedCount: number;
  /** 핫 리로드 시 admission 상태 이전용 */
  admittedIdentifiers: string[];
}

/**
 * 로그 라인을 이슈별 파일(logContext 경유)과 symphony.log로 라우팅한다.
 * 파일 싱크로 등록되어 모든 logger.* 호출을 수신한다.
 */
class IssueAwareLogSink implements LogSink {
  constructor(
    private readonly symphonyStream: fs.WriteStream,
    private readonly issueStreams: Map<string, fs.WriteStream>,
  ) {}

  log(level: string, message: string, meta?: Record<string, unknown>): void {
    const line = formatLogLine(level, message, meta);
    this.symphonyStream.write(line);
    const identifier = logContext.getStore()?.identifier;
    if (identifier) {
      this.issueStreams.get(identifier)?.write(line);
    }
  }
}

export class Orchestrator extends EventEmitter {
  private readonly config: Config;
  private readonly trackerConfig: TrackerConfig;
  private readonly tracker: TrackerClient;
  private readonly promptTemplate: string;

  private running = new Map<string, RunningEntry>(); // issue.id → 엔트리
  private pendingDispatch = new Set<string>(); // identifier → 처리 중/디스패치 중
  private retryTimers = new Set<ReturnType<typeof setTimeout>>(); // 재시도 타이머
  private retryTimersByIdentifier = new Map<string, Set<ReturnType<typeof setTimeout>>>(); // identifier → 타이머 역매핑
  private issuePhases = new Map<string, IssuePhase>(); // identifier → 현재 phase
  /** 인증 오류 직전 phase 보존 — 재로그인 후 재개 시 복원용 */
  private authErrorPhases = new Map<string, IssuePhase>(); // identifier → auth_error 이전 phase
  private watchedIssues = new Map<string, Issue>(); // identifier → 마지막으로 알려진 Issue
  private queuedComments = new Map<string, { comments: Comment[]; prLabels: string[] }>(); // identifier → 큐에 쌓인 PR 댓글
  private recentlyMerged = new Map<string, number>(); // identifier → 타임스탬프
  /** terminateIssue()로 처리 완료된 이슈 — dispatch catch의 중복 재시도를 방지. recentlyMerged와 동일 TTL. */
  private recentlyTerminated = new Map<string, number>(); // identifier → 타임스탬프
  /** canceled 감지: candidates에 연속으로 보이지 않는 이슈의 카운트. 5회 연속 시 terminateIssue 호출. */
  private missingTickCounts = new Map<string, number>(); // identifier → 연속 부재 횟수
  /** 2단계 canceled 처리: 최초 감지 타임스탬프. 다음 폴 확인 후 terminate. */
  private canceledPendingMap = new Map<string, number>(); // identifier → 최초 감지 타임스탬프
  /** terminateIssue() 동시 호출 방지 — 동일 identifier의 중복 진입을 차단해 Slack 알림 중복 등을 막는다. */
  private inFlightTerminations = new Set<string>(); // identifier
  /** 레이블 불일치 알림 발송 완료 — 동일 이슈의 폴 반복 시 중복 알림 방지. */
  private labelMismatchNotified = new Set<string>(); // identifier
  private completedCount = 0;
  private failedCount = 0;
  private repoEvents: RepoEventRecord[] = [];

  private trackerPoller: TrackerPoller | null = null;
  private repoPollers: Map<string, RepoPoller> = new Map();
  private humanChannel: HumanChannel | null = null;
  private readonly limiter: ContainerAdmissionSet;
  private readonly io: WorkspaceIO;
  private costTracker: CostTracker;
  private diffQueueStore: DiffQueueStore;
  private diffSender: DiffSender | null = null;
  private stopped = false;
  private lastThreadPruneAt = 0;
  private credentialRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private costCommentWritten = new Set<string>(); // identifier → 비용 댓글 작성 완료
  private agentLogStreams = new Map<string, fs.WriteStream>(); // identifier → log WriteStream
  private readonly logsDir: string;
  private symphonyStream!: fs.WriteStream;
  private fileSink!: IssueAwareLogSink;
  private static readonly THREAD_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5분

  constructor(config: Config, trackerConfig: TrackerConfig, promptTemplate: string, limiter: ContainerAdmissionSet) {
    super();
    this.config = config;
    this.trackerConfig = trackerConfig;
    this.promptTemplate = promptTemplate;
    this.tracker = createTrackerClient(trackerConfig);
    this.limiter = limiter;
    this.io = createWorkspaceIO(config);
    this.costTracker = new CostTracker(config.workspace.root);
    this.diffQueueStore = new DiffQueueStore(config.workspace.root);
    this.diffQueueStore.load();
    this.logsDir = path.resolve('logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.symphonyStream = fs.createWriteStream(path.join(this.logsDir, 'symphony.log'), { flags: 'a', encoding: 'utf8' });
    this.symphonyStream.on('error', (err) => logger.warn('symphony.log write error', { error: String(err) }));
    this.fileSink = new IssueAwareLogSink(this.symphonyStream, this.agentLogStreams);
    addFileSink(this.fileSink);
  }

  // ---------------------------------------------------------------------------
  // 생명주기
  // ---------------------------------------------------------------------------

  start(): void {
    logger.info(`Orchestrator starting for tracker kind=${this.trackerConfig.kind}`);
    if (!this.trackerConfig.states.canceled) {
      logger.warn(
        `[${this.trackerConfig.kind}] states.canceled 미구성 — canceled 상태 전환 시 자동 터미네이트가 비활성화됩니다. ` +
        `자동 터미네이트를 활성화하려면 tracker 설정의 states.canceled에 취소 상태명을 지정하세요.`,
      );
    }
    this.startHumanChannel(); // humanChannel 먼저 시작 (recoverFromWorkspaces에서 필요)

    // DiffSender 초기화 (humanChannel이 WebClient를 보유)
    if (this.humanChannel) {
      this.diffSender = new DiffSender(this.humanChannel.getWebClient(), this.diffQueueStore, {
        interFileDelayMs: this.config.slack?.inter_file_delay_ms ?? 1_000,
      });
      void this.resumePendingDiffs();
    }

    void this.recoverFromWorkspaces();
    this.trackerPoller = new TrackerPoller(
      this.tracker,
      this.trackerConfig.poll_interval_ms,
      (candidates) => this.handleCandidates(candidates),
    );
    this.trackerPoller.start();
    this.startRepoPoller();
    this.startCredentialRefreshInterval();
  }

  /** 5분마다 모든 활성 컨테이너에 Claude 자격증명을 재주입한다. */
  private startCredentialRefreshInterval(): void {
    if (this.config.workspace_backend !== 'docker') return;
    const authMount = this.config.docker?.auth_mount;
    this.credentialRefreshInterval = setInterval(() => {
      for (const entry of this.running.values()) {
        const container = entry.containerName;
        if (!container) continue;
        void injectClaudeCredentials(container, authMount).catch((err) => {
          logger.warn(`Failed to refresh credentials for ${entry.issue.identifier}`, { container, error: String(err) });
        });
      }
    }, 5 * 60 * 1000);
  }

  /** 시작 시 미전송 diff 큐를 이어서 전송한다. */
  private async resumePendingDiffs(): Promise<void> {
    if (!this.diffSender) return;
    const pending = this.diffQueueStore.getPendingIdentifiers();
    if (pending.length === 0) return;

    logger.info(`Resuming ${pending.length} pending diff queue(s)`);
    for (const identifier of pending) {
      try {
        await this.diffSender.sendPendingDiffs(identifier);
      } catch (err) {
        logger.warn(`Failed to resume diff send for ${identifier}`, { error: String(err) });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.credentialRefreshInterval) {
      clearInterval(this.credentialRefreshInterval);
      this.credentialRefreshInterval = null;
    }
    this.trackerPoller?.stop();
    for (const p of this.repoPollers.values()) p.stop();
    await this.humanChannel?.stop();
    for (const entry of this.running.values()) {
      entry.abortController.abort();
    }
    this.running.clear();
    const shutdownTs = new Date().toISOString();
    for (const [identifier, stream] of this.agentLogStreams) {
      stream.write(`[orchestrator shutdown] ${shutdownTs}\n`);
      stream.end();
    }
    this.agentLogStreams.clear();
    removeFileSink(this.fileSink);
    this.symphonyStream.end(`[orchestrator shutdown] ${shutdownTs}\n`);
    logger.info('Orchestrator stopped');
  }

  async stopAndWait(gracePeriodMs: number): Promise<void> {
    // stop()이 abort하기 전에 promise 수집 (abort → settle → delete 순서)
    const agentPromises = [...this.running.values()].map((e) => e.promise);
    this.stop();

    if (agentPromises.length === 0) return;

    logger.info(`Waiting for ${agentPromises.length} agent(s) to finish (grace=${gracePeriodMs}ms)`);

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs));
    await Promise.race([Promise.allSettled(agentPromises), timeout]);
  }

  /**
   * 핫 리로드를 위한 그레이스풀 드레인: 폴러 정지(새 디스패치 차단),
   * 실행 중인 에이전트 완료 대기(abort 없음), humanChannel 정지 후
   * 교체 오케스트레이터에 전달할 상태를 반환한다.
   */
  async drainForSwap(gracePeriodMs = 120_000): Promise<TransferableState> {
    // 1. 폴러 정지 — 새 dispatch 차단
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.trackerPoller?.stop();
    for (const p of this.repoPollers.values()) p.stop();

    // 2. 실행 중 에이전트 완료 대기 (abort 안 함)
    const promises = [...this.running.values()].map((r) => r.promise);
    if (promises.length > 0) {
      logger.info(`Draining ${promises.length} running agent(s) before config reload...`);
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs)),
      ]);

      // 타임아웃 후에도 남아있는 에이전트는 강제 중단
      if (this.running.size > 0) {
        logger.warn(`Drain timeout: aborting ${this.running.size} remaining agent(s)`);
        for (const entry of this.running.values()) {
          entry.abortController.abort();
        }
        this.running.clear();
      }
    }

    // 3. humanChannel 정지 (에이전트 완료 처리 후)
    await this.humanChannel?.stop();

    // 4. 리소스 해제 (stop()과 동일 — FD 누수 및 자격증명 중복 주입 방지)
    const drainTs = new Date().toISOString();
    for (const [, stream] of this.agentLogStreams) {
      stream.end(`[orchestrator drain] ${drainTs}\n`);
    }
    this.agentLogStreams.clear();
    if (this.credentialRefreshInterval) {
      clearInterval(this.credentialRefreshInterval);
      this.credentialRefreshInterval = null;
    }
    removeFileSink(this.fileSink);
    this.symphonyStream.end(`[orchestrator drain] ${drainTs}\n`);

    // 5. 상태 추출 (admission 상태 포함 — 핫 리로드 시 새 orchestrator에 전이)
    return {
      issuePhases: new Map(this.issuePhases),
      pendingDispatch: new Set(this.pendingDispatch),
      watchedIssues: new Map(this.watchedIssues),
      queuedComments: new Map(this.queuedComments),
      recentlyMerged: new Map(this.recentlyMerged),
      recentlyTerminated: new Map(this.recentlyTerminated),
      missingTickCounts: new Map(this.missingTickCounts),
      canceledPendingMap: new Map(this.canceledPendingMap),
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      admittedIdentifiers: this.limiter.snapshot(),
    };
  }

  /**
   * 이전 오케스트레이터 인스턴스의 상태를 주입한다 (핫 리로드용).
   * start() 호출 전에 사용한다.
   */
  injectState(state: TransferableState): void {
    for (const [k, v] of state.issuePhases) this.issuePhases.set(k, v);
    for (const v of state.pendingDispatch) this.pendingDispatch.add(v);
    for (const [k, v] of state.watchedIssues) this.watchedIssues.set(k, v);
    for (const [k, v] of state.queuedComments) this.queuedComments.set(k, v);
    for (const [k, v] of state.recentlyMerged) this.recentlyMerged.set(k, v);
    for (const [k, v] of (state.recentlyTerminated ?? [])) this.recentlyTerminated.set(k, v);
    for (const [k, v] of (state.missingTickCounts ?? [])) this.missingTickCounts.set(k, v);
    for (const [k, v] of (state.canceledPendingMap ?? [])) this.canceledPendingMap.set(k, v);
    this.completedCount = state.completedCount;
    this.failedCount = state.failedCount;
    // admission 상태 복원: 공유 limiter가 비어있을 때만 주입 (다중 트래커 중복 경고 방지)
    if (this.limiter.size() === 0) {
      for (const id of state.admittedIdentifiers ?? []) {
        this.limiter.forceAdmit(id);
      }
      if (this.limiter.size() > this.limiter.maxContainers) {
        logger.warn(
          `Hot-reload over-committed: admitted=${this.limiter.size()} > max_containers=${this.limiter.maxContainers}. ` +
          `New issues will be blocked until existing containers are cleaned up.`,
        );
      }
    }
  }

  /**
   * 시작 시 기존 워크스페이스를 탐색하고
   * 아직 활성 상태인 이슈를 재디스패치한다.
   */
  private async recoverFromWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.io.list();
      // splice 전에 계산: 초과 워크스페이스도 실제로 존재하므로
      // container-lost 감지에서 "워크스페이스 없음"으로 오판하지 않도록 전체 ID를 유지.
      const wsIdentifiers = new Set(workspaces.map((ws) => ws.identifier).filter(Boolean));

      if (workspaces.length > MAX_RECOVERY_WORKSPACES) {
        logger.warn(
          `Recovery: found ${workspaces.length} workspace(s) — exceeds MAX_RECOVERY_WORKSPACES=${MAX_RECOVERY_WORKSPACES}. ` +
          `최신 ${MAX_RECOVERY_WORKSPACES}개만 복구합니다. 초과 워크스페이스는 자동 정리되지 않으므로 필요 시 수동으로 제거하세요.`,
        );
        workspaces.splice(MAX_RECOVERY_WORKSPACES);
      } else if (workspaces.length > 0) {
        logger.info(`Recovery: found ${workspaces.length} existing workspace(s)`);
      }

      // Docker 환경에서만 컨테이너 상태 관리
      const isDocker = this.config.workspace_backend === 'docker';

      // Phase 1: 이 트래커 소속 워크스페이스 확인 및 pre-admit (교차 트래커 오염 방지)
      // fetchIssueByIdentifier 결과를 캐시하여 Phase 2에서 재사용 (API 호출 횟수 불변)
      const issueCache = new Map<string, Issue>(); // identifier → issue
      for (const ws of workspaces) {
        const identifier = ws.identifier;
        if (!identifier) continue;
        try {
          const issue = await this.tracker.fetchIssueByIdentifier(identifier);
          if (issue) {
            this.limiter.forceAdmit(identifier);
            issueCache.set(identifier, issue);
          }
          // else: 이 트래커 소속 아님 또는 삭제 → pre-admit 건너뜀
        } catch (err) {
          logger.warn(`Recovery: failed to check ownership for ${identifier}`, { error: String(err) });
        }
      }
      if (this.limiter.size() > this.limiter.maxContainers) {
        logger.warn(
          `Recovery over-committed: admitted=${this.limiter.size()} existing workspace(s), ` +
          `max_containers=${this.limiter.maxContainers}. ` +
          `New issues will be blocked until existing workspaces are cleaned up.`,
        );
      } else if (this.limiter.size() > 0) {
        logger.info(`Recovery: pre-admitted ${this.limiter.size()} workspace(s) into container cap`);
      }

      // Phase 2: 컨테이너 복원 및 dispatch
      for (const ws of workspaces) {
        const identifier = ws.identifier;
        if (!identifier) continue;
        // Phase 1에서 소유권이 확인된 워크스페이스만 처리
        const issue = issueCache.get(identifier);
        if (!issue) continue;

        try {
          // 컨테이너 상태 확인 및 복구 (Docker 백엔드)
          if (isDocker) {
            const running = await isContainerRunning(ws.name);
            if (!running) {
              logger.info(`Recovery: ${identifier} — container stopped, restarting`);
              const started = await restartStoppedContainer(ws.name);
              if (!started) {
                logger.warn(`Recovery: ${identifier} — failed to restart container`);
                this.limiter.release(identifier); // 컨테이너 복구 실패 → 슬롯 반납
                continue;
              }
            }
            // 이전 오케스트레이터 실행의 잔존 claude 프로세스 정리
            await killClaudeProcesses(ws.name);
          }

          this.trackWatchedIssue(issue);

          // phase.json에서 마지막 phase 복원 시도
          const wsRef = this.io.refFromName(ws.name);
          let persistedPhase: IssuePhase | null = null;
          try {
            const phaseJson = await this.io.readFile(wsRef, '.symphony/phase.json');
            if (phaseJson) {
              const parsed = JSON.parse(phaseJson) as { phase?: IssuePhase };
              if (parsed.phase) persistedPhase = parsed.phase;
            }
          } catch { /* non-fatal */ }

          if (persistedPhase) {
            logger.info(`Recovery: ${identifier} — restored phase "${persistedPhase}" from phase.json`);
          }

          const decision = this.resolveRecoveryDecision(issue, persistedPhase);
          switch (decision.action) {
            case 'forget':
              logger.info(`Recovery: ${identifier} — terminal/merged, cleaning up`);
              this.humanChannel?.forgetThread(identifier);
              this.clearPhase(identifier);
              this.limiter.release(identifier);
              break;
            case 'skip':
              this.issuePhases.delete(identifier);
              this.costCommentWritten.delete(identifier);
              break;
            case 'wait':
              // unwatch() + clearPhase() 경쟁 조건: clearPhase가 죽은 컨테이너에서 실패하면
              // phase.json은 WAITING_PHASE를 유지하지만 active=false가 디스크에 남을 수 있다.
              // 이 경우 Slack 이벤트(리액션/채팅)가 모두 무시되므로 thread를 재활성화한다.
              this.issuePhases.set(identifier, decision.inferredPhase);
              this.humanChannel?.reactivateThread(identifier);
              logger.info(`Recovery: ${identifier} → waiting phase "${decision.inferredPhase}", skipping dispatch`);
              break;
            case 'dispatch':
              if (!this.running.has(issue.id)) {
                logger.info(`Recovery: re-dispatching ${identifier} (restored phase="${persistedPhase ?? issue.state}")`);
                this.dispatch(issue, { reason: 'recovery', resumeMessage: decision.resumeMessage });
              }
              break;
          }
        } catch (err) {
          logger.warn(`Recovery: failed to process workspace ${ws.name}`, { error: String(err) });
        }
      }

      // 컨테이너 소실 감지: Slack 스레드는 있지만 워크스페이스가 없는 이슈
      if (this.humanChannel) {
        const watchedIds = this.humanChannel.getAllWatchedIdentifiers();
        for (const id of watchedIds) {
          if (wsIdentifiers.has(id)) continue; // 워크스페이스 있음 → 이미 처리됨

          try {
            const issue = await this.tracker.fetchIssueByIdentifier(id);
            if (!issue) {
              this.humanChannel.forgetThread(id);
              this.clearPhase(id);
              continue;
            }

            const openPR = await this.findOpenPRForIssue(id);
            const decision = this.resolveRecoveryDecision(issue, null, true, openPR);
            switch (decision.action) {
              case 'forget':
                this.humanChannel.forgetThread(id);
                this.clearPhase(id);
                break;
              case 'skip':
                this.issuePhases.delete(id);
                this.costCommentWritten.delete(id);
                break;
              case 'wait': {
                this.issuePhases.set(id, decision.inferredPhase);
                this.humanChannel.reactivateThread(id);
                logger.info(`Recovery: ${id} — container lost but waiting state, reactivating thread (no dispatch)`);
                const waitMsg = openPR
                  ? `⚠️ *[${formatIssueLabel(issue)}]* 컨테이너가 초기화되었습니다. 기존 PR #${openPR.number} 가 있으므로 새 작업은 시작하지 않습니다. PR 코멘트로 피드백을 보내면 처리됩니다.`
                  : decision.inferredPhase === 'plan_sent'
                    ? `⚠️ *[${formatIssueLabel(issue)}]* 컨테이너가 초기화되었습니다. 위 계획을 확인하고 승인(✅) 또는 피드백을 보내주세요.`
                    : `⚠️ *[${formatIssueLabel(issue)}]* 컨테이너가 초기화되었습니다. 위 리뷰를 확인하고 승인(✅) 또는 피드백을 보내주세요.`;
                await this.humanChannel.sendNotification(issue, waitMsg).catch((err) => {
                  logger.warn(`Recovery: failed to notify for ${id}`, { error: String(err) });
                });
                break;
              }
              case 'dispatch': {
                logger.info(`Recovery: ${id} — container lost, re-dispatching (state="${issue.state}")`);
                this.trackWatchedIssue(issue);
                this.issuePhases.delete(id);
                this.costCommentWritten.delete(id);
                await this.humanChannel.sendNotification(
                  issue,
                  `⚠️ *[${formatIssueLabel(issue)}]* 컨테이너가 초기화되었습니다. 마지막 체크포인트부터 재개합니다.`,
                ).catch((err) => {
                  logger.warn(`Recovery: failed to notify container loss for ${id}`, { error: String(err) });
                });
                if (!this.running.has(issue.id)) {
                  this.dispatch(issue, { reason: 'recovery', resumeMessage: decision.resumeMessage });
                  if (!this.running.has(issue.id)) {
                    logger.warn(`Recovery: dispatch failed for ${id} (state="${issue.state}") — container not created`);
                    void this.humanChannel.sendNotification(
                      issue,
                      `⚠️ *[${formatIssueLabel(issue)}]* dispatch 실패: 컨테이너를 생성할 수 없습니다. 컨테이너 cap, 에이전트 라벨, 레포 설정을 확인하세요.`,
                    ).catch((err) => {
                      logger.warn(`Recovery: failed to send dispatch failure notification for ${id}`, { error: String(err) });
                    });
                  } else {
                    logger.info(`Recovery: ${id} — dispatch confirmed (state="${issue.state}")`);
                  }
                }
                break;
              }
            }
          } catch (err) {
            logger.warn(`Recovery: failed to check lost container for ${id}`, { error: String(err) });
          }
        }
      }

      // 워크스페이스 없는 stale 스레드도 정리
      await this.pruneStaleThreads();
    } catch (err) {
      logger.warn('Recovery: failed to list workspaces', { error: String(err) });
    }
  }

  snapshot(): OrchestratorSnapshot {
    return {
      trackerId: trackerLabel(this.trackerConfig),
      running: [...this.running.values()],
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      repoEvents: [...this.repoEvents],
      admittedCount: this.limiter.size(),
      maxContainers: this.limiter.maxContainers,
    };
  }

  // ---------------------------------------------------------------------------
  // 후보 이슈 처리 (TrackerPoller에서 호출)
  // ---------------------------------------------------------------------------

  private async handleCandidates(candidates: Issue[]): Promise<void> {
    if (this.stopped) return;

    // 만료된 recentlyMerged / recentlyTerminated 항목 정리
    const ttl = this.trackerConfig.poll_interval_ms * 2;
    const now = Date.now();
    for (const [id, ts] of this.recentlyMerged) {
      if (now - ts > ttl) this.recentlyMerged.delete(id);
    }
    for (const [id, ts] of this.recentlyTerminated) {
      if (now - ts > ttl) this.recentlyTerminated.delete(id);
    }

    this.pruneStaleAgents();

    if (candidates.length > 0 || this.running.size > 0) {
      logger.debug(
        `Poll: found ${candidates.length} candidate issue(s) for tracker ${trackerLabel(this.trackerConfig)} (${this.running.size} running)`,
      );
    }

    // 실행 중 에이전트 조정 — 더 이상 활성 상태가 아닌 이슈 제거
    await this.reconcileRunning(candidates);

    // 새 이슈 디스패치 (컨테이너 수 제한 적용)
    //  - 이미 admitted된 이슈(재-dispatch): cap 소진 여부와 무관하게 통과
    //  - 새 이슈: available 슬롯 내에서만 처리, 나머지는 다음 poll에서 재시도
    // candidates 목록 기반 canceled 드롭 감지 (states.canceled 구성 시)
    await this.detectDroppedIssues(candidates);

    const notRunning = candidates
      .filter((issue) => !this.running.has(issue.id))
      .filter((issue) => !this.isBlocked(issue, candidates))
      .filter((issue) => !WAITING_PHASES.has(this.issuePhases.get(issue.identifier) as IssuePhase))
      .filter((issue) => !this.recentlyTerminated.has(issue.identifier))
      .filter((issue) => !this.recentlyMerged.has(issue.identifier))
      .filter((issue) => {
        // planning 상태 + 기존 Slack 스레드 있음 = 사용자 의도 중지 → 건너뜀
        const planningNorm = this.trackerConfig.states.planning.toLowerCase().trim();
        if (issue.state.toLowerCase().trim() === planningNorm && this.humanChannel?.isWatching(issue.identifier)) {
          logger.debug(`Skipping ${issue.identifier}: planning state with existing thread (user paused)`);
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

    const alreadyAdmitted = notRunning.filter((i) => this.limiter.has(i.identifier));
    const newCandidates = notRunning.filter((i) => !this.limiter.has(i.identifier));

    const available = this.limiter.available();
    const newToDispatch = newCandidates.slice(0, available);
    const skipped = newCandidates.length - newToDispatch.length;

    if (skipped > 0) {
      logger.info(`Container cap reached (admitted=${this.limiter.size()}/${this.limiter.maxContainers}); skipping ${skipped} new issue(s) this poll`);
    }

    const toDispatch = [...alreadyAdmitted, ...newToDispatch];
    for (const issue of toDispatch) {
      this.dispatch(issue);
    }
  }

  // ---------------------------------------------------------------------------
  // 실행 중 조회 헬퍼
  // ---------------------------------------------------------------------------

  /** 주어진 Linear identifier(예: "TES-7")에 대해 에이전트가 실행 중인지 확인한다.
   *  running 맵은 내부 UUID를 키로 사용하므로 identifier로 스캔한다. */
  private isRunningByIdentifier(identifier: string): boolean {
    for (const entry of this.running.values()) {
      if (entry.issue.identifier === identifier) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 에이전트 선택
  // ---------------------------------------------------------------------------

  /**
   * 주어진 이슈에 실행해야 할 설정된 에이전트의 부분 집합을 반환한다.
   *
   * 트리거 동작 (에이전트별):
   *  - 트리거 없음: 항상 실행.
   *  - trigger.issue_labels (비어있지 않음): 이슈에 일치하는 레이블이 하나 이상 있어야 함.
   *  - trigger.pr_labels (비어있지 않음): prLabels 컨텍스트가 제공된 경우에만 확인;
   *    PR에 일치하는 레이블이 하나 이상 있어야 함.
   *  지정된 모든 적용 가능한 조건을 통과해야 함 (AND).
   */
  private selectAgents(issue: Issue, prLabels?: string[]): AgentConfig[] {
    return this.config.agents.backends.filter((agent) => {
      const trigger = agent.trigger;
      if (!trigger) return true;

      if (trigger.issue_labels && trigger.issue_labels.length > 0) {
        const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
        const match = trigger.issue_labels.some((l) => issueLabels.has(l.toLowerCase()));
        if (!match) return false;
      }

      if (trigger.pr_labels && trigger.pr_labels.length > 0 && prLabels) {
        const prLabelSet = new Set(prLabels.map((l) => l.toLowerCase()));
        const match = trigger.pr_labels.some((l) => prLabelSet.has(l.toLowerCase()));
        if (!match) return false;
      }

      if (trigger.assignees && trigger.assignees.length > 0) {
        const match = trigger.assignees.some(
          (email) => email.toLowerCase() === issue.assigneeEmail?.toLowerCase(),
        );
        if (!match) return false;
      }

      return true;
    });
  }

  /**
   * 주어진 이슈에 사용할 레포지토리를 결정한다 (멀티 레포 지원).
   * 우선순위: issue_labels 매칭 → 기본 레포 → 첫 번째 레포 → 단일 레포지토리 폴백.
   */
  private resolveRepository(issue: Issue): RepositoryConfig | null {
    const repos = this.trackerConfig.repositories ?? [];
    if (repos.length === 0) return this.trackerConfig.repository ?? null;
    if (repos.length === 1) return repos[0];

    // 레포 2개 이상: 이슈 레이블로 매칭 필수
    const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
    const matched = repos.find((r) =>
      r.issue_labels.length > 0 && r.issue_labels.some((l) => issueLabels.has(l.toLowerCase())),
    );
    return matched ?? null;
  }

  /**
   * 이슈와 레포 설정을 기반으로 base 브랜치를 결정한다.
   * - hotfix 레이블이 있는 이슈 → branch_strategy.production
   * - 그 외 → branch_strategy.development
   */
  private resolveBaseBranch(issue: Issue, repo: RepositoryConfig): string {
    const strategy = repo.branch_strategy;
    const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
    const isHotfix = strategy.hotfix_labels.some((l) => issueLabels.has(l.toLowerCase()));
    return isHotfix ? strategy.production : strategy.development;
  }

  /**
   * branch_strategy 설정 오류 여부를 확인한다.
   * - protect_production이 true이고, development === production인데 비-핫픽스 이슈인 경우
   *   development 브랜치가 운영 브랜치와 동일해 보호 의도가 무효화됨을 경고한다.
   * - 실제 차단은 하지 않고 warn 로그만 출력하는 용도로 사용한다.
   */
  private isDevBranchMisconfigured(issue: Issue, repo: RepositoryConfig): boolean {
    const strategy = repo.branch_strategy;
    if (!strategy.protect_production) return false;
    const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
    const isHotfix = strategy.hotfix_labels.some((l) => issueLabels.has(l.toLowerCase()));
    // dev_branch == prod_branch이고 비-핫픽스인 경우: 설정 오류
    return !isHotfix && strategy.development === strategy.production;
  }

  // ---------------------------------------------------------------------------
  // watchedIssues 헬퍼
  // ---------------------------------------------------------------------------

  private trackWatchedIssue(issue: Issue): void {
    this.watchedIssues.set(issue.identifier, issue);
    if (this.watchedIssues.size > 500) {
      // Map은 삽입 순서 보장 — 가장 오래된 항목 제거
      const firstKey = this.watchedIssues.keys().next().value;
      if (firstKey !== undefined) this.watchedIssues.delete(firstKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 헬퍼 — phase를 .symphony/phase.json에 영속화
  // ---------------------------------------------------------------------------

  private setPhase(identifier: string, phase: IssuePhase): void {
    this.issuePhases.set(identifier, phase);
    const issue = this.watchedIssues.get(identifier);
    let ref: WorkspaceRef;
    if (issue) {
      ref = this.io.refForIssue(issue);
    } else {
      ref = this.io.refFromName(this.io.nameForIssue({ identifier }));
    }
    void this.io.writeFile(ref, '.symphony/phase.json', JSON.stringify({ phase })).catch(() => {});
  }

  private clearPhase(identifier: string): void {
    this.issuePhases.delete(identifier);
    this.costCommentWritten.delete(identifier);
    const issue = this.watchedIssues.get(identifier);
    let ref: WorkspaceRef;
    if (issue) {
      ref = this.io.refForIssue(issue);
    } else {
      ref = this.io.refFromName(this.io.nameForIssue({ identifier }));
    }
    void this.io.writeFile(ref, '.symphony/phase.json', '').catch(() => {});
  }

  /**
   * 이슈 identifier 로 등록된 모든 repoPollers 를 순회하며 오픈 PR 을 찾는다.
   * 일시적 네트워크 오류를 흡수하기 위해 5회 백오프 재시도(200ms → 3.2s, 총 ~6.2초).
   * 5회 모두 실패하면 null 반환(= "PR 없음" 으로 폴백) + warn 로그.
   * 컨테이너 소실 복구 시 기존 PR 보호 분기에서 사용한다.
   */
  private async findOpenPRForIssue(identifier: string): Promise<PullRequest | null> {
    const delays = [200, 400, 800, 1600, 3200];
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < delays.length; attempt++) {
      let anyPollerSucceeded = false;
      for (const poller of this.repoPollers.values()) {
        try {
          const pr = await poller.findOpenPRByIssue(identifier);
          anyPollerSucceeded = true;
          if (pr) return pr;
        } catch (err) {
          lastErr = err;
          logger.debug(`findOpenPRForIssue: poller threw for ${identifier} (attempt ${attempt + 1})`, { error: String(err) });
        }
      }
      if (anyPollerSucceeded) return null;
      if (attempt < delays.length - 1) await new Promise((r) => setTimeout(r, delays[attempt]));
    }

    logger.warn(
      `findOpenPRForIssue: PR lookup failed after ${delays.length} retries for ${identifier} — falling back to dispatch`,
      { error: String(lastErr) },
    );
    return null;
  }

  private resolveRecoveryDecision(
    issue: Issue,
    persistedPhase: IssuePhase | null,
    containerLost = false,
    openPR: PullRequest | null = null,
  ): RecoveryDecision {
    const identifier = issue.identifier;
    const stateNorm = issue.state.toLowerCase().trim();

    const terminalNorm = this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim());
    const planningNorm = this.trackerConfig.states.planning.toLowerCase().trim();
    const planReviewNorm = this.trackerConfig.states.plan_review.toLowerCase().trim();
    const inReviewNorm = this.trackerConfig.states.in_review.toLowerCase().trim();
    const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());

    // 1. 최근 종료/머지 → 스레드 정리
    if (this.recentlyMerged.has(identifier) || this.recentlyTerminated.has(identifier)) {
      return { action: 'forget' };
    }

    // 2. Terminal state → 스레드 정리
    if (terminalNorm.includes(stateNorm)) {
      return { action: 'forget' };
    }

    // 3. Planning state → 사용자가 의도적으로 멈춘 것, 건드리지 않음
    if (stateNorm === planningNorm) {
      return { action: 'skip' };
    }

    // 4. Phase 기반 판단 (phase.json에서 복원된 경우)
    if (persistedPhase !== null) {
      if (WAITING_PHASES.has(persistedPhase)) {
        return { action: 'wait', inferredPhase: persistedPhase };
      }
      return {
        action: 'dispatch',
        resumeMessage: '시스템이 재시작되었습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.',
      };
    }

    // 5. Phase 없음 → 트래커 상태로 추론
    if (stateNorm === planReviewNorm) {
      return { action: 'wait', inferredPhase: 'plan_sent' };
    }
    if (stateNorm === inReviewNorm) {
      // 컨테이너 소실 + 기존 PR 존재: 작업 내용이 PR 브랜치에 보존되어 있으므로
      // dispatch 로 처음부터 다시 시작하지 않고 wait. PR 코멘트가 새로 달리면
      // handleNewComments 가 자연스럽게 새 dispatch 를 트리거한다.
      if (containerLost && openPR) {
        return { action: 'wait', inferredPhase: 'review_sent' };
      }
      // 컨테이너가 소실되었고 PR 도 없음: 슬랙 피드백을 처리할 에이전트가 없으므로 dispatch
      if (containerLost) {
        return {
          action: 'dispatch',
          resumeMessage: '컨테이너가 초기화되었습니다. PR 리뷰 상태를 확인하고, 받은 피드백이 있으면 처리하세요.',
        };
      }
      return { action: 'wait', inferredPhase: 'review_sent' };
    }
    if (activeNorm.includes(stateNorm)) {
      // active 상태에서도 컨테이너 소실 + 기존 PR 존재 시 보존 (review_sent 로 wait)
      if (containerLost && openPR) {
        return { action: 'wait', inferredPhase: 'review_sent' };
      }
      return {
        action: 'dispatch',
        resumeMessage: '시스템이 재시작되었습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.',
      };
    }

    // 6. 그 외 (비활성, 알 수 없음) → skip
    return { action: 'skip' };
  }

  // ---------------------------------------------------------------------------
  // 에이전트 로그 파일 헬퍼
  // ---------------------------------------------------------------------------

  private openAgentLogStream(identifier: string, reason: DispatchReason): void {
    // 이 identifier의 기존 스트림을 닫음 (발생해서는 안 되지만 안전하게 처리)
    this.closeAgentLogStream(identifier);

    const logPath = path.join(this.logsDir, `${identifier}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (err) => {
      logger.warn(`Agent log stream error for ${identifier}`, { error: String(err) });
    });

    const ts = new Date().toISOString();
    stream.write(`\n=== [${identifier}] ${ts} reason=${reason} ===\n`);
    this.agentLogStreams.set(identifier, stream);
  }

  private closeAgentLogStream(identifier: string): void {
    const stream = this.agentLogStreams.get(identifier);
    if (stream) {
      stream.end();
      this.agentLogStreams.delete(identifier);
    }
  }

  // ---------------------------------------------------------------------------
  // 디스패치
  // ---------------------------------------------------------------------------

  private dispatch(
    issue: Issue,
    opts: { prLabels?: string[]; reason?: DispatchReason; retryCount?: number; resumeMessage?: string; prFeedbackPayload?: string; retryReason?: string } = {},
  ): void {
    if (this.stopped) return;
    if (this.running.has(issue.id)) {
      logger.debug(`Issue ${issue.identifier} already running; skipping dispatch`);
      return;
    }

    const { prLabels, reason = 'new_issue', retryCount = 0, resumeMessage, retryReason } = opts;

    // 첫 디스패치 시 phase 초기화 (recovery/retry 포함)
    if (!this.issuePhases.has(issue.identifier)) {
      this.setPhase(issue.identifier, 'initial');
    }
    // 이슈를 admission set에 등록 (already admitted이면 idempotent)
    // handleCandidates()에서 already-admitted 이슈는 cap 체크 없이 통과하므로 여기서는
    // 실질적으로 admit 실패가 발생하지 않지만, 직접 dispatch() 호출 경로를 위해 가드 유지.
    if (!this.limiter.admit(issue.identifier)) {
      logger.warn(`Container cap reached; skipping dispatch for ${issue.identifier} (admitted=${this.limiter.size()}/${this.limiter.maxContainers})`);
      return;
    }
    const agents = this.selectAgents(issue, prLabels);

    if (agents.length === 0) {
      logger.info(`No matching agents for ${issue.identifier}; skipping dispatch`);
      this.limiter.release(issue.identifier);
      this.clearPhase(issue.identifier);
      if (this.humanChannel && !this.labelMismatchNotified.has(issue.identifier)) {
        this.labelMismatchNotified.add(issue.identifier);
        const wsName = this.io.nameForIssue(issue);
        void this.humanChannel.sendNotification(
          issue,
          `⚠️ *[${formatIssueLabel(issue)}]* 이슈 라벨이 설정되지 않았거나 매칭되는 에이전트가 없습니다. 이슈에 올바른 라벨을 추가해주세요.`,
          wsName,
        ).catch((err) => {
          logger.warn(`Failed to notify label mismatch for ${issue.identifier}`, { error: String(err) });
        });
      }
      return;
    }

    // 레포 해석 — 멀티레포 시 라벨 매칭 필수
    const resolvedRepo = this.resolveRepository(issue);
    if (!resolvedRepo && (this.trackerConfig.repositories ?? []).length > 1) {
      logger.warn(`No matching repository for ${issue.identifier}; skipping dispatch (check issue labels)`);
      this.limiter.release(issue.identifier);
      if (this.humanChannel && !this.labelMismatchNotified.has(issue.identifier)) {
        this.labelMismatchNotified.add(issue.identifier);
        const wsName = this.io.nameForIssue(issue);
        void this.humanChannel.sendNotification(
          issue,
          `⚠️ *[${formatIssueLabel(issue)}]* 이슈 라벨이 설정되지 않았거나 매칭되는 레포가 없습니다. 이슈에 올바른 라벨을 추가해주세요.`,
          wsName,
        ).catch((err) => {
          logger.warn(`Failed to notify label mismatch for ${issue.identifier}`, { error: String(err) });
        });
      }
      return;
    }

    // base 브랜치 결정 (hotfix → production, 일반 → development)
    // resolvedRepo가 null인 경우(레포 미설정)에는 trackerConfig.repository의 branch_strategy를 시도하고,
    // 그마저 없으면 'main'으로 폴백한다.
    const effectiveRepo = resolvedRepo ?? this.trackerConfig.repository ?? null;
    const baseBranch = effectiveRepo ? this.resolveBaseBranch(issue, effectiveRepo) : 'main';

    // branch_strategy 설정 오류 감지: dev == prod이고 비-핫픽스인 경우 경고
    if (effectiveRepo && this.isDevBranchMisconfigured(issue, effectiveRepo)) {
      logger.warn(
        `[${issue.identifier}] branch_strategy 설정 오류: ` +
        `development="${effectiveRepo.branch_strategy.development}"과 production="${effectiveRepo.branch_strategy.production}"이 동일합니다. ` +
        `protect_production=true 설정이 무효화됩니다. development 브랜치를 별도로 설정하세요.`,
      );
    }

    // phase에 따른 모델 결정
    const model = this.resolveModel(agents, issue.identifier);

    // 정상 dispatch 확정 — 레이블 불일치 알림 플래그 초기화 (라벨 수정 후 재시도 시 알림 재발송 허용)
    this.labelMismatchNotified.delete(issue.identifier);

    logger.debug(
      `Dispatching issue ${issue.identifier} to ${agents.map((a) => a.kind).join(', ')} agent(s)` +
        (model ? ` model=${model}` : '') + ` base_branch=${baseBranch}`,
    );

    // 이슈별 로그 파일 열기 (추가 모드 — 여러 세션이 누적됨)
    this.openAgentLogStream(issue.identifier, reason);

    const abortController = new AbortController();

    const entry: RunningEntry = {
      issue,
      promise: Promise.resolve(), // filled below
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      containerName: null,
      agentLogLines: [],
      reason,
      abortController,
      retryCount,
    };

    // 선택된 에이전트 설정에서 개발자별 Claude 인증 디렉터리 가져오기
    const claudeAuthDir = agents.find((a): a is ClaudeAgentConfig => a.kind === 'claude')?.claude_auth_dir;

    // 이전 실행의 잔존 파일 방지 — 에이전트가 새로 쓴 것만 감지되도록 클리어
    const ref = this.io.refForIssue(issue);

    const promise = logContext.run({ identifier: issue.identifier }, async () => {
      await Promise.all([
        this.io.writeFile(ref, '.symphony/pending_plan.md', ''),
        this.io.writeFile(ref, '.symphony/pending_review.md', ''),
        this.io.writeFile(ref, '.symphony/pending_reply.md', ''),
      ]).catch(() => {});
      return runIssue(issue, this.tracker, this.config, this.promptTemplate, agents, {
      trackerKind: this.trackerConfig.kind,
      repositoryKind: resolvedRepo?.kind,
      repository: resolvedRepo ?? undefined,
      trackerConfig: this.trackerConfig,
      activeStates: this.trackerConfig.active_states,
      states: this.trackerConfig.states,
      baseBranch,

      signal: abortController.signal,
      reason,
      resumeMessage,
      model,
      claudeAuthDir,
      prFeedbackPayload: opts.prFeedbackPayload,
      io: this.io,
      onMessage: (msg: AgentMessage) => this.handleAgentMessage(issue.id, msg),
      onTurnComplete: (info) => {
        this.costTracker.record(issue.identifier, info.cost, info.tokensTotal);
        this.handleAgentMessage(issue.id, {
          event: { type: 'turn_complete', cost: info.cost, tokens: info.tokensTotal },
          timestamp: new Date(),
        });
      },
      onRuntimeInfo: (info) => {
        const e = this.running.get(issue.id);
        if (e) {
          e.workerHost = info.workerHost;
          e.workspacePath = info.workspacePath;
          e.containerName = info.containerName ?? null;
        }
      },
    });
    });

    this.running.set(issue.id, entry);

    // 처음 폴링된 이슈 → 채널 알림 (이후 계획이 같은 스레드/댓글에 올라감)
    // 복구 디스패치(컨테이너가 이미 존재)에서는 보내지 않음
    if (reason === 'new_issue' && this.humanChannel && !this.humanChannel.isWatching(issue.identifier)) {
      const ref = this.io.refForIssue(issue);
      void this.io.exists(ref).then((exists) => {
        if (!exists) return this.notifyPlanStart(issue);
      }).catch((err) => {
        logger.warn(`Failed to check workspace/notify plan start for ${issue.identifier}`, { error: String(err) });
      });
    }

    // Recovery/retry 디스패치 알림
    if ((reason === 'recovery' || reason === 'retry') && this.humanChannel) {
      const text = reason === 'retry'
        ? retryReason === 'max_turns'
          ? `🔄 *[${formatIssueLabel(issue)}]* 최대 턴 수에 도달해 이어서 재시도합니다. (${retryCount}회)`
          : `🔄 *[${formatIssueLabel(issue)}]* 재시도합니다. (${retryCount}회)`
        : `🔄 *[${formatIssueLabel(issue)}]* 복구 디스패치 — 작업을 재개합니다.`;
      // workspaceName 전달: 기존 스레드가 없을 경우 SlackChannel이 새 스레드를 등록함
      const workspaceName = this.io.nameForIssue(issue);
      void this.humanChannel.sendNotification(issue, text, workspaceName).catch((err) => {
        logger.warn(`Failed to send ${reason} notification for ${issue.identifier}`, { error: String(err) });
      });
      this.logConversationToTracker(issue.id, '[Bot]', text);
    }

    const fullChain = promise
      .then(async () => {
        logger.info(`Agent completed for ${issue.identifier}`);
        // admission 슬롯은 컨테이너 lifecycle에 묶여 있으므로 여기서 해제하지 않는다.
        // 해제는 cleanupTerminalWorkspace() (에이전트 자연 완료 후 terminal 상태 감지 시) 또는
        // terminateIssue() (PR 머지 / canceled 전환 / 컨테이너 소실 시) 에서 수행된다.
        this.trackWatchedIssue(issue);
        this.completedCount++;
        try {
          // phase 기반 포스트프로세싱
          const phase = this.issuePhases.get(issue.identifier) ?? 'initial';

          // 컴팩션 유발 워크플로우 위반 감지:
          // pending_plan.md와 pr_created.json이 같은 디스패치에서 동시에 존재하는 것은
          // 항상 위반이다 — 정상 플로우라면 계획 승인 후 새 디스패치에서 구현하므로 공존 불가.
          {
            const _ref = this.io.refForIssue(issue);
            if (await this.io.exists(_ref)) {
              const [planRaw, prRaw] = await Promise.all([
                this.io.readFile(_ref, '.symphony/pending_plan.md').catch(() => null),
                this.io.readFile(_ref, '.symphony/pr_created.json').catch(() => null),
              ]);
              if (planRaw?.trim() && prRaw?.trim()) {
                logger.warn(
                  `[${issue.identifier}] Compaction-induced workflow violation: ` +
                  `pending_plan.md and pr_created.json both written in same dispatch (reason=${entry.reason})`,
                );
                if (this.humanChannel) {
                  await this.humanChannel
                    .sendNotification(
                      issue,
                      `⚠️ *[${formatIssueLabel(issue)}]* 컨텍스트 압축으로 인해 계획 승인 없이 코드가 푸시됐습니다. ` +
                      `PR을 직접 확인해 주세요.`,
                    )
                    .catch((err) =>
                      logger.warn(`Failed to send compaction-violation notification for ${issue.identifier}`, { error: String(err) }),
                    );
                }
                await this.clearPrFeedback(issue);
                return;
              }
            }
          }

          // PR 생성/업데이트 감지를 최우선으로 처리 (phase로 라우팅)
          const prHandled = phase === 'pr_fixing'
            ? await this.handlePrUpdated(issue)
            : await this.handlePrCreated(issue);

          // PR이 셀프리뷰 전에 조기 생성된 경우 경고 (셀프리뷰는 계속 진행해 이미 올라간 PR을 리뷰)
          if (prHandled && (phase === 'initial' || phase === 'implementing')) {
            logger.warn(`[${issue.identifier}] PR was created before self-review — running review on already-created PR`);
            if (this.humanChannel) {
              void this.humanChannel
                .sendNotification(
                  issue,
                  `⚠️ *[${formatIssueLabel(issue)}]* PR이 셀프리뷰 전에 생성되었습니다. 이미 생성된 PR에 대해 셀프리뷰를 진행합니다.`,
                )
                .catch((err) => logger.warn(`Failed to send early-PR warning for ${issue.identifier}`, { error: String(err) }));
            }
          }

          // handlePr* 내부에서 setPhase가 호출되었을 수 있으므로 stale 방지를 위해 재조회
          const currentPhase = this.issuePhases.get(issue.identifier) ?? phase;

          if (currentPhase === 'initial' || currentPhase === 'pr_fixing' || currentPhase === 'review_fixing') {
            // 계획/질문이 있으면 Slack에 보내고 종료 (셀프 리뷰보다 우선)
            const planSent = await this.handlePendingPlan(issue);
            if (planSent) return;

            const questionSent = await this.handleQuestion(issue);
            if (questionSent) return;
          }

          // pending_reply는 모든 phase에서 처리 (사용자 질문에 대한 답변)
          const replySent = await this.handlePendingReply(issue);
          if (replySent) return;

          // 셀프리뷰는 새 이슈 첫 구현 완료 시에만 실행 — pr_feedback/review_fix 디스패치는 스킵
          const isPrFixReason = entry.reason === 'pr_feedback' || entry.reason === 'review_fix';
          if ((currentPhase === 'initial' || currentPhase === 'implementing') && !isPrFixReason) {
            const reviewSent = await this.handlePendingReview(issue);
            if (reviewSent) return;
          } else if (currentPhase === 'pr_fixing' && !isPrFixReason) {
            // 조기 PR 생성 후 셀프리뷰 경로: 이미 올라간 PR을 대상으로 리뷰 전송
            const reviewSent = await this.handlePendingReview(issue, true);
            if (reviewSent) return;
          } else if (currentPhase === 'review_fixing' && !isPrFixReason) {
            // 에이전트가 pending_review.md를 수정했으면 재전송, 새 리뷰 생성은 안 함
            const reviewSent = await this.handlePendingReview(issue, true);
            if (reviewSent) return;
          } else if (isPrFixReason) {
            // 사용자 요청(pr_feedback/review_fix) 응답: 자동 리뷰 생성 없이, 에이전트가 작성한 pending_review.md만 전송
            const reviewSent = await this.handlePendingReview(issue, true);
            if (reviewSent) return;
          }
          await this.notifyWorkComplete(issue);
          await this.clearPrFeedback(issue);
          await this.cleanupTerminalWorkspace(issue);
        } catch (err) {
          logger.error(`Post-processing failed for ${issue.identifier}`, { error: String(err) });
        } finally {
          this.running.delete(issue.id);
          this.closeAgentLogStream(issue.identifier);
          if (!this.recentlyMerged.has(issue.identifier)) {
            this.drainCommentQueue(issue.identifier);
          }
        }
        this.emit('agent:completed', issue);
      })
      .catch(async (err: unknown) => {
        logger.error(`Agent failed for ${issue.identifier}`, { error: String(err) });
        this.running.delete(issue.id);
        this.closeAgentLogStream(issue.identifier);
        // admission 슬롯은 dispatch 실패 시에도 컨테이너가 살아있을 수 있으므로
        // 여기서 해제하지 않는다. 재시도로 이어지거나, 컨테이너 정리 시 해제된다.
        this.trackWatchedIssue(issue);

        // 최근 머지/터미네이트된 경우 재시도/드레인 건너뜀 (terminateIssue가 이미 정리 완료)
        if (this.recentlyMerged.has(issue.identifier) || this.recentlyTerminated.has(issue.identifier)) {
          this.clearPhase(issue.identifier);
          this.failedCount++;
          this.emit('agent:failed', issue, err);
          return;
        }

        // 오케스트레이터 shutdown 중이면 컨테이너 정리 없이 즉시 반환 (재시작 후 복구)
        if (this.stopped) {
          this.clearPhase(issue.identifier);
          this.emit('agent:failed', issue, err);
          return;
        }

        // 이슈가 여전히 활성 상태이고 재시도 횟수가 남은 경우 자동 재시도
        const maxRetries = this.config.agents.max_retries;
        const isMaxTurns = String(err).includes('error_max_turns');
        if (isMaxTurns || retryCount < maxRetries) {
          try {
            const [refreshed] = await this.tracker.fetchIssuesByIds([issue.id]);
            if (refreshed) {
              const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());
              const terminalNorm = this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim());
              const stateNorm = refreshed.state.toLowerCase().trim();
              // max_turns는 기술적 한계로 이슈 상태 무관하게 재시도 — 완료/취소(terminal)일 때만 예외
              const shouldRetry = isMaxTurns ? !terminalNorm.includes(stateNorm) : activeNorm.includes(stateNorm);
              if (shouldRetry) {
                const delayMs = this.config.agents.retry_backoff_ms * Math.pow(2, retryCount);
                logger.info(`Retrying ${issue.identifier} in ${delayMs}ms (retry ${retryCount + 1}/${maxRetries})${isMaxTurns ? ' [max_turns reached]' : ''}`);
                const resumeMessage = isMaxTurns
                  ? '최대 턴 수에 도달해 재시도합니다. 현재 워크스페이스 상태를 확인하고 작업을 이어서 진행하세요.\n\n**중요**: 절대 `git push`하거나 PR을 생성하지 마세요. 구현이 완료되면 final commit 후 종료하세요 — 오케스트레이터가 셀프리뷰를 실행합니다. (이미 PR이 존재하는 phase에서 재시작된 경우, 워크패드의 컨텍스트와 `.symphony/pr_feedback.json` 존재 여부로 현재 단계를 판단하세요.)'
                  : '이전 실행이 실패했습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.';
                const timer = setTimeout(() => {
                  this.retryTimers.delete(timer);
                  this.retryTimersByIdentifier.get(issue.identifier)?.delete(timer);
                  if (this.stopped) return;
                  if (this.recentlyTerminated.has(issue.identifier) || this.recentlyMerged.has(issue.identifier)) return;
                  this.dispatch(refreshed, { reason: 'retry', retryCount: retryCount + 1, resumeMessage, retryReason: isMaxTurns ? 'max_turns' : undefined });
                }, delayMs);
                this.retryTimers.add(timer);
                if (!this.retryTimersByIdentifier.has(issue.identifier)) {
                  this.retryTimersByIdentifier.set(issue.identifier, new Set());
                }
                this.retryTimersByIdentifier.get(issue.identifier)!.add(timer);
                return;
              }
            }
          } catch (retryErr) {
            logger.warn(`Failed to check issue state for retry: ${issue.identifier}`, { error: String(retryErr) });
          }
        }

        // 인증 오류 — 컨테이너 보존, 슬롯 해제, 재로그인 후 기존 컨테이너 재사용
        if (isAuthenticationError(err)) {
          this.limiter.release(issue.identifier);
          const prevPhase = this.issuePhases.get(issue.identifier) ?? 'initial';
          this.authErrorPhases.set(issue.identifier, prevPhase as IssuePhase);
          this.setPhase(issue.identifier, 'auth_error_waiting');
          this.failedCount++;
          if (this.humanChannel) {
            const text = `🔑 *[${formatIssueLabel(issue)}]* 인증이 만료되었습니다.\n\n\`claude login\`으로 재로그인 후 이 스레드에 메시지를 보내주세요.`;
            void this.humanChannel.sendNotification(issue, text).catch((notifyErr) => {
              logger.warn(`Failed to send auth error notification for ${issue.identifier}`, { error: String(notifyErr) });
            });
            this.logConversationToTracker(issue.id, '[Bot]', text);
            // 스레드 유지 (unwatch 호출 안 함 — 재로그인 후 메시지 수신 필요)
          }
          this.emit('agent:failed', issue, err);
          return;
        }

        // 재시도 소진 — 컨테이너 보존, 슬롯 해제 (terminateIssue가 canceled/pr_merged 시 최종 정리)
        this.limiter.release(issue.identifier);
        this.clearPhase(issue.identifier);
        this.failedCount++;
        this.drainCommentQueue(issue.identifier);
        if (this.humanChannel) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const text = `:x: *[${formatIssueLabel(issue)}]* 에이전트 실패: ${errMsg}`;
          void this.humanChannel.sendNotification(issue, text).catch((notifyErr) => {
            logger.warn(`Failed to send failure notification for ${issue.identifier}`, { error: String(notifyErr) });
          });
          this.logConversationToTracker(issue.id, '[Bot]', text);
          // 재시도 없이 완전 실패 시 감시만 해제 (스레드 레코드는 보존해 재개 시 재사용 가능)
          this.humanChannel.unwatch(issue.identifier);
        }
        this.emit('agent:failed', issue, err);
      });

    entry.promise = fullChain;
  }

  private handleAgentMessage(issueId: string, msg: AgentMessage): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    const stream = this.agentLogStreams.get(entry.issue.identifier);
    if (msg.event.type === 'output') {
      const line = msg.event.line;
      entry.agentLogLines.push(line);
      // 마지막 200줄 유지
      if (entry.agentLogLines.length > 200) entry.agentLogLines.shift();
      stream?.write(line + '\n');
    } else if (msg.event.type === 'turn_complete') {
      const costStr = msg.event.cost != null ? ` cost=$${msg.event.cost.toFixed(4)}` : '';
      const tokStr = msg.event.tokens != null ? ` tokens=${msg.event.tokens}` : '';
      stream?.write(`[turn_complete]${costStr}${tokStr}\n`);
    } else if (msg.event.type === 'error') {
      stream?.write(`[error] ${msg.event.reason}\n`);
    }

    this.emit('agent:message', entry.issue.identifier, msg);
  }

  // ---------------------------------------------------------------------------
  // 조정(Reconciliation)
  // ---------------------------------------------------------------------------

  private async reconcileRunning(_candidates: Issue[]): Promise<void> {
    // candidate 목록 기반 abort 제거 — 에이전트가 plan_review, in_review 등 intermediate
    // 상태로 전환되면 candidate 목록에서 사라지지만 abort하면 안 됨.
    // terminal state 처리는 handlePRMerged() 및 완료 핸들러에서 담당.

    // 주기적 stale 스레드 정리 (5분 간격)
    const now = Date.now();
    if (this.humanChannel && now - this.lastThreadPruneAt > Orchestrator.THREAD_PRUNE_INTERVAL_MS) {
      this.lastThreadPruneAt = now;
      void this.pruneStaleThreads();
    }
  }

  /**
   * humanChannel에 등록된 스레드 중 terminal state이거나 트래커에서 사라진 이슈를 정리한다.
   * 트래커 API rate limit 보호를 위해 배치 처리 (5개씩, 1초 간격).
   */
  private async pruneStaleThreads(): Promise<void> {
    if (!this.humanChannel) return;

    const allIdentifiers = this.humanChannel.getAllWatchedIdentifiers();
    // 현재 running/pending 중인 이슈는 제외
    const candidates = allIdentifiers.filter(
      (id) => !this.isRunningByIdentifier(id) && !this.pendingDispatch.has(id),
    );

    if (candidates.length === 0) return;

    const terminalNorm = new Set(this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()));
    let pruned = 0;

    // 배치 처리: 5개씩, 각 배치 사이 1초 딜레이
    const batchSize = 5;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((id) => this.tracker.fetchIssueByIdentifier(id).then((issue) => ({ id, issue }))),
      );

      for (const result of results) {
        if (result.status === 'rejected') continue; // API 오류 — 건너뜀 (안전)
        const { id, issue } = result.value;

        if (!issue) {
          // tracker에서 찾을 수 없음 → 삭제된 이슈
          logger.info(`pruneStaleThreads: ${id} not found in tracker; removing thread`);
          this.humanChannel!.forgetThread(id);
          this.clearPhase(id);
          this.limiter.release(id);
          pruned++;
        } else if (terminalNorm.has(issue.state.toLowerCase().trim())) {
          logger.info(`pruneStaleThreads: ${id} in terminal state "${issue.state}"; removing thread`);
          this.humanChannel!.forgetThread(id);
          this.clearPhase(id);
          this.limiter.release(id);
          pruned++;
        }
      }

      // 배치 간 딜레이 (마지막 배치 제외)
      if (i + batchSize < candidates.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (pruned > 0) {
      logger.info(`pruneStaleThreads: removed ${pruned} stale thread(s) out of ${candidates.length} checked`);
    }
  }

  private isBlocked(issue: Issue, allCandidates: Issue[]): boolean {
    if (issue.blockedBy.length === 0) return false;

    const activeIds = new Set(allCandidates.map((i) => i.id));
    const terminalStates = new Set(
      this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()),
    );

    return issue.blockedBy.some((blocker) => {
      const state = blocker.state?.toLowerCase().trim();
      // 블로커가 아직 활성 상태인 경우(terminal이 아니고 candidate 목록에 존재) 차단됨
      return activeIds.has(blocker.id) || (state && !terminalStates.has(state));
    });
  }

  // ---------------------------------------------------------------------------
  // 중단된 에이전트 정리
  // ---------------------------------------------------------------------------

  private pruneStaleAgents(): void {
    const now = Date.now();

    for (const [id, entry] of this.running) {
      const age = now - entry.startedAt.getTime();
      if (age > STALE_AGENT_TIMEOUT_MS) {
        logger.warn(`Pruning stale agent for ${entry.issue.identifier} age=${Math.round(age / 60_000)}m`);
        entry.abortController.abort();
        this.running.delete(id);
        // phase 제거: 다음 poll cycle에서 재디스패치되지 않도록 함.
        // 슬롯은 유지 — 고아 컨테이너가 cap을 계속 점유하게 하여
        // pruneOrphanedAdmissions가 컨테이너 실존 여부를 확인 후 최종 해제함.
        this.clearPhase(entry.issue.identifier);
        this.failedCount++;
      }
    }

    // 고아 슬롯 housekeeping: admitted이지만 더 이상 running도 아니고 workspace도 없는 identifier 정리.
    // 비동기로 실행해 poll loop를 블록하지 않는다.
    void this.pruneOrphanedAdmissions();
  }

  private async pruneOrphanedAdmissions(): Promise<void> {
    const runningIds = new Set([...this.running.values()].map((e) => e.issue.identifier));
    for (const identifier of this.limiter.snapshot()) {
      if (runningIds.has(identifier)) continue;
      // WAITING_PHASES 이슈는 컨테이너가 살아있음 — 건드리지 않음
      if (WAITING_PHASES.has(this.issuePhases.get(identifier) as IssuePhase)) continue;
      // 워크스페이스/컨테이너가 실제로 없는지 확인
      const wsRef = this.io.refFromName(this.io.nameForIssue({ identifier }));
      try {
        const exists = await this.io.exists(wsRef);
        if (!exists) {
          // await 이후 재검증: 동시 dispatch에 의한 TOCTOU 방지
          if (this.isRunningByIdentifier(identifier)) continue;
          const currentPhase = this.issuePhases.get(identifier);
          if (currentPhase && WAITING_PHASES.has(currentPhase)) continue;
          logger.info(`Releasing orphaned admission slot for ${identifier} (no workspace found)`);
          this.limiter.release(identifier);
        }
      } catch (err) {
        // 확인 실패 시 슬롯 유지 (보수적) — 오류 원인 로그
        logger.warn(`pruneOrphanedAdmissions: workspace existence check failed for ${identifier}`, { error: String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase / 모델 결정
  // ---------------------------------------------------------------------------

  /**
   * 디스패치 컨텍스트에 따라 사용할 모델을 결정한다.
   * 모델 별칭(예: 'opus', 'sonnet')을 반환하거나, 모델이 설정되지 않은 경우 undefined를 반환한다.
   */
  private resolveModel(
    agents: AgentConfig[],
    issueIdentifier?: string,
  ): string | undefined {
    const claudeAgent = agents.find((a): a is ClaudeAgentConfig => a.kind === 'claude' && 'models' in a);
    if (!claudeAgent?.models) return undefined;

    const phase = this.issuePhases.get(issueIdentifier ?? '') ?? 'initial';
    const isImplementation = phase === 'implementing' || phase === 'review_fixing' || phase === 'pr_fixing';
    const model = isImplementation ? claudeAgent.models.implementation : claudeAgent.models.planning;

    logger.debug(`Phase=${phase}, model=${model}`);
    return model;
  }

  // ---------------------------------------------------------------------------
  // 워크스페이스 정리
  // ---------------------------------------------------------------------------

  private async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    const terminalStates = new Set(this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()));

    // 최신 상태 재조회
    let latest: Issue | undefined;
    try {
      const [fetched] = await this.tracker.fetchIssuesByIds([issue.id]);
      latest = fetched;
    } catch {
      return;
    }

    if (!latest) return;

    const isTerminal = terminalStates.has(latest.state.toLowerCase().trim());
    if (!isTerminal) return;

    // 완료 알림 + 레코드 완전 삭제 (terminal에서만)
    if (this.humanChannel?.isWatching(issue.identifier)) {
      const completionText = `:white_check_mark: *[${formatIssueLabel(issue)}]* 작업 완료`;
      await this.humanChannel.sendNotification(issue, completionText).catch((err) => {
        logger.warn(`Failed to send completion notification for ${issue.identifier}`, { error: String(err) });
      });
      this.logConversationToTracker(issue.id, '[Bot]', `${issue.identifier} 작업 완료`);
    }
    this.humanChannel?.forgetThread(issue.identifier);

    // 비용 댓글 작성 (중복 방지)
    const costData = this.costTracker.getIssue(issue.identifier);
    if (costData && !this.costCommentWritten.has(issue.identifier)) {
      this.costCommentWritten.add(issue.identifier);
      const comment = `[Agent Summary] Cost: $${costData.costUsd.toFixed(4)} | Tokens: ${costData.tokens.toLocaleString()} | Turns: ${costData.turns}`;
      try {
        await this.tracker.createComment(issue.id, comment);
      } catch (err) {
        logger.warn(`Failed to write cost comment for ${issue.identifier}`, { error: String(err) });
      }
    }

    logger.info(`Issue ${issue.identifier} reached terminal state; cleaning up workspace`);
    this.clearPhase(issue.identifier);

    // 컨테이너 삭제는 terminateIssue(canceled/pr_merged)에 위임; 여기서는 슬롯만 해제
    this.limiter.release(issue.identifier);
    logger.debug(`Released container slot for ${issue.identifier} (admitted=${this.limiter.size()}/${this.limiter.maxContainers})`);
  }

  // ---------------------------------------------------------------------------
  // 휴먼 채널 (계획 승인 워크플로우)
  // ---------------------------------------------------------------------------

  private startHumanChannel(): void {
    if (!this.config.slack) {
      logger.info('No Slack config; human channel disabled');
      return;
    }
    this.humanChannel = new SlackChannel(
      this.config.slack,
      this.config.workspace.root,
      (event) => { void this.handleHumanResponse(event); },
    );
    this.humanChannel.start().catch((err) => {
      logger.error('HumanChannel failed to start — shutting down', { error: String(err) });
      process.exit(1);
    });
  }

  private async notifyPlanStart(issue: Issue): Promise<void> {
    if (!this.humanChannel) return;

    const text = `📋 *[${formatIssueLabel(issue)}]* 의 계획을 작성합니다.`;
    const workspaceName = this.io.nameForIssue(issue);
    await this.humanChannel.sendNotification(issue, text, workspaceName).catch((err) => {
      logger.warn(`Failed to notify plan start for ${issue.identifier}`, { error: String(err) });
    });
    this.logConversationToTracker(issue.id, '[Bot]', text);
  }

  private async sendPrDiff(issue: Issue, ref: WorkspaceRef, data: { pr_url: string; pr_number?: number; base_commit?: string }): Promise<void> {
    if (!this.diffSender || !this.humanChannel) {
      logger.debug(`PR diff: no diffSender for ${issue.identifier}`);
      return;
    }
    const threadInfo = this.humanChannel.getThreadInfo(issue.identifier);
    if (!threadInfo) {
      logger.debug(`PR diff: no threadInfo for ${issue.identifier}`);
      return;
    }
    try {
      // base_commit이 없는 드문 경우에도 올바른 base 브랜치 기준으로 diff 계산
      const resolvedRepo = this.resolveRepository(issue);
      const baseBranch = resolvedRepo ? this.resolveBaseBranch(issue, resolvedRepo) : 'main';
      logger.debug(`PR diff: base_commit=${data.base_commit ?? 'undefined'} base_branch=${baseBranch}`, { issue: issue.identifier });
      const rawDiff = await this.io.getDiff(ref, data.base_commit, baseBranch);
      logger.debug(`PR diff: rawDiff length=${rawDiff?.length ?? 0}`, { issue: issue.identifier });
      if (rawDiff && rawDiff.trim()) {
        const files = parseDiffToFiles(rawDiff)
          .filter(f => !DIFF_EXCLUDED_PATH_RE.test(f.path));
        logger.debug(`PR diff: ${files.length} files after filter`, { issue: issue.identifier });
        if (files.length > 0) {
          this.diffQueueStore.set(issue.identifier, {
            issueIdentifier: issue.identifier,
            pr_url: data.pr_url,
            pr_number: data.pr_number ?? 0,
            thread_ts: threadInfo.thread_ts,
            channel: threadInfo.channel,
            summary_sent: false,
            files,
            approval_sent: false,
          });
          await this.diffSender.sendPendingDiffs(issue.identifier);
        }
      }
    } catch (err) {
      logger.warn(`Failed to send PR diff for ${issue.identifier}`, { error: String(err) });
    }
  }

  private async handlePrCreated(issue: Issue): Promise<boolean> {
    if (!this.humanChannel) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    const raw = await this.io.readFile(ref, '.symphony/pr_created.json');
    if (!raw || raw.trim() === '') return false;

    try {
      const data = JSON.parse(raw) as { pr_url?: string; pr_number?: number; base_commit?: string };
      if (!data.pr_url) return false;

      await this.sendPrDiff(issue, ref, { pr_url: data.pr_url, pr_number: data.pr_number, base_commit: data.base_commit });

      const text = `🔗 *[${formatIssueLabel(issue)}]* PR이 생성되었습니다: ${data.pr_url}`;
      await this.humanChannel.sendNotification(issue, text);
      this.logConversationToTracker(issue.id, '[Bot]', text);
    } catch (err) {
      logger.warn(`Failed to parse pr_created.json for ${issue.identifier}`, { error: String(err) });
      return false;
    }

    try {
      await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.in_review);
      logger.info(`Transitioned ${issue.identifier} to ${this.trackerConfig.states.in_review} after PR created`);
    } catch (err) {
      logger.warn(`Failed to transition ${issue.identifier} to in_review`, { error: String(err) });
    }

    this.setPhase(issue.identifier, 'pr_fixing');
    try { await this.io.writeFile(ref, '.symphony/pr_created.json', ''); } catch { /* non-fatal */ }
    return true;
  }

  private async handlePrUpdated(issue: Issue): Promise<boolean> {
    if (!this.humanChannel) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    const raw = await this.io.readFile(ref, '.symphony/pr_created.json');
    if (!raw || raw.trim() === '') return false;

    try {
      const data = JSON.parse(raw) as { pr_url?: string; pr_number?: number; base_commit?: string };
      if (!data.pr_url) return false;

      await this.sendPrDiff(issue, ref, { pr_url: data.pr_url, pr_number: data.pr_number, base_commit: data.base_commit });

      const text = `🔗 *[${formatIssueLabel(issue)}]* PR이 업데이트되었습니다: ${data.pr_url}`;
      await this.humanChannel.sendNotification(issue, text);
      this.logConversationToTracker(issue.id, '[Bot]', text);
    } catch (err) {
      logger.warn(`Failed to parse pr_created.json for ${issue.identifier}`, { error: String(err) });
      return false;
    }

    try { await this.io.writeFile(ref, '.symphony/pr_created.json', ''); } catch { /* non-fatal */ }
    return true;
  }

  private async notifyWorkComplete(issue: Issue): Promise<void> {
    if (!this.humanChannel) return;

    const planNumber = this.humanChannel.getPlanNumber(issue.identifier);
    const text = planNumber > 0
      ? `✅ *[${formatIssueLabel(issue)}]* 계획 #${planNumber} 작업 완료`
      : `✅ *[${formatIssueLabel(issue)}]* 작업 완료`;
    await this.humanChannel.sendNotification(issue, text).catch((err) => {
      logger.warn(`Failed to notify work complete for ${issue.identifier}`, { error: String(err) });
    });
    this.logConversationToTracker(issue.id, '[Bot]', text);
  }

  private logConversationToTracker(issueId: string, prefix: string, text: string): void {
    this.tracker.createComment(issueId, `${prefix}\n\n${text}`)
      .catch((err) => logger.warn('Failed to log conversation to tracker', { error: String(err) }));
  }

  // ---------------------------------------------------------------------------
  // 셀프 리뷰 처리
  // ---------------------------------------------------------------------------

  /**
   * Slack에 리뷰 결과가 전송된 경우(사용자 응답 대기 중) true를 반환한다.
   *
   * 두 가지 경로:
   *  1. pending_review.md가 이미 존재함 → 에이전트가 이미 작성했으므로 Slack으로 전송만 함.
   *  2. pending_review.md가 존재하지 않음 → 단발성 리뷰 세션을 실행하고,
   *     pending_review.md를 작성한 뒤 Slack으로 전송.
   */
  private async handlePendingReview(issue: Issue, skipGeneration = false): Promise<boolean> {
    if (!this.humanChannel) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    // 리뷰 응답(skipGeneration=true)일 때는 phase 체크 건너뜀 (수정된 리뷰 재전송 허용)
    if (!skipGeneration) {
      if (this.issuePhases.get(issue.identifier) === 'review_sent') return false;
    }

    // pending_review.md가 이미 존재하는지 확인 (피드백 루프 이후 에이전트가 작성)
    let reviewText: string | undefined;
    try {
      const existing = await this.io.readFile(ref, '.symphony/pending_review.md');
      if (existing?.trim()) reviewText = existing;
    } catch { /* 파일이 존재하지 않음 */ }

    // 기존 리뷰가 없으면 리뷰 라운드를 실행한 후 --continue로 통합
    if (!reviewText && !skipGeneration) {
      try {
        // #1 BLOCKER: 실제 base branch를 resolveBaseBranch로 결정하여 전달
        const effectiveRepo = this.trackerConfig.repositories?.[0];
        const baseBranch = effectiveRepo ? this.resolveBaseBranch(issue, effectiveRepo) : 'main';

        // 에이전트 리뷰 라운드와 semgrep을 병렬로 실행
        // Promise.allSettled: 한쪽 실패 시에도 다른 쪽 결과를 보존
        const [reviewSettled, semgrepSettled] = await Promise.allSettled([
          this.runReviewRounds(ref, issue),
          this.runSemgrepIfConfigured(ref, baseBranch),
        ]);
        const rawResults = reviewSettled.status === 'fulfilled' ? reviewSettled.value : '';
        if (reviewSettled.status === 'rejected') {
          logger.warn('[review] 리뷰 라운드 실패', { error: String(reviewSettled.reason) });
        }
        const semgrepResults = semgrepSettled.status === 'fulfilled' ? semgrepSettled.value : null;

        if (!rawResults && !semgrepResults) {
          // 리뷰 결과가 전혀 없으면 consolidation 에이전트 호출 없이 바로 fallback 기록
          logger.warn(`No review results for ${issue.identifier} — skipping consolidation`);
          await this.io.writeFile(ref, '.symphony/pending_review.md', '리뷰 결과 없음 — 수동 확인 필요');
        } else {
          // consolidation만 별도 try/catch — 실패 시 rawResults fallback으로 계속 진행
          try {
            await this.consolidateReviewViaContinue(ref, rawResults, semgrepResults);
          } catch (consolidationErr) {
            let currentErr: unknown = consolidationErr;
            while (String(currentErr).includes('error_max_turns')) {
              logger.info(`Consolidation hit max_turns for ${issue.identifier} — retrying with --continue`);
              if (this.humanChannel) {
                void this.humanChannel
                  .sendNotification(
                    issue,
                    `🔄 *[${formatIssueLabel(issue)}]* 셀프리뷰 통합에서 최대 턴 수에 도달해 이어서 재시도합니다.`,
                    this.io.nameForIssue(issue),
                  )
                  .catch((notifyErr) => logger.warn('Failed to send consolidation retry notification', { error: String(notifyErr) }));
              }
              const mainKind = (this.config.agents.backends.find((a) => a.primary) ?? this.config.agents.backends[0]).kind;
              try {
                await this.spawnReviewCLI(
                  ref, mainKind,
                  '최대 턴 수에 도달했습니다. pending_review.md 작성을 완료해 주세요.',
                  { continue: true },
                );
                currentErr = null;
              } catch (retryErr) {
                currentErr = retryErr;
              }
            }
            if (currentErr) {
              logger.warn(
                `Review consolidation failed for ${issue.identifier}; using raw results as fallback`,
                { error: String(currentErr) },
              );
            }
            // 에이전트가 이미 부분 결과를 작성했으면 그것을 유지, 없을 때만 rawResults fallback 사용
            const existing = await this.io.readFile(ref, '.symphony/pending_review.md');
            if (!existing?.trim()) {
              const MAX_RAW = 32 * 1024;
              const raw = rawResults ? sanitizeForSlack(rawResults.slice(0, MAX_RAW)) : null;
              const seg = semgrepResults ? sanitizeForSlack(semgrepResults) : null;
              const header = raw || seg
                ? '> ⚠️ 셀프리뷰 통합 단계에서 오류가 발생했습니다. 아래는 정리되지 않은 원본 리뷰 결과입니다.\n'
                : null;
              const parts = [header, raw, seg].filter((x): x is string => Boolean(x));
              await this.io.writeFile(ref, '.symphony/pending_review.md', parts.join('\n\n'));
            }
          }

          // 에이전트가 pending_review.md를 작성했는지(또는 위 fallback이 채워졌는지) 확인
          const consolidated = await this.io.readFile(ref, '.symphony/pending_review.md');
          if (!consolidated?.trim()) {
            logger.warn(`Review consolidation did not produce pending_review.md for ${issue.identifier}`);
            const parts = [rawResults, semgrepResults].filter(Boolean);
            await this.io.writeFile(ref, '.symphony/pending_review.md', parts.join('\n\n'));
          }
        }
        reviewText = (await this.io.readFile(ref, '.symphony/pending_review.md'))?.trim() ?? undefined;
      } catch (err) {
        logger.error(`Self-review failed for ${issue.identifier}`, { error: String(err) });
        // 잔류 파일이 다음 dispatch에서 "기존 리뷰"로 오인되지 않도록 초기화
        await this.io.writeFile(ref, '.symphony/pending_review.md', '').catch(() => {});
        // 리뷰 라운드 자체 실패 등 진짜 복구 불가 상황 — Slack 알림 후 throw로 notifyWorkComplete 스킵
        if (this.humanChannel) {
          const label = formatIssueLabel(issue);
          const errStr = String(err).slice(0, 300).replace(/`/g, "'");
          await this.humanChannel
            .sendNotification(
              issue,
              `⚠️ *[${label}]* 셀프리뷰 실행 중 오류가 발생했습니다. 수동으로 확인이 필요합니다.\n\`\`\`${errStr}\`\`\``,
            )
            .catch((notifyErr) => {
              logger.error(`Failed to send self-review failure notification for ${issue.identifier}`, { error: String(notifyErr) });
            });
        }
        throw err;
      }
    }

    if (!reviewText) return false;

    const wsName = this.io.nameForIssue(issue);
    const sent = await this.humanChannel.sendForApproval(issue, reviewText, 'review', wsName);
    if (sent) this.logConversationToTracker(issue.id, '[Bot]', reviewText);
    if (!sent) return false;

    // phase 전환으로 재전송 방지 (pending_review.md는 유지 — 에이전트가 피드백/승인 시 참조)
    this.setPhase(issue.identifier, 'review_sent');

    // 이슈를 in_review 상태로 전환 — 폴러 재-dispatch 이중 방지
    try {
      await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.in_review);
      logger.info(`Transitioned ${issue.identifier} to ${this.trackerConfig.states.in_review} after self-review`);
    } catch (err) {
      logger.warn(`Failed to transition ${issue.identifier} to in_review`, { error: String(err) });
    }

    logger.info(`Self-review results sent to channel for ${issue.identifier}`);
    return true;
  }

  /**
   * `claude -p --no-session-persistence`를 통해 단발성 셀프 리뷰 세션을 실행한다.
   * 구현 세션과 완전히 격리됨 (공유 컨텍스트 없음).
   * 리뷰 에이전트는 @code-reviewer와 @security-engineer 서브 에이전트를 사용한다.
   */
  /** 설정된 모든 리뷰 에이전트를 병렬로 실행한다 (각 에이전트는 직렬 라운드 수행). 원시 결과 텍스트를 반환한다. */
  private async runReviewRounds(ref: WorkspaceRef, issue: Issue): Promise<string> {
    const reviewConfig = this.config.agents.review;
    if (!reviewConfig) throw new Error('Self-review requires agents.review config');
    const { kinds: agents, rounds } = reviewConfig;

    logger.info(`Starting self-review: agents=[${agents.join(', ')}] rounds=${rounds}`);

    const perAgentResults = await Promise.all(
      agents.map((kind) => this.runAgentReviewRounds(ref, kind, rounds, issue)),
    );

    // 라벨 포함 결과 목록 (어느 에이전트의 몇 번째 라운드인지 명시)
    const labeled: { label: string; text: string }[] = [];
    for (let ai = 0; ai < agents.length; ai++) {
      for (let ri = 0; ri < perAgentResults[ai].length; ri++) {
        labeled.push({ label: `agent(${agents[ai]}) round ${ri + 1}`, text: perAgentResults[ai][ri] });
      }
    }

    if (labeled.length === 0) {
      throw new Error('모든 리뷰 라운드 실패 — 통합할 결과 없음');
    }

    return labeled.map(({ label, text }) => `--- ${label} ---\n${text}`).join('\n\n');
  }

  /** 메인 에이전트에게 --continue로 리뷰 결과 통합을 지시한다. 에이전트가 pending_review.md를 작성한다. */
  private async consolidateReviewViaContinue(
    ref: WorkspaceRef,
    rawResults: string,
    semgrepResults: string | null = null,
  ): Promise<void> {
    const mainAgentKind = (this.config.agents.backends.find((a) => a.primary) ?? this.config.agents.backends[0]).kind;
    let prompt = `셀프리뷰 라운드가 완료되었습니다. WORKFLOW의 "Consolidation rules"에 따라 아래 결과를 통합하고 pending_review.md에 작성하세요.\n\n${rawResults}`;

    if (semgrepResults) {
      prompt += `\n\n아래는 semgrep 정적 분석 결과입니다. 에이전트 리뷰 결과와 함께 동일한 severity 테이블(BLOCKER/SUGGESTION/NIT)에 통합하세요. false positive라고 판단되는 항목은 "Rejected Issues" 테이블에 사유와 함께 기재하세요. 출처를 명시하기 위해 semgrep 발견 사항에는 "[semgrep: <rule-id>]" 태그를 포함하세요.\n\n${semgrepResults}`;
    }

    await this.spawnReviewCLI(ref, mainAgentKind, prompt, { continue: true });
  }

  /**
   * semgrep 설정이 있으면 실행하고 결과 텍스트를 반환한다.
   * 설정 미기재 또는 실행 실패 시 null을 반환한다 (graceful degradation).
   */
  private async runSemgrepIfConfigured(ref: WorkspaceRef, baseBranch: string): Promise<string | null> {
    const semgrepConfig = this.config.agents.review?.semgrep;
    if (!semgrepConfig) return null;

    logger.info('[semgrep] 정적 분석 시작');
    try {
      const result = await runSemgrep(ref, semgrepConfig, baseBranch);
      if (result) logger.info('[semgrep] 정적 분석 완료');
      return result;
    } catch (err) {
      logger.warn('[semgrep] 정적 분석 실패 — 리뷰 계속 진행', { error: String(err) });
      return null;
    }
  }

  /** 한 에이전트를 `rounds`번의 직렬 리뷰 라운드로 실행하고 결과를 수집한다. */
  private async runAgentReviewRounds(ref: WorkspaceRef, kind: string, rounds: number, issue: Issue): Promise<string[]> {
    const results: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      logger.info(`Review ${kind} round ${round}/${rounds}`);
      try {
        let result!: string;
        let isFirstAttempt = true;
        while (true) {
          try {
            if (isFirstAttempt) {
              result = await this.spawnReviewCLI(ref, kind, this.buildReviewPrompt(round, rounds, results), { saveSession: true });
            } else {
              result = await this.spawnReviewCLI(ref, kind, '최대 턴 수에 도달했습니다. 중단된 리뷰를 완료하고 결과를 출력해 주세요.', { continue: true });
            }
            break;
          } catch (roundErr) {
            if (!String(roundErr).includes('error_max_turns')) throw roundErr;
            isFirstAttempt = false;
            logger.info(`Review ${kind} round ${round} hit max_turns — retrying with --continue`);
            if (this.humanChannel) {
              void this.humanChannel
                .sendNotification(
                  issue,
                  `🔄 *[${formatIssueLabel(issue)}]* 셀프리뷰 ${kind} 라운드 ${round}에서 최대 턴 수에 도달해 이어서 재시도합니다.`,
                  this.io.nameForIssue(issue),
                )
                .catch((notifyErr) => logger.warn('Failed to send review round retry notification', { error: String(notifyErr) }));
            }
          }
        }
        results.push(result);
      } catch (err) {
        logger.warn(`Review ${kind} round ${round} failed`, { error: String(err) });
      }
    }
    return results;
  }

  /** 주어진 라운드에 대한 리뷰 프롬프트를 구성한다. 이전 발견 사항은 제외 목록으로 포함한다. */
  private buildReviewPrompt(round: number, totalRounds: number, previousResults: string[]): string {
    let prompt = `Perform a code review. Run @code-reviewer and @security-engineer sub-agents in parallel. This is round ${round} of ${totalRounds}. Follow .claude/skills/review.md for guidelines.`;
    if (previousResults.length > 0) {
      prompt += `\n\nPrevious rounds found these issues (do NOT repeat them, find NEW issues only):\n${previousResults.join('\n---\n')}`;
    }
    return prompt;
  }

  /** 리뷰 에이전트(claude 또는 codex)를 위한 통합 CLI 실행기. 기본적으로 격리된 세션, 통합 시에는 --continue 사용. */
  private spawnReviewCLI(ref: WorkspaceRef, kind: string, prompt: string, opts?: { continue?: boolean; saveSession?: boolean }): Promise<string> {
    const agentConfig = this.config.agents.backends.find((a) => a.kind === kind);
    if (!agentConfig) throw new Error(`No agent config found for kind="${kind}"`);

    let cmd: string;
    let spawnArgs: string[];
    let cwd: string;
    let timeoutMs: number;

    if (kind === 'claude') {
      const config = agentConfig as ClaudeAgentConfig;
      timeoutMs = config.turn_timeout_ms;
      const args = opts?.continue
        ? ['--continue', '-p', prompt, '--output-format', 'text']
        : opts?.saveSession
          ? ['-p', prompt, '--output-format', 'text']
          : ['-p', prompt, '--no-session-persistence'];
      if (ref.containerName) {
        args.push('--dangerously-skip-permissions');
        cmd = 'docker';
        const claudeCmd = ['claude', ...args].map(shellEscape).join(' ');
        const innerCmd = `cd ${shellEscape(ref.workspace)} && ${claudeCmd}`;
        spawnArgs = ['exec', '--user', 'worker', ref.containerName, 'bash', '-lc', innerCmd];
        cwd = process.cwd();
      } else {
        cmd = config.command;
        spawnArgs = args;
        cwd = ref.workspace;
      }
    } else if (kind === 'codex') {
      const config = agentConfig as CodexAgentConfig;
      timeoutMs = 3_600_000;
      const args = ['exec', '--full-auto', prompt];
      if (ref.containerName) {
        cmd = 'docker';
        const codexCmd = ['codex', ...args].map(shellEscape).join(' ');
        const innerCmd = `cd ${shellEscape(ref.workspace)} && ${codexCmd}`;
        spawnArgs = ['exec', '-i', '--user', 'worker', ref.containerName, 'bash', '-lc', innerCmd];
        cwd = process.cwd();
      } else {
        cmd = config.command;
        spawnArgs = args;
        cwd = ref.workspace;
      }
    } else {
      throw new Error(`지원하지 않는 리뷰 에이전트 kind: ${kind}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, spawnArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: string[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(new Error(`Self-review timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let lineBuffer = '';
      child.stdout.on('data', (chunk: string) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) logger.debug(`[review/${kind}] ${line}`);
          chunks.push(line + '\n');
        }
      });
      child.stderr.on('data', (chunk: string) => {
        if (chunk.trim()) logger.warn(`[self-review/${kind}] ${chunk.trim()}`);
      });

      let settled = false;

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) return;
        if (lineBuffer.trim()) {
          logger.debug(`[review/${kind}] ${lineBuffer}`);
          chunks.push(lineBuffer);
        }

        const output = chunks.join('');
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Self-review exited with code ${code}: ${output.slice(0, 500)}`));
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 계획 처리
  // ---------------------------------------------------------------------------

  /** 계획이 휴먼 채널로 전송된 경우 true를 반환한다. */
  private async handlePendingPlan(issue: Issue): Promise<boolean> {
    if (!this.humanChannel) {
      logger.debug(`handlePendingPlan: skipping — humanChannel not initialized`, { issue: issue.identifier });
      return false;
    }

    const ref = this.io.refForIssue(issue);
    const wsExists = await this.io.exists(ref);
    if (!wsExists) {
      logger.debug(`handlePendingPlan: workspace does not exist`, { issue: issue.identifier });
      return false;
    }

    const plan = await this.io.readFile(ref, '.symphony/pending_plan.md');
    if (!plan || plan.trim() === '') {
      return false;
    }

    logger.info(`handlePendingPlan: sending plan to channel`, { issue: issue.identifier, planLength: plan.length });

    // Race condition 방지: plan 전송 중 응답 처리 차단
    this.pendingDispatch.add(issue.identifier);
    try {
      const wsName = this.io.nameForIssue(issue);
      const sent = await this.humanChannel.sendForApproval(issue, plan, 'plan', wsName);
      if (sent) this.logConversationToTracker(issue.id, '[Bot]', plan);
      if (!sent) {
        logger.warn(`handlePendingPlan: sendForApproval returned false`, { issue: issue.identifier });
        return false;
      }

      // pending_plan.md 유지 — 에이전트가 승인/피드백 시 참조.
      // phase + 트래커 상태 전환으로 재dispatch/재전송 방지.
      // pr_fixing / review_fixing 컨텍스트에서 온 계획은 pr_plan_sent로 구분 — 승인 시 pr_fixing으로 복귀 (셀프리뷰 스킵)
      const currentPhase = this.issuePhases.get(issue.identifier);
      const nextPhase = (currentPhase === 'pr_fixing' || currentPhase === 'review_fixing') ? 'pr_plan_sent' : 'plan_sent';
      this.setPhase(issue.identifier, nextPhase);
      if (nextPhase === 'plan_sent') {
        try {
          await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.plan_review);
          logger.info(`Transitioned ${issue.identifier} to ${this.trackerConfig.states.plan_review} after plan sent`);
        } catch (err) {
          logger.warn(`Failed to transition ${issue.identifier} to plan_review`, { error: String(err) });
        }
      }
      return true;
    } finally {
      this.pendingDispatch.delete(issue.identifier);
    }
  }

  /** 사용자 질문에 대한 답변을 휴먼 채널로 전송한다. phase는 변경하지 않는다. */
  private async handlePendingReply(issue: Issue): Promise<boolean> {
    if (!this.humanChannel) return false;
    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;
    const reply = await this.io.readFile(ref, '.symphony/pending_reply.md');
    if (!reply || reply.trim() === '') return false;

    const slackContent = reply + '\n\n> 💬 이 메시지는 질문/답변입니다. ✅ 승인 리액션은 동작하지 않습니다.';
    await this.humanChannel.sendNotification(issue, slackContent);
    this.logConversationToTracker(issue.id, '[Bot]', reply);
    try { await this.io.writeFile(ref, '.symphony/pending_reply.md', ''); } catch { /* non-fatal */ }
    return true;
  }

  /** 질문이 휴먼 채널로 전송된 경우 true를 반환한다. */
  private async handleQuestion(issue: Issue): Promise<boolean> {
    if (!this.humanChannel) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    const question = await this.io.readFile(ref, '.symphony/question.md');
    if (!question || question.trim() === '') return false;

    this.pendingDispatch.add(issue.identifier);
    try {
      const wsName = this.io.nameForIssue(issue);
      const questionWithFooter = question + '\n\n> 💬 이 메시지는 질문입니다. ✅ 승인 리액션은 동작하지 않습니다.';
      const sent = await this.humanChannel.sendForApproval(issue, questionWithFooter, 'question', wsName);
      if (sent) this.logConversationToTracker(issue.id, '[Bot]', question);
      if (!sent) return false;

      // question.md 비우기 (재전송 방지)
      try { await this.io.writeFile(ref, '.symphony/question.md', ''); } catch { /* non-fatal */ }
      this.setPhase(issue.identifier, 'question_sent');
      return true;
    } finally {
      this.pendingDispatch.delete(issue.identifier);
    }
  }

  private async handleHumanResponse(event: FeedbackResponseEvent): Promise<void> {
    const { issueIdentifier: identifier } = event;
    const isRunning = this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier);

    if (isRunning) {
      logger.debug(`Human response for ${identifier}: agent running — skipping`);
      return;
    }

    this.logConversationToTracker(event.issueId, '[User]', event.responseText);

    this.pendingDispatch.add(identifier);
    await logContext.run({ identifier }, async () => {
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      // terminal state 이슈에 대한 응답 무시
      const terminalNorm = new Set(this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()));
      if (terminalNorm.has(issue.state.toLowerCase().trim())) {
        logger.info(`Human response for ${identifier}: issue in terminal state "${issue.state}"; ignoring`);
        this.clearPhase(identifier);
        return;
      }

      const ref = this.io.refFromName(event.workspaceName);
      const currentPhase = this.issuePhases.get(identifier) ?? 'initial';

      // Phase 기반 상태 전환
      switch (currentPhase) {
        case 'plan_sent':
          if (event.isApproval) {
            this.setPhase(identifier, 'implementing');
            try {
              await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.in_progress);
            } catch (err) {
              logger.warn(`Failed to transition ${identifier} to in_progress`, { error: String(err) });
            }
          } else {
            this.setPhase(identifier, 'initial');
            try {
              await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.planning);
            } catch (err) {
              logger.warn(`Failed to transition ${identifier} to planning`, { error: String(err) });
            }
          }

          break;

        case 'pr_plan_sent':
          // 승인/피드백 모두 pr_fixing으로 복귀 — 에이전트가 계획 참조 후 작업 진행
          this.setPhase(identifier, 'pr_fixing');
          break;

        case 'review_sent':
          this.setPhase(identifier, 'review_fixing');
          break;

        case 'question_sent':
          this.setPhase(identifier, 'initial');
          break;

        case 'pr_fixing':
          if (!event.isApproval) {
            this.setPhase(identifier, 'pr_fixing');
            await this.handleSlackPrFeedback(issue, event, ref);
            return;
          }
          break;

        case 'auth_error_waiting': {
          // 인증 오류 후 슬랙 메시지 수신 — 이전 phase로 복원 후 재디스패치
          const prevPhase = this.authErrorPhases.get(identifier) ?? 'initial';
          this.authErrorPhases.delete(identifier);
          this.setPhase(identifier, prevPhase as IssuePhase);
          break;
        }

        default:
          break;
      }

      // 채널에 처리 시작 알림
      if (this.humanChannel) {
        let msgText: string;
        const planNumber = this.humanChannel.getPlanNumber(identifier);
        const newPhase = this.issuePhases.get(identifier) ?? 'initial';
        if (event.isApproval) {
          msgText = newPhase === 'review_fixing'
            ? `✅ *[${formatIssueLabel(issue)}]* 리뷰가 승인되었습니다. 처리합니다.`
            : `🚀 *[${formatIssueLabel(issue)}]* 계획 #${planNumber} 작업을 시작합니다.`;
        } else {
          msgText = `💬 *[${formatIssueLabel(issue)}]* 응답을 처리합니다.`;
        }
        const wsName = this.io.nameForIssue(issue);
        await this.humanChannel.sendNotification(issue, msgText, wsName).catch((err) => {
          logger.warn(`Failed to send response notification for ${identifier}`, { error: String(err) });
        });
      }

      // 메시지 구성: ✅ 리액션 그대로 전달 (에이전트가 ✅ 존재 여부로 구현 여부 판단)
      // 비승인 메시지에는 방어 prefix 추가 — 에이전트가 텍스트 내용에 현혹되어 구현하는 것 방지
      const wasAuthError = (currentPhase === 'auth_error_waiting');
      const resumeMessage = wasAuthError
        ? '인증이 복구되었습니다. 현재 워크스페이스 상태를 확인하고 작업을 이어서 진행하세요.'
        : event.isApproval
          ? '✅'
          : `⚠️ FEEDBACK (NOT APPROVAL — do NOT implement):\n${event.responseText}`;

      // reason 결정
      const finalPhase = this.issuePhases.get(identifier) ?? 'initial';
      const reason: DispatchReason = wasAuthError
        ? 'slack_response'
        : (finalPhase === 'review_fixing' && event.isApproval) ? 'review_fix'
        : (finalPhase === 'pr_fixing') ? 'pr_feedback'
        : 'slack_response';

      this.dispatch(issue, {
        reason,
        resumeMessage,
      });
    } finally {
      this.pendingDispatch.delete(identifier);
    }
    }); // logContext.run
  }

  private async handleSlackPrFeedback(
    issue: Issue,
    event: FeedbackResponseEvent,
    ref: WorkspaceRef,
  ): Promise<void> {
    const { issueIdentifier: identifier } = event;

    logger.info(`Slack PR feedback received for ${identifier}`, { text: event.responseText.slice(0, 100) });

    await this.humanChannel?.sendNotification(
      issue,
      `💬 *[${formatIssueLabel(issue)}]* Slack PR 피드백이 도착했습니다. 처리를 시작합니다.`,
    ).catch((err) => {
      logger.warn(`Failed to notify Slack PR feedback for ${identifier}`, { error: String(err) });
    });

    if (await this.io.exists(ref)) {
      const comment: Comment = {
        id: `slack:${Date.now()}`,
        body: event.responseText,
        authorLogin: 'slack_user',
        isBot: false,
        createdAt: new Date(),
      };
      await this.appendPrFeedback(ref, [comment]);
    }

    this.setPhase(issue.identifier, 'pr_fixing');
    this.dispatch(issue, {
      reason: 'pr_feedback',
      resumeMessage: 'Slack을 통해 PR 피드백이 도착했습니다. .symphony/pr_feedback.json을 읽고 처리하세요.',
    });
  }

  // ---------------------------------------------------------------------------
  // 레포지토리 이벤트
  // ---------------------------------------------------------------------------

  private startRepoPoller(): void {
    const repos = this.trackerConfig.repositories ?? [];
    if (repos.length === 0) {
      // 폴백: 단일 레포지토리 필드 (멀티 레포 이전 호환)
      const repoCfg = this.trackerConfig.repository;
      if (!repoCfg) return;
      const key = repoCfg.kind === 'github' ? repoCfg.repo : `${repoCfg.workspace}/${repoCfg.repo_slug}`;
      const poller = new RepoPoller(repoCfg, (event) => this.handleRepoEvent(event), this.config.workspace.root);
      this.repoPollers.set(key, poller);
      poller.start();
      return;
    }

    for (const repoCfg of repos) {
      const key = repoCfg.kind === 'github' ? repoCfg.repo : `${repoCfg.workspace}/${repoCfg.repo_slug}`;
      const poller = new RepoPoller(repoCfg, (event) => this.handleRepoEvent(event), this.config.workspace.root);
      this.repoPollers.set(key, poller);
      poller.start();
    }
  }

  private handleRepoEvent(event: RepoEvent): void {
    const record: RepoEventRecord = {
      kind: event.kind,
      prNumber: event.pr.number,
      issueIdentifier: event.pr.issueIdentifier,
      timestamp: new Date(),
    };

    this.repoEvents.unshift(record);
    if (this.repoEvents.length > MAX_REPO_EVENTS) this.repoEvents.pop();

    this.emit('repo:event', event);

    const identifier = event.pr.issueIdentifier;

    switch (event.kind) {
      case 'new_comments':
        logger.info(`New comments on PR #${event.pr.number} for issue ${identifier ?? 'unknown'}`);
        if (identifier) {
          void this.handleNewComments(identifier, event.pr.labels, event.comments ?? []);
        }
        break;

      case 'pr_merged':
        logger.info(`PR #${event.pr.number} merged for issue ${identifier ?? 'unknown'}`);
        if (identifier) {
          void this.handlePRMerged(identifier, event.pr);
        }
        break;
    }
  }

  private async handleNewComments(
    identifier: string,
    prLabels: string[],
    comments: Comment[],
  ): Promise<void> {
    // 최근 머지된 이슈에 대한 PR 댓글은 무시 (머지 직후 댓글 이벤트 레이스 방지)
    if (this.recentlyMerged.has(identifier)) {
      logger.debug(`handleNewComments: ignoring ${comments.length} comment(s) for recently merged ${identifier}`);
      return;
    }

    // PR 댓글을 트래커에 기록
    if (comments.length > 0) {
      const issue = await this.resolveIssueFromIdentifier(identifier, false);
      if (issue) {
        const commentText = comments
          .map((c) => `**${c.authorLogin}**${c.path ? ` (${c.path}:${c.line ?? ''})` : ''}:\n${c.body}`)
          .join('\n\n---\n\n');
        this.logConversationToTracker(issue.id, '[PR Comment]', commentText);
      }
    }

    // 케이스 1: 에이전트 실행 중 또는 디스패치 진행 중 → 나중을 위해 큐에 추가
    if (this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier)) {
      this.enqueueComments(identifier, prLabels, comments);
      return;
    }

    // 케이스 2: 휴먼 채널 승인 대기 중 → 피드백 병합 후 재계획
    if (this.humanChannel?.isWatching(identifier)) {
      await this.mergeAndReplan(identifier, prLabels, comments);
      return;
    }

    // 케이스 3: 유휴 상태 → 즉시 디스패치
    this.pendingDispatch.add(identifier);
    await logContext.run({ identifier }, async () => {
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      // 알림: PR 댓글 도착
      await this.humanChannel?.sendNotification(issue, `💬 *[${formatIssueLabel(issue)}]* PR 댓글이 도착했습니다. 처리를 시작합니다.`).catch((err) => {
        logger.warn(`Failed to notify PR comment arrival for ${identifier}`, { error: String(err) });
      });

      const ref = this.io.refForIssue(issue);
      const containerReady = await this.io.exists(ref);

      // 컨테이너가 있으면 직접 쓰기, 없으면 dispatch를 통해 컨테이너 생성 후 쓰기
      let prFeedbackPayload: string | undefined;
      if (containerReady) {
        await this.writePrFeedback(ref, comments);
      } else {
        prFeedbackPayload = JSON.stringify({
          comments: this.serializeComments(comments),
          base_commit: null,
          received_at: new Date().toISOString(),
        });
      }

      this.setPhase(identifier, 'pr_fixing');
      this.dispatch(issue, {
        prLabels,
        reason: 'pr_feedback',
        resumeMessage: 'PR 피드백이 도착했습니다. .symphony/pr_feedback.json을 읽고 처리하세요.',
        prFeedbackPayload,
      });
      // cap 초과로 dispatch가 실행되지 않은 경우 phase 롤백 (영구 정체 방지)
      if (!this.limiter.has(identifier)) {
        logger.warn(`Container cap reached; dropping PR feedback dispatch for ${identifier}`);
        this.clearPhase(identifier);
      }
    } finally {
      this.pendingDispatch.delete(identifier);
    }
    }); // logContext.run
  }

  // ---------------------------------------------------------------------------
  // PR 머지 처리
  // ---------------------------------------------------------------------------

  private async handlePRMerged(
    identifier: string,
    pr: import('./types.js').PullRequest,
  ): Promise<void> {
    // 이슈를 terminal 상태로 전환, 브랜치 삭제, 정리 — 에이전트 디스패치 없음
    try {
      // recentlyMerged 플래그 설정 — PR 댓글 race 방지 (terminateIssue 호출 전에 설정)
      this.recentlyMerged.set(identifier, Date.now());

      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) {
        // issue 해석 실패 시에도 running agent는 반드시 abort (terminateIssue를 건너뛰므로 직접 처리)
        for (const [id, entry] of this.running) {
          if (entry.issue.identifier === identifier) {
            entry.abortController.abort();
            this.running.delete(id);
            break;
          }
        }
        // candidate 필터 우회 방지: terminateIssue를 건너뛰므로 recentlyTerminated를 직접 설정
        this.recentlyTerminated.set(identifier, Date.now());
        this.limiter.release(identifier);
        this.clearPhase(identifier);
        return;
      }

      const terminalState = this.trackerConfig.terminal_states[0];
      await this.terminateIssue(identifier, {
        reason: 'pr_merged',
        issue,
        transitionTo: terminalState,
        deletePrBranch: pr.branchName ? { branchName: pr.branchName } : undefined,
      });
    } catch (err) {
      logger.error(`handlePRMerged failed for ${identifier}`, { error: String(err) });
      this.limiter.release(identifier);
      this.clearPhase(identifier);
    }
  }

  // ---------------------------------------------------------------------------
  // PR 댓글 큐 및 병합 헬퍼
  // ---------------------------------------------------------------------------

  private enqueueComments(identifier: string, prLabels: string[], comments: Comment[]): void {
    const existing = this.queuedComments.get(identifier);
    if (existing) {
      existing.comments.push(...comments);
    } else {
      this.queuedComments.set(identifier, { comments: [...comments], prLabels });
    }
    const entry = this.queuedComments.get(identifier)!;
    if (entry.comments.length > MAX_QUEUED_COMMENTS_PER_ISSUE) {
      const dropped = entry.comments.length - MAX_QUEUED_COMMENTS_PER_ISSUE;
      entry.comments.splice(0, dropped);
      logger.warn(
        `queuedComments for ${identifier} exceeded MAX_QUEUED_COMMENTS_PER_ISSUE=${MAX_QUEUED_COMMENTS_PER_ISSUE}; ` +
        `가장 오래된 댓글 ${dropped}개를 삭제했습니다.`,
      );
    }
    logger.info(
      `Queued ${comments.length} PR comment(s) for ${identifier} (total queued: ${entry.comments.length})`,
    );
  }

  // ---------------------------------------------------------------------------
  // 이슈 터미네이트 (공통 정리 진입점)
  // ---------------------------------------------------------------------------

  /**
   * 이슈의 오케스트레이터 상태를 완전히 정리한다.
   * PR 머지, canceled 상태 전환, 컨테이너 소실 등 모든 터미네이트 경로의 공통 진입점.
   *
   * 모든 단계는 독립 try/catch로 감싸져 있어
   * 단일 단계 실패가 후속 단계를 막지 않는다 (graceful cleanup).
   * 브랜치/PR/워크스페이스/Slack 스레드가 없어도 에러 없이 완료된다.
   */
  private async terminateIssue(
    identifier: string,
    opts: {
      /** 터미네이트 사유 — 로그/알림 문구 분기에 사용. */
      reason: 'pr_merged' | 'canceled';
      /** 이미 알려진 Issue 객체. 없으면 캐시 조회 후 tracker에서 lazy-fetch. */
      issue?: Issue;
      /** 설정된 경우 tracker 상태를 이 값으로 전환. 없으면 전환 스킵. */
      transitionTo?: string;
      /** 설정된 경우 해당 브랜치를 모든 repoPoller에 삭제 시도. 없으면 브랜치 삭제 스킵. */
      deletePrBranch?: { branchName: string };
    },
  ): Promise<void> {
    // 동시 호출 방지: 동일 identifier가 이미 처리 중이면 즉시 반환
    if (this.inFlightTerminations.has(identifier)) {
      logger.debug(`terminateIssue: skipping duplicate call for ${identifier} (already in-flight)`);
      return;
    }
    this.inFlightTerminations.add(identifier);

    try {
      // 중복 터미네이트 방지 플래그 (recentlyMerged와 동일 패턴)
      this.recentlyTerminated.set(identifier, Date.now());
      this.missingTickCounts.delete(identifier);
      this.labelMismatchNotified.delete(identifier);

      logger.info('terminateIssue', { identifier, reason: opts.reason });

      // 1. Running agent abort + 재시도 타이머 정리
      const pendingTimers = this.retryTimersByIdentifier.get(identifier);
      if (pendingTimers) {
        for (const t of pendingTimers) {
          clearTimeout(t);
          this.retryTimers.delete(t);
        }
        this.retryTimersByIdentifier.delete(identifier);
      }
      let abortedEntry: RunningEntry | undefined;
      for (const [id, entry] of this.running) {
        if (entry.issue.identifier === identifier) {
          logger.info(`terminateIssue: aborting running agent for ${identifier}`);
          entry.abortController.abort();
          abortedEntry = entry;
          this.running.delete(id);
          // break 제거 — 동일 identifier의 모든 entry abort
        }
      }

      // in-flight I/O graceful shutdown: cleanup 전 최대 10초 대기
      if (abortedEntry) {
        const GRACEFUL_TIMEOUT_MS = 10_000;
        await Promise.race([
          abortedEntry.promise.catch(() => {}),
          new Promise<void>((r) => setTimeout(r, GRACEFUL_TIMEOUT_MS)),
        ]);
      }

      // Issue 객체 확보 (이후 단계에서 필요)
      let issue = opts.issue ?? this.watchedIssues.get(identifier) ?? null;
      if (!issue) {
        try {
          issue = await this.resolveIssueFromIdentifier(identifier, false);
        } catch (err) {
          logger.warn(`terminateIssue: failed to resolve issue ${identifier}`, { error: String(err) });
        }
      }

      // 2. 트래커 상태 전환 (optional — transitionTo 지정 시만)
      if (opts.transitionTo && issue) {
        try {
          await this.tracker.transitionIssue(issue.id, opts.transitionTo);
          logger.info(`terminateIssue: transitioned ${identifier} to "${opts.transitionTo}"`);
        } catch (err) {
          logger.warn(`terminateIssue: failed to transition ${identifier} to "${opts.transitionTo}"`, { error: String(err) });
        }
      }

      // 3. PR 피처 브랜치 삭제 (optional — deletePrBranch 지정 시만, pr_merged 경로 전용)
      //    canceled 경로에서는 의도적으로 호출하지 않음 (사용자가 재개할 가능성 보존)
      if (opts.deletePrBranch && this.repoPollers.size > 0) {
        for (const poller of this.repoPollers.values()) {
          try {
            const deleted = await poller.deleteBranch(opts.deletePrBranch.branchName);
            if (deleted) {
              logger.info(`terminateIssue: deleted branch ${opts.deletePrBranch.branchName} for ${identifier}`);
              break;
            }
          } catch {
            // 이 레포에 브랜치가 없을 수 있음, 다음 시도
          }
        }
      }

      // 4. Slack 알림 + 스레드 완전 삭제
      //    Slack mrkdwn(notifySlack)과 tracker plain text(notifyTracker)를 분리한다.
      //    sendNotification은 isWatching일 때만, logConversationToTracker는 항상 기록.
      if (this.humanChannel && issue) {
        try {
          const label = formatIssueLabel(issue);
          let notifySlack: string;
          let notifyTracker: string;
          switch (opts.reason) {
            case 'pr_merged':
              notifySlack = `:merged: *[${label}]* PR이 머지되어 작업이 완료되었습니다.`;
              notifyTracker = `[${label}] PR이 머지되어 작업이 완료되었습니다.`;
              break;
            case 'canceled':
              notifySlack = `:x: *[${label}]* 이슈가 취소되어 작업이 중단되었습니다.`;
              notifyTracker = `[${label}] 이슈가 취소되어 작업이 중단되었습니다.`;
              break;
            default:
              assertNever(opts.reason);
          }
          if (this.humanChannel.isWatching(identifier)) {
            await this.humanChannel.sendNotification(issue, notifySlack).catch((err) => {
              logger.warn(`terminateIssue: slack notification failed for ${identifier}`, { error: String(err) });
            });
          }
          this.logConversationToTracker(issue.id, '[Bot]', notifyTracker);
        } catch (err) {
          logger.warn(`terminateIssue: slack step failed for ${identifier}`, { error: String(err) });
        }
      }
      this.humanChannel?.forgetThread(identifier); // 멱등 — thread 없어도 안전

      // 5. PR 머지 경로: 비용 댓글 작성 (중복 방지)
      //    clearPhase()는 costCommentWritten 플래그를 삭제하므로 반드시 이 블록 이후에 호출해야 한다.
      if (opts.reason === 'pr_merged' && issue) {
        const costData = this.costTracker.getIssue(identifier);
        if (costData && !this.costCommentWritten.has(identifier)) {
          this.costCommentWritten.add(identifier);
          const costComment = `[Agent Summary] Cost: $${costData.costUsd.toFixed(4)} | Tokens: ${costData.tokens.toLocaleString()} | Turns: ${costData.turns}`;
          try {
            await this.tracker.createComment(issue.id, costComment);
          } catch (err) {
            logger.warn(`terminateIssue: failed to write cost comment for ${identifier}`, { error: String(err) });
          }
        }
      }

      // 6. Phase clear (멱등) — costCommentWritten 플래그를 삭제하므로 비용 댓글 작성 이후에 호출
      this.clearPhase(identifier);

      // 7. Queued comments 제거 (멱등)
      this.queuedComments.delete(identifier);

      // 8. 워크스페이스/컨테이너 정리 — 존재 여부 확인 후 시도 (없으면 gracefully 스킵)
      const issueForCleanup: Issue = issue ?? {
        identifier,
        id: identifier, // fallback: refForIssue는 identifier만 사용하므로 내부 ID 불필요
        title: identifier,
        description: null,
        priority: null,
        state: '',
        branchName: null,
        url: '',
        assigneeId: null,
        assigneeEmail: null,
        labels: [],
        blockedBy: [],
        assignedToWorker: false,
        createdAt: null,
        updatedAt: null,
      };
      try {
        const ref = this.io.refForIssue(issueForCleanup);
        const wsExists = await this.io.exists(ref);
        if (wsExists) {
          const backend = createWorkspaceBackend(this.config, this.resolveRepository(issueForCleanup) ?? undefined, this.trackerConfig);
          await backend.cleanup(ref, issueForCleanup);
          logger.info(`terminateIssue: workspace cleaned up for ${identifier}`);
        } else {
          logger.debug(`terminateIssue: no workspace found for ${identifier} — skipping cleanup`);
        }
      } catch (err) {
        logger.warn(`terminateIssue: workspace cleanup failed for ${identifier}`, { error: String(err) });
      }

      // 9. Admission slot 해제 + watchedIssues 제거 (멱등)
      this.limiter.release(identifier);
      this.watchedIssues.delete(identifier);
      logger.debug(`terminateIssue: released slot for ${identifier} (admitted=${this.limiter.size()}/${this.limiter.maxContainers})`);
    } finally {
      this.inFlightTerminations.delete(identifier);
    }
  }

  // ---------------------------------------------------------------------------
  // canceled 드롭 감지
  // ---------------------------------------------------------------------------

  /**
   * 폴링 후보에서 사라진 이슈 중 canceled 상태로 전환된 것을 감지해 terminateIssue를 호출한다.
   *
   * 폴당 최대 1회 fetchIssuesByIds 배치 호출(50개 청크)로 처리한다:
   *  - WAITING_PHASES(승인 대기 중) 이슈는 intermediate 상태이므로 스킵
   *  - canceled 상태는 2단계 확인(canceledPendingMap) 후 terminate
   *  - 연속 5회 tracker 응답에서 누락 시 터미네이트
   *  - 다른 terminal_states도 watchedIssues에서 제거해 영구 고착 방지
   *
   * states.canceled 미구성 시 no-op (start()에서 경고 출력).
   */
  private async detectDroppedIssues(candidates: Issue[]): Promise<void> {
    const canceledState = this.trackerConfig.states.canceled;
    if (!canceledState) return;

    const canceledNorm = canceledState.toLowerCase().trim();
    const terminalNorms = new Set(this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()));
    const candidateIds = new Set(candidates.map((c) => c.identifier));

    // canceled 감지 대상: candidates에 없고 최근 처리 안 된 이슈
    // WAITING_PHASES(승인 대기 중) 이슈도 canceled 상태 확인 대상에 포함한다.
    // 단 missing-tick(연속 미확인) 처리는 WAITING_PHASES에서 제외해 오판 방지.
    const toCheckMap = new Map<string, Issue>(); // identifier → issue

    for (const entry of this.running.values()) {
      const id = entry.issue.identifier;
      if (
        !candidateIds.has(id) &&
        !this.recentlyMerged.has(id) &&
        !this.recentlyTerminated.has(id) &&
        !this.pendingDispatch.has(id)
      ) {
        toCheckMap.set(id, entry.issue);
      }
    }

    for (const [id, issue] of this.watchedIssues) {
      if (
        !candidateIds.has(id) &&
        !this.isRunningByIdentifier(id) &&
        !this.recentlyMerged.has(id) &&
        !this.recentlyTerminated.has(id) &&
        !this.pendingDispatch.has(id) &&
        !toCheckMap.has(id)
      ) {
        toCheckMap.set(id, issue);
      }
    }

    // candidates로 복귀한 이슈의 스테일 canceledPendingMap 엔트리 정리
    for (const id of [...this.canceledPendingMap.keys()].filter((id) => !toCheckMap.has(id))) {
      this.canceledPendingMap.delete(id);
    }

    // missingTickCounts 고립 엔트리 프루닝 (watchedIssues/running 어디에도 없는 항목)
    for (const id of [...this.missingTickCounts.keys()].filter((id) => !toCheckMap.has(id))) {
      this.missingTickCounts.delete(id);
    }

    if (toCheckMap.size === 0) return;

    // 50개 청크로 분할해 fetchIssuesByIds 호출 — JQL 길이/타임아웃 제한 방지
    const CHUNK_SIZE = 50;
    const allIssues = [...toCheckMap.values()];
    const internalIds = [...new Set(allIssues.map((i) => i.id))];
    let fetched: Issue[] = [];
    let failedIdCount = 0; // 청크 실패로 인해 조회 불가능한 ID 수
    for (let i = 0; i < internalIds.length; i += CHUNK_SIZE) {
      const chunk = internalIds.slice(i, i + CHUNK_SIZE);
      try {
        const result = await this.tracker.fetchIssuesByIds(chunk);
        fetched.push(...result);
      } catch (err) {
        logger.warn(`detectDroppedIssues: fetchIssuesByIds chunk[${i}..${i + chunk.length}] failed`, { error: String(err) });
        // 청크 실패 시 해당 청크의 ID를 toCheckMap에서 제거 (missing 카운트 갱신 방지)
        failedIdCount += chunk.length;
        const failedIds = new Set(chunk);
        const toDelete: string[] = [];
        for (const [identifier, cachedIssue] of toCheckMap) {
          if (failedIds.has(cachedIssue.id)) toDelete.push(identifier);
        }
        for (const id of toDelete) toCheckMap.delete(id);
      }
    }

    // 부분 응답 감지: 성공 청크 기준 응답 수를 비교 (실패 청크 ID는 제외하여 오판 방지)
    const expectedCount = internalIds.length - failedIdCount;
    const partialResponse = fetched.length < expectedCount;
    if (partialResponse) {
      logger.warn(`detectDroppedIssues: partial response (got ${fetched.length}/${expectedCount} from successful chunks) — skipping missing count update`);
    }

    const fetchedByIdentifier = new Map(fetched.map((i) => [i.identifier, i]));

    for (const [identifier, cachedIssue] of toCheckMap) {
      const current = fetchedByIdentifier.get(identifier);
      if (!current) {
        if (partialResponse) {
          // 부분 응답일 때는 missing으로 간주하지 않음
          continue;
        }
        // tracker에서 찾을 수 없음 (삭제되거나 권한 변경 등)
        // WAITING_PHASES(승인 대기 중) 이슈는 missing-tick 오판 방지를 위해 스킵 (canceled 상태 확인은 허용)
        // 누락을 정상 상태로 간주하므로 카운터도 초기화한다.
        if (WAITING_PHASES.has(this.issuePhases.get(identifier) as IssuePhase)) {
          this.missingTickCounts.delete(identifier);
          continue;
        }
        // 일시적 API 장애 오판 방지 — 연속 5회 이상 확인 후 터미네이트
        const count = (this.missingTickCounts.get(identifier) ?? 0) + 1;
        if (count >= 5) {
          logger.info(`detectDroppedIssues: ${identifier} missing ${count} consecutive polls — presumed deleted or permission-changed; terminating`);
          this.missingTickCounts.delete(identifier);
          this.canceledPendingMap.delete(identifier);
          await this.terminateIssue(identifier, { reason: 'canceled', issue: cachedIssue });
        } else {
          this.missingTickCounts.set(identifier, count);
          logger.debug(`detectDroppedIssues: ${identifier} missing from tracker (tick=${count}/5)`);
        }
      } else {
        this.missingTickCounts.delete(identifier); // 다시 보이면 카운터 초기화
        const stateNorm = current.state.toLowerCase().trim();
        if (stateNorm === canceledNorm) {
          // 2단계 canceled 처리: 최초 감지 시 pending 등록 + Slack 알림, 다음 폴에서 확인 후 terminate
          if (this.canceledPendingMap.has(identifier)) {
            logger.info(`detectDroppedIssues: ${identifier} confirmed canceled (2nd poll); terminating`);
            this.canceledPendingMap.delete(identifier);
            await this.terminateIssue(identifier, { reason: 'canceled', issue: current });
          } else {
            logger.info(`detectDroppedIssues: ${identifier} detected canceled (1st poll); scheduling termination after next poll`);
            this.canceledPendingMap.set(identifier, Date.now());
            if (this.humanChannel && this.humanChannel.isWatching(identifier)) {
              const label = formatIssueLabel(current);
              await this.humanChannel.sendNotification(current,
                `:x: *[${label}]* 이슈가 canceled로 전환되었습니다. 다음 폴링에서 상태가 유지되면 작업을 종료합니다.`,
              ).catch((err) => logger.warn(`detectDroppedIssues: grace notification failed for ${identifier}`, { error: String(err) }));
            }
          }
        } else if (terminalNorms.has(stateNorm) && stateNorm !== canceledNorm) {
          // 다른 terminal state (완료, Duplicate 등) → watchedIssues에서 제거 (terminate 없음)
          logger.info(`detectDroppedIssues: ${identifier} reached terminal state "${current.state}"; removing from watch`);
          this.canceledPendingMap.delete(identifier);
          this.watchedIssues.delete(identifier);
          this.limiter.release(identifier);
          this.missingTickCounts.delete(identifier);
        } else {
          // 중간 상태(On Hold 등) — canceledPending 초기화
          this.canceledPendingMap.delete(identifier);
        }
      }
    }
  }

  private drainCommentQueue(identifier: string): void {
    const queued = this.queuedComments.get(identifier);
    if (!queued || queued.comments.length === 0) return;

    this.queuedComments.delete(identifier);
    logger.info(`Draining ${queued.comments.length} queued PR comment(s) for ${identifier}`);
    void this.handleNewComments(identifier, queued.prLabels, queued.comments);
  }

  /**
   * Slack 승인 대기 중 새 댓글 도착 → pr_feedback.json에 병합 후 에이전트 재실행.
   * 에이전트가 전체 피드백을 반영한 plan을 재작성하여 Slack 스레드에 업데이트.
   */
  private async mergeAndReplan(
    identifier: string,
    prLabels: string[],
    comments: Comment[],
  ): Promise<void> {
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      const ref = this.io.refForIssue(issue);
      if (!(await this.io.exists(ref))) {
        logger.info(`Workspace not found for ${identifier}; dispatching fresh run`);
        this.dispatch(issue, { prLabels, reason: 'pr_feedback', resumeMessage: 'PR 피드백이 도착했습니다. .symphony/pr_feedback.json을 읽고 처리하세요.' });
        return;
      }

      // 새 댓글을 기존 pr_feedback.json에 병합
      await this.appendPrFeedback(ref, comments);

      // 채널에 재계획 시작 알림
      if (this.humanChannel && issue) {
        await this.humanChannel.sendNotification(issue, `🔄 새로운 PR 피드백이 도착하여 계획을 작성합니다.`).catch((err) => {
          logger.warn(`Failed to notify replan for ${identifier}`, { error: String(err) });
        });
      }

      this.setPhase(identifier, 'pr_fixing');
      this.dispatch(issue, {
        prLabels,
        reason: 'pr_feedback',
        resumeMessage: 'PR 피드백이 도착했습니다. .symphony/pr_feedback.json을 읽고 처리하세요.',
      });
      // cap 초과로 dispatch가 실행되지 않은 경우 phase 롤백 (영구 정체 방지)
      if (!this.limiter.has(identifier)) {
        logger.warn(`Container cap reached; dropping PR replan dispatch for ${identifier}`);
        this.clearPhase(identifier);
      }
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  private serializeComments(comments: Comment[]): Array<Record<string, unknown>> {
    return comments.map((c) => ({
      id: c.id,
      body: c.body,
      author: c.authorLogin,
      path: c.path ?? null,
      line: c.line ?? null,
      created_at: c.createdAt?.toISOString() ?? null,
    }));
  }

  private async clearPrFeedback(issue: Issue): Promise<void> {
    const ref = this.io.refForIssue(issue);
    try {
      if (await this.io.exists(ref)) {
        await this.io.writeFile(ref, '.symphony/pr_feedback.json', '');
      }
    } catch { /* non-fatal */ }
  }

  private async writePrFeedback(ref: WorkspaceRef, comments: Comment[]): Promise<void> {
    const base_commit = await this.io.getCommitHash(ref).catch(() => null);
    const payload = JSON.stringify({
      comments: this.serializeComments(comments),
      base_commit,
      received_at: new Date().toISOString(),
    });
    await this.io.writeFile(ref, '.symphony/pr_feedback.json', payload);
  }

  private async appendPrFeedback(ref: WorkspaceRef, newComments: Comment[]): Promise<void> {
    let existingEntries: Array<{ id: string; [key: string]: unknown }> = [];
    try {
      const raw = await this.io.readFile(ref, '.symphony/pr_feedback.json');
      if (raw) {
        const parsed = JSON.parse(raw);
        existingEntries = Array.isArray(parsed.comments) ? parsed.comments : [];
      }
    } catch { /* no existing file */ }

    const existingIds = new Set(existingEntries.map((e) => e.id));
    const deduped = newComments.filter((c) => !existingIds.has(c.id));

    const allEntries = [...existingEntries, ...this.serializeComments(deduped)];

    const base_commit = await this.io.getCommitHash(ref).catch(() => null);

    const payload = JSON.stringify({
      comments: allEntries,
      base_commit,
      received_at: new Date().toISOString(),
    });
    await this.io.writeFile(ref, '.symphony/pr_feedback.json', payload);
  }

  /**
   * identifier(예: "TES-7")로 이슈를 조회한다.
   *
   * 조회 순서:
   *  1. watchedIssues 캐시에 있으면 → 바로 반환.
   *  2. 폴백: 트래커에서 identifier로 조회.
   */
  private async resolveIssueFromIdentifier(identifier: string, skipCache = false): Promise<Issue | null> {
    if (!skipCache) {
      const cached = this.watchedIssues.get(identifier);
      if (cached) {
        logger.debug(`Resolved ${identifier} from cache`);
        return cached;
      }
    }

    logger.info(`Resolving ${identifier} from tracker`);
    try {
      const issue = await this.tracker.fetchIssueByIdentifier(identifier);
      if (!issue) {
        logger.warn(`Issue ${identifier} not found in tracker`);
        return null;
      }
      return issue;
    } catch (err) {
      logger.error(`Failed to fetch issue ${identifier} from tracker`, { error: String(err) });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function sanitizeForSlack(text: string): string {
  return text
    .replace(/<!(?:channel|here|everyone)>/g, '[알림차단]')
    .replace(/<@[A-Z0-9]+>/g, '[멘션차단]')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/`{3}/g, "'''");
}

function createTrackerClient(config: TrackerConfig): TrackerClient {
  if (config.kind === 'linear') return new LinearClient(config);
  if (config.kind === 'jira') return new JiraClient(config);
  return assertNever(config);
}

function trackerLabel(config: TrackerConfig): string {
  if (config.kind === 'linear') return `linear:${config.project_slug}`;
  if (config.kind === 'jira') return `jira:${config.project_key}`;
  return assertNever(config);
}

/** 완전성 검사 헬퍼 — TypeScript가 컴파일 타임에 도달 불가능함을 보장한다. */
function assertNever(x: never): never {
  throw new Error(`Unhandled discriminated union case: ${JSON.stringify(x)}`);
}
