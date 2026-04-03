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
import { SlackChannel } from './channel/slack.js';
import type { FeedbackResponseEvent } from './types.js';
import { spawn } from 'node:child_process';
import { shellEscape } from './shell-utils.js';
import { CostTracker } from './cost-tracker.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { DiffQueueStore } from './slack/diff-queue.js';
import { DiffSender } from './slack/diff-sender.js';
import { parseDiffToFiles } from './slack/diff-parser.js';
import type { Issue, TrackerClient, RepoEvent, AgentMessage, Comment, WorkspaceRef, WorkspaceIO, DispatchReason, IssuePhase } from './types.js';
import type { Config, TrackerConfig, AgentConfig, ClaudeAgentConfig, CodexAgentConfig, RepositoryConfig } from './config/schema.js';

const WAITING_PHASES: ReadonlySet<IssuePhase> = new Set(['plan_sent', 'pr_plan_sent', 'question_sent', 'review_sent']);

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
  /** true이면 이 엔트리가 동시 실행 제한 슬롯을 점유함 (완료 시 해제) */
  acquiredSlot: boolean;
}

export interface OrchestratorSnapshot {
  trackerId: string;
  running: RunningEntry[];
  completedCount: number;
  failedCount: number;
  repoEvents: RepoEventRecord[];
}

export interface RepoEventRecord {
  kind: string;
  prNumber: number;
  issueIdentifier: string | null;
  timestamp: Date;
}

const MAX_REPO_EVENTS = 20;
const STALE_AGENT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4시간

export interface TransferableState {
  issuePhases: Map<string, IssuePhase>;
  pendingDispatch: Set<string>;
  watchedIssues: Map<string, Issue>;
  queuedComments: Map<string, { comments: Comment[]; prLabels: string[] }>;
  recentlyMerged: Map<string, number>;
  completedCount: number;
  failedCount: number;
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
  private issuePhases = new Map<string, IssuePhase>(); // identifier → 현재 phase
  private watchedIssues = new Map<string, Issue>(); // identifier → 마지막으로 알려진 Issue
  private queuedComments = new Map<string, { comments: Comment[]; prLabels: string[] }>(); // identifier → 큐에 쌓인 PR 댓글
  private recentlyMerged = new Map<string, number>(); // identifier → 타임스탬프
  private completedCount = 0;
  private failedCount = 0;
  private repoEvents: RepoEventRecord[] = [];

  private trackerPoller: TrackerPoller | null = null;
  private repoPollers: Map<string, RepoPoller> = new Map();
  private humanChannel: SlackChannel | null = null;
  private readonly limiter: ConcurrencyLimiter;
  private readonly io: WorkspaceIO;
  private costTracker: CostTracker;
  private diffQueueStore: DiffQueueStore;
  private diffSender: DiffSender | null = null;
  private stopped = false;
  private lastThreadPruneAt = 0;
  private costCommentWritten = new Set<string>(); // identifier → 비용 댓글 작성 완료
  private agentLogStreams = new Map<string, fs.WriteStream>(); // identifier → log WriteStream
  private readonly logsDir: string;
  private symphonyStream!: fs.WriteStream;
  private fileSink!: IssueAwareLogSink;
  private static readonly THREAD_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5분

  constructor(config: Config, trackerConfig: TrackerConfig, promptTemplate: string, limiter: ConcurrencyLimiter) {
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
    this.startHumanChannel(); // humanChannel 먼저 시작 (recoverFromWorkspaces에서 필요)

    // DiffSender 초기화 (slack config 있을 때만)
    if (this.config.slack) {
      this.diffSender = new DiffSender(this.config.slack.bot_token, this.diffQueueStore);
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

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.trackerPoller?.stop();
    for (const p of this.repoPollers.values()) p.stop();
    this.humanChannel?.stop();
    for (const entry of this.running.values()) {
      entry.abortController.abort();
      if (entry.acquiredSlot) {
        this.limiter.release();
        entry.acquiredSlot = false;
      }
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
          if (entry.acquiredSlot) {
            this.limiter.release();
            entry.acquiredSlot = false;
          }
        }
        this.running.clear();
      }
    }

    // 3. humanChannel 정지 (에이전트 완료 처리 후)
    this.humanChannel?.stop();

    // 4. 상태 추출
    return {
      issuePhases: new Map(this.issuePhases),
      pendingDispatch: new Set(this.pendingDispatch),
      watchedIssues: new Map(this.watchedIssues),
      queuedComments: new Map(this.queuedComments),
      recentlyMerged: new Map(this.recentlyMerged),
      completedCount: this.completedCount,
      failedCount: this.failedCount,
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
    this.completedCount = state.completedCount;
    this.failedCount = state.failedCount;
  }

  /**
   * 시작 시 기존 워크스페이스를 탐색하고
   * 아직 활성 상태인 이슈를 재디스패치한다.
   */
  private async recoverFromWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.io.list();
      if (workspaces.length === 0) {
        // 워크스페이스가 없어도 stale 스레드 정리는 실행
        await this.pruneStaleThreads();
        return;
      }

      logger.info(`Recovery: found ${workspaces.length} existing workspace(s)`);

      const terminalNorm = this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim());

      for (const ws of workspaces) {
        const identifier = ws.identifier;
        if (!identifier) continue;

        try {
          const issue = await this.tracker.fetchIssueByIdentifier(identifier);
          if (!issue) {
            logger.info(`Recovery: ${identifier} not found in tracker; cleaning up thread`);
            this.humanChannel?.forgetThread(identifier);
            continue;
          }

          this.trackWatchedIssue(issue);

          const stateNorm = issue.state.toLowerCase().trim();

          // Terminal state → 스레드 완전 삭제
          if (terminalNorm.includes(stateNorm)) {
            logger.info(`Recovery: ${identifier} in terminal state "${issue.state}"; cleaning up thread`);
            this.humanChannel?.forgetThread(identifier);
            continue;
          }

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
            this.issuePhases.set(identifier, persistedPhase);
            logger.info(`Recovery: ${identifier} — restored phase "${persistedPhase}" from phase.json`);

            // 대기 phase는 dispatch하지 않음 (인간 승인 대기 중)
            if (WAITING_PHASES.has(persistedPhase)) {
              logger.info(`Recovery: ${identifier} in waiting phase "${persistedPhase}" — skipping dispatch`);
              continue;
            }

            // 나머지 active phase는 re-dispatch
            if (!this.running.has(issue.id)) {
              logger.info(`Recovery: re-dispatching ${identifier} (restored phase="${persistedPhase}")`);
              this.dispatch(issue, { reason: 'recovery', resumeMessage: '시스템이 재시작되었습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.' });
            }
            continue;
          }

          // phase.json 없음 — 트래커 상태로 추론 (하위 호환)
          const planReviewNorm = this.trackerConfig.states.plan_review.toLowerCase().trim();
          const inReviewNorm = this.trackerConfig.states.in_review.toLowerCase().trim();
          if (stateNorm === planReviewNorm) {
            this.issuePhases.set(identifier, 'plan_sent');
            logger.info(`Recovery: ${identifier} in plan_review — inferred plan_sent phase, skipping dispatch`);
            continue;
          }
          if (stateNorm === inReviewNorm) {
            this.issuePhases.set(identifier, 'review_sent');
            logger.info(`Recovery: ${identifier} in in_review — inferred review_sent phase, skipping dispatch`);
            continue;
          }

          const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());
          if (!activeNorm.includes(stateNorm)) {
            logger.info(`Recovery: ${identifier} in state "${issue.state}" (not active); skipping dispatch`);
            continue;
          }

          if (this.running.has(issue.id)) continue;

          logger.info(`Recovery: re-dispatching ${identifier} (state="${issue.state}")`);
          this.dispatch(issue, { reason: 'recovery', resumeMessage: '시스템이 재시작되었습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.' });
        } catch (err) {
          logger.warn(`Recovery: failed to process workspace ${ws.name}`, { error: String(err) });
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
    };
  }

  // ---------------------------------------------------------------------------
  // 후보 이슈 처리 (TrackerPoller에서 호출)
  // ---------------------------------------------------------------------------

  private async handleCandidates(candidates: Issue[]): Promise<void> {
    if (this.stopped) return;

    // 만료된 recentlyMerged 항목 정리
    const ttl = this.trackerConfig.poll_interval_ms * 2;
    const now = Date.now();
    for (const [id, ts] of this.recentlyMerged) {
      if (now - ts > ttl) this.recentlyMerged.delete(id);
    }

    this.pruneStaleAgents();

    if (candidates.length > 0 || this.running.size > 0) {
      logger.debug(
        `Poll: found ${candidates.length} candidate issue(s) for tracker ${trackerLabel(this.trackerConfig)} (${this.running.size} running)`,
      );
    }

    // 실행 중 에이전트 조정 — 더 이상 활성 상태가 아닌 이슈 제거
    await this.reconcileRunning(candidates);

    // 새 이슈 디스패치 (글로벌 동시 실행 제한)
    const available = this.limiter.available();

    if (available <= 0) {
      logger.debug(`At global concurrency limit; skipping dispatch`);
      return;
    }

    const toDispatch = candidates
      .filter((issue) => !this.running.has(issue.id))
      .filter((issue) => !this.isBlocked(issue, candidates))
      .filter((issue) => !WAITING_PHASES.has(this.issuePhases.get(issue.identifier) as IssuePhase))
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      .slice(0, available);

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
  private resolveRepository(issue: Issue): RepositoryConfig | undefined {
    const repos = this.trackerConfig.repositories ?? [];
    if (repos.length === 0) return this.trackerConfig.repository;

    // 1. 이슈 레이블로 매칭
    const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
    const matched = repos.find((r) =>
      r.issue_labels.length > 0 && r.issue_labels.some((l) => issueLabels.has(l.toLowerCase())),
    );
    if (matched) return matched;

    // 2. 폴백: 기본 레포
    const defaultRepo = repos.find((r) => r.default);
    if (defaultRepo) return defaultRepo;

    // 3. 폴백: 첫 번째 레포
    return repos[0];
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
    opts: { prLabels?: string[]; reason?: DispatchReason; retryCount?: number; resumeMessage?: string } = {},
  ): void {
    if (this.stopped) return;
    if (this.running.has(issue.id)) {
      logger.debug(`Issue ${issue.identifier} already running; skipping dispatch`);
      return;
    }

    const { prLabels, reason = 'new_issue', retryCount = 0, resumeMessage } = opts;

    // 첫 디스패치 시 phase 초기화 (recovery/retry 포함)
    if (!this.issuePhases.has(issue.identifier)) {
      this.setPhase(issue.identifier, 'initial');
    }
    const acquiredSlot = this.limiter.tryAcquire();
    if (!acquiredSlot) {
      logger.info(`Global concurrency limit reached; skipping dispatch for ${issue.identifier}`);
      return;
    }
    const agents = this.selectAgents(issue, prLabels);

    if (agents.length === 0) {
      logger.info(`No matching agents for ${issue.identifier}; skipping dispatch`);
      if (acquiredSlot) this.limiter.release();
      return;
    }

    // phase에 따른 모델 결정
    const model = this.resolveModel(agents, issue.identifier);

    logger.debug(
      `Dispatching issue ${issue.identifier} to ${agents.map((a) => a.kind).join(', ')} agent(s)` +
        (model ? ` model=${model}` : ''),
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
      acquiredSlot,
    };

    // 선택된 에이전트 설정에서 개발자별 Claude 인증 디렉터리 가져오기
    const claudeAuthDir = agents.find((a): a is ClaudeAgentConfig => a.kind === 'claude')?.claude_auth_dir;

    // 이전 실행의 잔존 파일 방지 — 에이전트가 새로 쓴 것만 감지되도록 클리어
    const ref = this.io.refForIssue(issue);

    const promise = logContext.run({ identifier: issue.identifier }, async () => {
      await Promise.all([
        this.io.writeFile(ref, '.symphony/pending_plan.md', ''),
        this.io.writeFile(ref, '.symphony/pending_review.md', ''),
      ]).catch(() => {});
      return runIssue(issue, this.tracker, this.config, this.promptTemplate, agents, {
      trackerKind: this.trackerConfig.kind,
      repositoryKind: this.resolveRepository(issue)?.kind,
      repository: this.resolveRepository(issue),
      activeStates: this.trackerConfig.active_states,
      states: this.trackerConfig.states,

      signal: abortController.signal,
      reason,
      resumeMessage,
      model,
      claudeAuthDir,
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
        ? `🔄 *[${issue.identifier}]* 재시도합니다. (${retryCount}회)`
        : `🔄 *[${issue.identifier}]* 복구 디스패치 — 작업을 재개합니다.`;
      // workspaceName 전달: 기존 스레드가 없을 경우 SlackChannel이 새 스레드를 등록함
      const workspaceName = this.io.nameForIssue(issue);
      void this.humanChannel.sendNotification(issue, text, workspaceName).catch((err) => {
        logger.warn(`Failed to send ${reason} notification for ${issue.identifier}`, { error: String(err) });
      });
    }

    const fullChain = promise
      .then(async () => {
        logger.info(`Agent completed for ${issue.identifier}`);
        // 리미터 슬롯은 일찍 해제하되, running 맵에서는 포스트프로세싱 완료 후 제거
        // (리뷰 실행 중 트래커 폴러가 같은 이슈를 재디스패치하는 race condition 방지)
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
        this.trackWatchedIssue(issue);
        this.completedCount++;
        try {
          // phase 기반 포스트프로세싱 — implementing 이후에는 plan/question 재전송 스킵
          const phase = this.issuePhases.get(issue.identifier) ?? 'initial';

          if (phase === 'initial' || phase === 'pr_fixing' || phase === 'review_fixing') {
            // 계획/질문이 있으면 Slack에 보내고 종료 (셀프 리뷰보다 우선)
            const planSent = await this.handlePendingPlan(issue);
            if (planSent) return;

            const questionSent = await this.handleQuestion(issue);
            if (questionSent) return;
          }

          // 셀프리뷰는 새 이슈 첫 구현 완료 시에만 실행 — pr_feedback/review_fix 디스패치는 스킵
          const isPrFixReason = entry.reason === 'pr_feedback' || entry.reason === 'review_fix';
          if ((phase === 'initial' || phase === 'implementing') && !isPrFixReason) {
            const reviewSent = await this.handlePendingReview(issue);
            if (reviewSent) return;
          } else if (phase === 'review_fixing' && !isPrFixReason) {
            // 에이전트가 pending_review.md를 수정했으면 재전송, 새 리뷰 생성은 안 함
            const reviewSent = await this.handlePendingReview(issue, true);
            if (reviewSent) return;
          }
          // phase === 'pr_fixing' 또는 isPrFixReason → handlePendingReview 완전 스킵

          await this.handlePrCreated(issue);
          await this.notifyWorkComplete(issue);
          await this.clearPrFeedback(issue);
          if (!this.recentlyMerged.has(issue.identifier)) {
            this.drainCommentQueue(issue.identifier);
          }
          await this.cleanupTerminalWorkspace(issue);
        } catch (err) {
          logger.error(`Post-processing failed for ${issue.identifier}`, { error: String(err) });
        } finally {
          this.running.delete(issue.id);
          this.closeAgentLogStream(issue.identifier);
        }
        this.emit('agent:completed', issue);
      })
      .catch(async (err: unknown) => {
        logger.error(`Agent failed for ${issue.identifier}`, { error: String(err) });
        this.running.delete(issue.id);
        this.closeAgentLogStream(issue.identifier);
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
        this.trackWatchedIssue(issue);

        // 최근 머지된 경우 재시도/드레인 건너뜀
        if (this.recentlyMerged.has(issue.identifier)) {
          this.clearPhase(issue.identifier);
          this.failedCount++;
          this.emit('agent:failed', issue, err);
          return;
        }

        // 이슈가 여전히 활성 상태이고 재시도 횟수가 남은 경우 자동 재시도
        const maxRetries = this.config.agents.max_retries;
        if (retryCount < maxRetries) {
          try {
            const [refreshed] = await this.tracker.fetchIssuesByIds([issue.id]);
            if (refreshed) {
              const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());
              if (activeNorm.includes(refreshed.state.toLowerCase().trim())) {
                const delayMs = this.config.agents.retry_backoff_ms * Math.pow(2, retryCount);
                logger.info(`Retrying ${issue.identifier} in ${delayMs}ms (retry ${retryCount + 1}/${maxRetries})`);
                const timer = setTimeout(() => {
                  this.retryTimers.delete(timer);
                  if (this.stopped) return;
                  this.dispatch(refreshed, { reason: 'retry', retryCount: retryCount + 1, resumeMessage: '이전 실행이 실패했습니다. 현재 상태를 확인하고 작업을 이어서 진행하세요.' });
                }, delayMs);
                this.retryTimers.add(timer);
                return;
              }
            }
          } catch (retryErr) {
            logger.warn(`Failed to check issue state for retry: ${issue.identifier}`, { error: String(retryErr) });
          }
        }

        this.clearPhase(issue.identifier);
        this.failedCount++;
        this.drainCommentQueue(issue.identifier);
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
          pruned++;
        } else if (terminalNorm.has(issue.state.toLowerCase().trim())) {
          logger.info(`pruneStaleThreads: ${id} in terminal state "${issue.state}"; removing thread`);
          this.humanChannel!.forgetThread(id);
          this.clearPhase(id);
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
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
        this.failedCount++;
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
      await this.humanChannel.sendNotification(issue, `:white_check_mark: *${issue.identifier}* 작업 완료`).catch((err) => {
        logger.warn(`Failed to send completion notification for ${issue.identifier}`, { error: String(err) });
      });
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

    try {
      const backend = createWorkspaceBackend(this.config, this.resolveRepository(latest ?? issue));
      const ref = this.io.refForIssue(issue);
      await backend.cleanup(ref, latest);
    } catch (err) {
      logger.warn('Workspace cleanup failed', { issue: issue.identifier, error: String(err) });
    }
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
      logger.error('HumanChannel failed to start', { error: String(err) });
    });
  }

  private async notifyPlanStart(issue: Issue): Promise<void> {
    if (!this.humanChannel) return;

    const text = `📋 *[${issue.identifier}]* 의 계획을 작성합니다.`;
    const workspaceName = this.io.nameForIssue(issue);
    await this.humanChannel.sendNotification(issue, text, workspaceName).catch((err) => {
      logger.warn(`Failed to notify plan start for ${issue.identifier}`, { error: String(err) });
    });
  }

  private async handlePrCreated(issue: Issue): Promise<void> {
    if (!this.humanChannel) return;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return;

    const raw = await this.io.readFile(ref, '.symphony/pr_created.json');
    if (!raw || raw.trim() === '') return;

    try {
      const data = JSON.parse(raw) as { pr_url?: string; pr_number?: number; base_commit?: string };
      if (!data.pr_url) return;

      // PR diff를 Slack 스레드로 전송 (Slack 설정 + DiffSender 있을 때)
      if (this.diffSender) {
        const threadInfo = this.humanChannel.getThreadInfo(issue.identifier);
        if (threadInfo) {
          try {
            const rawDiff = await this.io.getDiff(ref, data.base_commit);
            if (rawDiff && rawDiff.trim()) {
              const files = parseDiffToFiles(rawDiff)
                .filter(f => !/(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f.path));
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
      }

      // PR URL 알림 (diff 전송 완료 후)
      await this.humanChannel.sendNotification(issue, `🔗 *[${issue.identifier}]* PR이 생성되었습니다: ${data.pr_url}`);
    } catch (err) {
      logger.warn(`Failed to parse pr_created.json for ${issue.identifier}`, { error: String(err) });
    }

    // PR 생성 시 in_review로 전환 (이미 in_review면 no-op)
    try {
      await this.tracker.transitionIssue(issue.id, this.trackerConfig.states.in_review);
      logger.info(`Transitioned ${issue.identifier} to ${this.trackerConfig.states.in_review} after PR created`);
    } catch (err) {
      logger.warn(`Failed to transition ${issue.identifier} to in_review`, { error: String(err) });
    }

    // PR이 올라간 이후의 Slack 메시지는 PR 피드백으로 라우팅
    this.setPhase(issue.identifier, 'pr_fixing');

    // 재전송 방지
    try { await this.io.writeFile(ref, '.symphony/pr_created.json', ''); } catch { /* non-fatal */ }
  }

  private async notifyWorkComplete(issue: Issue): Promise<void> {
    if (!this.humanChannel) return;

    const planNumber = this.humanChannel.getPlanNumber(issue.identifier);
    const text = planNumber > 0
      ? `✅ *[${issue.identifier}]* 계획 #${planNumber} 작업 완료`
      : `✅ *[${issue.identifier}]* 작업 완료`;
    await this.humanChannel.sendNotification(issue, text).catch((err) => {
      logger.warn(`Failed to notify work complete for ${issue.identifier}`, { error: String(err) });
    });
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
        const rawResults = await this.runReviewRounds(ref);
        await this.consolidateReviewViaContinue(ref, rawResults);

        // 에이전트가 pending_review.md를 작성했는지 확인
        const consolidated = await this.io.readFile(ref, '.symphony/pending_review.md');
        if (!consolidated?.trim()) {
          logger.warn(`Review consolidation did not produce pending_review.md for ${issue.identifier}`);
          // 폴백: raw 결과를 직접 사용
          await this.io.writeFile(ref, '.symphony/pending_review.md', rawResults);
        }
        reviewText = (await this.io.readFile(ref, '.symphony/pending_review.md'))?.trim() ?? undefined;
      } catch (err) {
        logger.error(`Self-review failed for ${issue.identifier}`, { error: String(err) });
        return false;
      }
    }

    if (!reviewText) return false;

    const wsName = this.io.nameForIssue(issue);
    const sent = await this.humanChannel.sendForApproval(issue, reviewText, 'review', wsName);
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
  private async runReviewRounds(ref: WorkspaceRef): Promise<string> {
    const reviewConfig = this.config.agents.review;
    if (!reviewConfig) throw new Error('Self-review requires agents.review config');
    const { kinds: agents, rounds } = reviewConfig;

    logger.info(`Starting self-review: agents=[${agents.join(', ')}] rounds=${rounds}`);

    const perAgentResults = await Promise.all(
      agents.map((kind) => this.runAgentReviewRounds(ref, kind, rounds)),
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
  private async consolidateReviewViaContinue(ref: WorkspaceRef, rawResults: string): Promise<void> {
    const mainAgentKind = (this.config.agents.backends.find((a) => a.primary) ?? this.config.agents.backends[0]).kind;
    const prompt = `셀프리뷰 라운드가 완료되었습니다. WORKFLOW의 "Consolidation rules"에 따라 아래 결과를 통합하고 pending_review.md에 작성하세요.\n\n${rawResults}`;

    await this.spawnReviewCLI(ref, mainAgentKind, prompt, { continue: true });
  }

  /** 한 에이전트를 `rounds`번의 직렬 리뷰 라운드로 실행하고 결과를 수집한다. */
  private async runAgentReviewRounds(ref: WorkspaceRef, kind: string, rounds: number): Promise<string[]> {
    const results: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      logger.info(`Review ${kind} round ${round}/${rounds}`);
      try {
        const prompt = this.buildReviewPrompt(round, rounds, results);
        const result = await this.spawnReviewCLI(ref, kind, prompt);
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
  private spawnReviewCLI(ref: WorkspaceRef, kind: string, prompt: string, opts?: { continue?: boolean }): Promise<string> {
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
      logger.debug(`handlePendingPlan: pending_plan.md is empty or missing`, { issue: issue.identifier });
      return false;
    }

    logger.info(`handlePendingPlan: sending plan to channel`, { issue: issue.identifier, planLength: plan.length });

    // Race condition 방지: plan 전송 중 응답 처리 차단
    this.pendingDispatch.add(issue.identifier);
    try {
      const wsName = this.io.nameForIssue(issue);
      const sent = await this.humanChannel.sendForApproval(issue, plan, 'plan', wsName);
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
      const sent = await this.humanChannel.sendForApproval(issue, question, 'question', wsName);
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
            ? `✅ *[${identifier}]* 리뷰가 승인되었습니다. 처리합니다.`
            : `🚀 *[${identifier}]* 계획 #${planNumber} 작업을 시작합니다.`;
        } else {
          msgText = `💬 *[${identifier}]* 응답을 처리합니다.`;
        }
        const wsName = this.io.nameForIssue(issue);
        await this.humanChannel.sendNotification(issue, msgText, wsName).catch((err) => {
          logger.warn(`Failed to send response notification for ${identifier}`, { error: String(err) });
        });
      }

      // 메시지 구성: ✅ 리액션 그대로 전달 (에이전트가 ✅ 존재 여부로 구현 여부 판단)
      // 비승인 메시지에는 방어 prefix 추가 — 에이전트가 텍스트 내용에 현혹되어 구현하는 것 방지
      const resumeMessage = event.isApproval
        ? '✅'
        : `⚠️ FEEDBACK (NOT APPROVAL — do NOT implement):\n${event.responseText}`;

      // reason 결정
      const finalPhase = this.issuePhases.get(identifier) ?? 'initial';
      const reason: DispatchReason =
        (finalPhase === 'review_fixing' && event.isApproval) ? 'review_fix'
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
      `💬 *[${identifier}]* Slack PR 피드백이 도착했습니다. 처리를 시작합니다.`,
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
      await this.humanChannel?.sendNotification(issue, `💬 *[${identifier}]* PR 댓글이 도착했습니다. 처리를 시작합니다.`).catch((err) => {
        logger.warn(`Failed to notify PR comment arrival for ${identifier}`, { error: String(err) });
      });

      const ref = this.io.refForIssue(issue);
      if (await this.io.exists(ref)) {
        await this.writePrFeedback(ref, comments);
      }

      this.setPhase(identifier, 'pr_fixing');
      this.dispatch(issue, {
        prLabels,
        reason: 'pr_feedback',
        resumeMessage: 'PR 피드백이 도착했습니다. .symphony/pr_feedback.json을 읽고 처리하세요.',
      });
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
      // Running agent가 있으면 abort
      for (const [id, entry] of this.running) {
        if (entry.issue.identifier === identifier) {
          logger.info(`Aborting running agent for ${identifier} due to PR merge`);
          entry.abortController.abort();
          this.running.delete(id);
          if (entry.acquiredSlot) {
            this.limiter.release();
            entry.acquiredSlot = false;
          }
          break;
        }
      }

      this.recentlyMerged.set(identifier, Date.now());

      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      // 1. 이슈를 terminal 상태로 전환
      const terminalState = this.trackerConfig.terminal_states[0];
      if (terminalState) {
        try {
          await this.tracker.transitionIssue(issue.id, terminalState);
          logger.info(`Transitioned ${identifier} to ${terminalState} after PR merge`);
        } catch (err) {
          logger.warn(`Failed to transition ${identifier} to ${terminalState}`, { error: String(err) });
        }
      }

      // 2. 피처 브랜치 삭제 (모든 폴러 시도 — 적합한 것이 매칭됨)
      if (this.repoPollers.size > 0 && pr.branchName) {
        for (const poller of this.repoPollers.values()) {
          try {
            await poller.deleteBranch(pr.branchName);
            logger.info(`Deleted branch ${pr.branchName} after PR merge`);
            break; // 하나의 폴러에서 성공하면 충분
          } catch {
            // 이 레포에 브랜치가 없을 수 있음, 다음 시도
          }
        }
      }

      // 3. Notification + 레코드 완전 삭제
      if (this.humanChannel && issue) {
        await this.humanChannel.sendNotification(issue, `:merged: *${identifier}* PR이 머지되어 작업이 완료되었습니다.`).catch((err) => {
          logger.warn(`Failed to send merge notification for ${identifier}`, { error: String(err) });
        });
        this.humanChannel.forgetThread(identifier);
      }

      // 4. 큐 정리
      this.queuedComments.delete(identifier);
      this.clearPhase(identifier);

      // 5. 워크스페이스 정리
      await this.cleanupTerminalWorkspace(issue);
    } catch (err) {
      logger.error(`handlePRMerged failed for ${identifier}`, { error: String(err) });
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
    logger.info(
      `Queued ${comments.length} PR comment(s) for ${identifier} (total queued: ${this.queuedComments.get(identifier)!.comments.length})`,
    );
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
    let existingBaseCommit: string | null = null;
    try {
      const raw = await this.io.readFile(ref, '.symphony/pr_feedback.json');
      if (raw) {
        const parsed = JSON.parse(raw);
        existingEntries = Array.isArray(parsed.comments) ? parsed.comments : [];
        existingBaseCommit = parsed.base_commit ?? null;
      }
    } catch { /* no existing file */ }

    const existingIds = new Set(existingEntries.map((e) => e.id));
    const deduped = newComments.filter((c) => !existingIds.has(c.id));

    const allEntries = [...existingEntries, ...this.serializeComments(deduped)];

    // base_commit은 세션 최초 기록 시점의 값을 유지 (덮어쓰지 않음)
    const base_commit = existingBaseCommit ?? await this.io.getCommitHash(ref).catch(() => null);

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
