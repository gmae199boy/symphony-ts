/**
 * Orchestrator — main polling and dispatch loop.
 * Mirrors elixir/lib/symphony_elixir/orchestrator.ex
 *
 * One Orchestrator instance manages one TrackerConfig (with its optional
 * repository integration).  Multiple orchestrators can run in parallel for
 * multi-tracker setups (managed by index.ts).
 *
 * Responsibilities:
 *  - Poll the tracker for candidate issues
 *  - Select which agents to run for each issue (trigger matching)
 *  - Dispatch issues to agent runners (respecting concurrency limits)
 *  - Track running/completed/failed agents
 *  - Handle repository PR events (approved → terminal, changes_requested →
 *    reschedule, new_comments → reschedule with pr_feedback.json)
 *  - Detect stalled agents and clean up
 */

import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { runIssue } from './agent-runner.js';
import { RepoPoller } from './repository/poller.js';
import { LinearClient } from './tracker/linear.js';
import { JiraClient } from './tracker/jira.js';
import { DockerWorkspaceBackend } from './workspace/docker.js';
import { LocalWorkspaceBackend } from './workspace/local.js';
import { createWorkspaceIO } from './workspace/io.js';
import { SlackPoller, type SlackResponseEvent } from './slack/poller.js';
import { sendSlackMessage, sendSlackMessageChunked } from './slack/notifier.js';
import { ReviewOrchestrator } from './review/orchestrator.js';
import { formatReviewMessage, buildAgentSummary } from './review/formatter.js';
import { CostTracker } from './cost-tracker.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import type { Issue, TrackerClient, RepoEvent, AgentMessage, Comment, WorkspaceRef, WorkspaceIO } from './types.js';
import type { Config, TrackerConfig, AgentConfig } from './config/schema.js';

export interface RunningEntry {
  issue: Issue;
  promise: Promise<void>;
  startedAt: Date;
  workerHost: string | null;
  workspacePath: string | null;
  containerName: string | null;
  agentLogLines: string[];
  /** true = dispatched from a repo event; exempt from reconcileRunning */
  fromRepoEvent: boolean;
  abortController: AbortController;
  retryCount: number;
  /** true if this entry consumed a concurrency limiter slot (release on completion) */
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
const STALE_AGENT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

export class Orchestrator extends EventEmitter {
  private readonly config: Config;
  private readonly trackerConfig: TrackerConfig;
  private readonly tracker: TrackerClient;
  private readonly promptTemplate: string;

  private running = new Map<string, RunningEntry>(); // issue.id → entry
  private pendingDispatch = new Set<string>(); // identifier → resolving/dispatching
  private watchedIssues = new Map<string, Issue>(); // identifier → last-known Issue
  private queuedComments = new Map<string, { comments: Comment[]; prLabels: string[] }>(); // identifier → queued PR comments
  private queuedReviewEvent = new Map<string, { kind: 'review_approved' | 'changes_requested'; prLabels: string[] }>(); // identifier → latest queued review
  private completedCount = 0;
  private failedCount = 0;
  private repoEvents: RepoEventRecord[] = [];

  private pollTimer: NodeJS.Timeout | null = null;
  private repoPoller: RepoPoller | null = null;
  private slackPoller: SlackPoller | null = null;
  private readonly limiter: ConcurrencyLimiter;
  private readonly io: WorkspaceIO;
  private costTracker: CostTracker;
  private stopped = false;

  constructor(config: Config, trackerConfig: TrackerConfig, promptTemplate: string, limiter: ConcurrencyLimiter) {
    super();
    this.config = config;
    this.trackerConfig = trackerConfig;
    this.promptTemplate = promptTemplate;
    this.tracker = createTrackerClient(trackerConfig);
    this.limiter = limiter;
    this.io = createWorkspaceIO(config);
    this.costTracker = new CostTracker(config.workspace.root);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    logger.info(`Orchestrator starting for tracker kind=${this.trackerConfig.kind}`);
    void this.recoverFromWorkspaces();
    this.schedulePoll(0);
    this.startRepoPoller();
    this.startSlackPoller();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.repoPoller?.stop();
    this.slackPoller?.stop();
    for (const entry of this.running.values()) {
      entry.abortController.abort();
      if (entry.acquiredSlot) {
        this.limiter.release();
        entry.acquiredSlot = false;
      }
    }
    this.running.clear();
    logger.info('Orchestrator stopped');
  }

  async stopAndWait(gracePeriodMs: number): Promise<void> {
    // Collect promises before stop() aborts them (abort causes settle → delete)
    const agentPromises = [...this.running.values()].map((e) => e.promise);
    this.stop();

    if (agentPromises.length === 0) return;

    logger.info(`Waiting for ${agentPromises.length} agent(s) to finish (grace=${gracePeriodMs}ms)`);

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs));
    await Promise.race([Promise.allSettled(agentPromises), timeout]);
  }

  /**
   * On startup, discover existing workspaces and re-dispatch
   * issues that are still in active states.
   */
  private async recoverFromWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.io.list();
      if (workspaces.length === 0) return;

      logger.info(`Recovery: found ${workspaces.length} existing workspace(s)`);

      for (const ws of workspaces) {
        const identifier = ws.identifier;
        if (!identifier) continue;

        try {
          const issue = await this.tracker.fetchIssueByIdentifier(identifier);
          if (!issue) {
            logger.info(`Recovery: ${identifier} not found in tracker; skipping`);
            continue;
          }

          const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());
          if (!activeNorm.includes(issue.state.toLowerCase().trim())) {
            logger.info(`Recovery: ${identifier} in state "${issue.state}" (not active); skipping`);
            continue;
          }

          if (this.running.has(issue.id)) continue;

          logger.info(`Recovery: re-dispatching ${identifier} (state="${issue.state}")`);
          this.dispatch(issue);
        } catch (err) {
          logger.warn(`Recovery: failed to process workspace ${ws.name}`, { error: String(err) });
        }
      }
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
  // Polling
  // ---------------------------------------------------------------------------

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.doPoll();
    } catch (err) {
      logger.error('Orchestrator poll failed', { error: String(err) });
    } finally {
      this.schedulePoll(this.trackerConfig.poll_interval_ms);
    }
  }

  private async doPoll(): Promise<void> {
    this.pruneStaleAgents();

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logger.error('Failed to fetch candidate issues', { error: String(err) });
      return;
    }

    logger.info(
      `Poll: found ${candidates.length} candidate issue(s) for tracker ${trackerLabel(this.trackerConfig)} (${this.running.size} running)`,
    );

    // Reconcile running agents — remove issues that are no longer active
    await this.reconcileRunning(candidates);

    // Dispatch new issues (global concurrency limit)
    const available = this.limiter.available();

    if (available <= 0) {
      logger.info(`At global concurrency limit; skipping dispatch`);
      return;
    }

    const toDispatch = candidates
      .filter((issue) => !this.running.has(issue.id))
      .filter((issue) => !this.isBlocked(issue, candidates))
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      .slice(0, available);

    for (const issue of toDispatch) {
      this.dispatch(issue);
    }
  }

  // ---------------------------------------------------------------------------
  // Running lookup helpers
  // ---------------------------------------------------------------------------

  /** Check if an agent is running for the given Linear identifier (e.g. "TES-7").
   *  The running map is keyed by internal UUID, so we scan by identifier. */
  private isRunningByIdentifier(identifier: string): boolean {
    for (const entry of this.running.values()) {
      if (entry.issue.identifier === identifier) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Agent selection
  // ---------------------------------------------------------------------------

  /**
   * Returns the subset of configured agents that should run for the given issue.
   *
   * Trigger semantics (per agent):
   *  - No trigger: always run.
   *  - trigger.issue_labels (non-empty): issue must have at least one matching label.
   *  - trigger.pr_labels (non-empty): only checked when prLabels context is provided;
   *    PR must have at least one matching label.
   *  All specified+applicable conditions must pass (AND).
   */
  private selectAgents(issue: Issue, prLabels?: string[]): AgentConfig[] {
    return this.config.agents.filter((agent) => {
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

      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // watchedIssues helpers
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
  // Dispatch
  // ---------------------------------------------------------------------------

  private dispatch(
    issue: Issue,
    opts: { prLabels?: string[]; fromRepoEvent?: boolean; retryCount?: number } = {},
  ): void {
    if (this.stopped) return;
    if (this.running.has(issue.id)) {
      logger.info(`Issue ${issue.identifier} already running; skipping dispatch`);
      return;
    }

    const { prLabels, fromRepoEvent = false, retryCount = 0 } = opts;
    const acquiredSlot = this.limiter.tryAcquire();
    if (!acquiredSlot && !fromRepoEvent) {
      logger.info(`Global concurrency limit reached; skipping dispatch for ${issue.identifier}`);
      return;
    }
    const agents = this.selectAgents(issue, prLabels);

    if (agents.length === 0) {
      logger.info(`No matching agents for ${issue.identifier}; skipping dispatch`);
      if (acquiredSlot) this.limiter.release();
      return;
    }

    logger.info(
      `Dispatching issue ${issue.identifier} to ${agents.map((a) => a.kind).join(', ')} agent(s)`,
    );

    const abortController = new AbortController();

    const entry: RunningEntry = {
      issue,
      promise: Promise.resolve(), // filled below
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      containerName: null,
      agentLogLines: [],
      fromRepoEvent,
      abortController,
      retryCount,
      acquiredSlot,
    };

    const promise = runIssue(issue, this.tracker, this.config, this.promptTemplate, agents, {
      trackerKind: this.trackerConfig.kind,
      repositoryKind: this.trackerConfig.repository?.kind,
      activeStates: this.trackerConfig.active_states,
      signal: abortController.signal,
      onMessage: (msg: AgentMessage) => this.handleAgentMessage(issue.id, msg),
      onTurnComplete: (info) => {
        this.costTracker.record(issue.identifier, info.cost, info.tokensTotal);
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

    this.running.set(issue.id, entry);

    // 처음 폴링된 이슈 → Slack 스레드 생성 (이후 계획이 같은 스레드에 올라감)
    // 복구 디스패치(컨테이너가 이미 존재)에서는 보내지 않음
    if (!fromRepoEvent && this.slackPoller && this.config.slack && !this.slackPoller.isWatching(issue.identifier)) {
      const ref = this.io.refForIssue(issue);
      void this.io.exists(ref).then((exists) => {
        if (!exists) return this.notifyPlanStart(issue);
      }).catch((err) => {
        logger.warn(`Failed to check workspace/notify plan start for ${issue.identifier}`, { error: String(err) });
      });
    }

    const fullChain = promise
      .then(async () => {
        logger.info(`Agent completed for ${issue.identifier}`);
        this.running.delete(issue.id);
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
        this.trackWatchedIssue(issue);
        this.completedCount++;
        try {
          const reviewSent = await this.handlePendingReview(issue);
          if (reviewSent) return;

          const planSent = await this.handlePendingPlan(issue);
          const questionSent = !planSent && await this.handleQuestion(issue);
          if (!planSent && !questionSent) {
            await this.notifyWorkComplete(issue);
          }
          await this.clearPrFeedback(issue);
          this.drainCommentQueue(issue.identifier);
          this.drainReviewQueue(issue.identifier);
          await this.cleanupTerminalWorkspace(issue);
        } catch (err) {
          logger.error(`Post-processing failed for ${issue.identifier}`, { error: String(err) });
        }
        this.emit('agent:completed', issue);
      })
      .catch(async (err: unknown) => {
        logger.error(`Agent failed for ${issue.identifier}`, { error: String(err) });
        this.running.delete(issue.id);
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
        this.trackWatchedIssue(issue);

        // Auto-retry if issue is still active and retries remain
        const maxRetries = this.config.agent.max_retries ?? 2;
        if (retryCount < maxRetries) {
          try {
            const [refreshed] = await this.tracker.fetchIssuesByIds([issue.id]);
            if (refreshed) {
              const activeNorm = this.trackerConfig.active_states.map((s) => s.toLowerCase().trim());
              if (activeNorm.includes(refreshed.state.toLowerCase().trim())) {
                const delayMs = this.config.agent.retry_backoff_ms * Math.pow(2, retryCount);
                logger.info(`Retrying ${issue.identifier} in ${delayMs}ms (retry ${retryCount + 1}/${maxRetries})`);
                setTimeout(() => {
                  this.dispatch(refreshed, { fromRepoEvent, retryCount: retryCount + 1 });
                }, delayMs);
                return;
              }
            }
          } catch (retryErr) {
            logger.warn(`Failed to check issue state for retry: ${issue.identifier}`, { error: String(retryErr) });
          }
        }

        this.failedCount++;
        this.drainCommentQueue(issue.identifier);
        this.drainReviewQueue(issue.identifier);
        this.emit('agent:failed', issue, err);
      });

    entry.promise = fullChain;
  }

  private handleAgentMessage(issueId: string, msg: AgentMessage): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    if (msg.event.type === 'output') {
      const line = msg.event.line;
      entry.agentLogLines.push(line);
      // Keep last 200 lines
      if (entry.agentLogLines.length > 200) entry.agentLogLines.shift();
    }

    this.emit('agent:message', issueId, msg);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  private async reconcileRunning(candidates: Issue[]): Promise<void> {
    const candidateIds = new Set(candidates.map((i) => i.id));
    const terminalIds = [...this.running.entries()]
      .filter(([id, entry]) => !candidateIds.has(id) && !entry.fromRepoEvent)
      .map(([id]) => id);

    for (const id of terminalIds) {
      const entry = this.running.get(id);
      if (entry) {
        logger.info(`Issue ${entry.issue.identifier} left active states; aborting and removing from running`);
        entry.abortController.abort();
        this.running.delete(id);
        if (entry.acquiredSlot) {
          this.limiter.release();
          entry.acquiredSlot = false;
        }
      }
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
      // Blocked if blocker is still active (not terminal and still in candidate list)
      return activeIds.has(blocker.id) || (state && !terminalStates.has(state));
    });
  }

  // ---------------------------------------------------------------------------
  // Stale agent cleanup
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
  // Workspace cleanup
  // ---------------------------------------------------------------------------

  private async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    const terminalStates = new Set(this.trackerConfig.terminal_states.map((s) => s.toLowerCase().trim()));

    // Re-fetch latest state
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

    // Slack 완료 알림 + unwatch (terminal에서만)
    if (this.slackPoller?.isWatching(issue.identifier) && this.config.slack) {
      const thread = this.slackPoller.getThread(issue.identifier);
      if (thread) {
        void sendSlackMessage(
          this.config.slack.bot_token,
          thread.threadInfo.channel,
          `:white_check_mark: *${issue.identifier}* 작업 완료`,
          thread.threadInfo.thread_ts,
        );
      }
      this.slackPoller.unwatch(issue.identifier);
    }

    // 비용 댓글 작성
    const costData = this.costTracker.getIssue(issue.identifier);
    if (costData) {
      const comment = `[Agent Summary] Cost: $${costData.costUsd.toFixed(4)} | Tokens: ${costData.tokens.toLocaleString()} | Turns: ${costData.turns}`;
      try {
        await this.tracker.createComment(issue.id, comment);
      } catch (err) {
        logger.warn(`Failed to write cost comment for ${issue.identifier}`, { error: String(err) });
      }
    }

    logger.info(`Issue ${issue.identifier} reached terminal state; cleaning up workspace`);

    try {
      const backend = this.config.workspace_backend === 'docker'
        ? new DockerWorkspaceBackend(this.config)
        : new LocalWorkspaceBackend(this.config);

      const ref = this.io.refForIssue(issue);
      await backend.cleanup(ref, latest);
    } catch (err) {
      logger.warn('Workspace cleanup failed', { issue: issue.identifier, error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Slack plan-approval workflow
  // ---------------------------------------------------------------------------

  private startSlackPoller(): void {
    if (!this.config.slack) return;

    this.slackPoller = new SlackPoller(this.config.slack, this.config.workspace.root, (event) => {
      void this.handleSlackResponse(event);
    });
    this.slackPoller.start().catch((err) => {
      logger.error('Slack poller failed to start', { error: String(err) });
    });
  }

  private async notifyPlanStart(issue: Issue): Promise<void> {
    if (!this.slackPoller || !this.config.slack) return;

    const text = `📋 *[${issue.identifier}]* 의 계획을 작성합니다.`;
    const result = await sendSlackMessage(
      this.config.slack.bot_token,
      this.config.slack.channel,
      text,
    );
    if (!result) return;

    const wsName = this.io.nameForIssue(issue);
    this.slackPoller.watch(issue.identifier, issue.id, wsName, {
      channel: result.channel,
      thread_ts: result.ts,
      message_ts: result.ts,
    });
  }

  private async notifyWorkComplete(issue: Issue): Promise<void> {
    if (!this.slackPoller || !this.config.slack) return;

    const thread = this.slackPoller.getThread(issue.identifier);
    if (!thread) return;

    const planNumber = thread.planNumber;
    if (planNumber === 0) return; // 계획이 전송된 적 없으면 skip

    const text = `✅ *[${issue.identifier}]* 계획 #${planNumber} 작업 완료`;
    const result = await sendSlackMessage(
      this.config.slack.bot_token,
      thread.threadInfo.channel,
      text,
      thread.threadInfo.thread_ts,
    );
    if (result) {
      this.slackPoller.updateLastReadTs(issue.identifier, result.ts);
    }
  }

  // ---------------------------------------------------------------------------
  // Self-review handling
  // ---------------------------------------------------------------------------

  /**
   * Returns true if a review result was sent to Slack (waiting for user response).
   *
   * Two paths:
   *  1. pending_review.md already exists → agent already wrote it, just send to Slack.
   *  2. pending_review.md does not exist + review.enabled → run ReviewOrchestrator,
   *     write pending_review.md + review_findings.json, then send to Slack.
   */
  private async handlePendingReview(issue: Issue): Promise<boolean> {
    if (!this.slackPoller || !this.config.slack) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    // Check if pending_review.md already exists (written by agent after feedback loop)
    let reviewText: string | undefined;
    try {
      const existing = await this.io.readFile(ref, '.symphony/pending_review.md');
      if (existing?.trim()) reviewText = existing;
    } catch { /* file does not exist */ }

    // If no existing review, run ReviewOrchestrator
    if (!reviewText) {
      try {
        const diff = await this.io.getDiff(ref);
        if (!diff?.trim()) return false;

        const reviewOrch = new ReviewOrchestrator(ref);
        const findings = await reviewOrch.run(diff, this.config.review, this.config.agents);

        if (findings.length === 0) {
          logger.info(`Self-review found no issues for ${issue.identifier}`);
          return false;
        }

        // Write artifacts
        await this.io.writeFile(
          ref,
          '.symphony/review_findings.json',
          JSON.stringify(findings, null, 2),
        );

        const agentSummary = buildAgentSummary(
          this.config.review.agents,
          this.config.review.rounds,
          this.config.review.validator,
        );
        reviewText = formatReviewMessage(findings, agentSummary);

        await this.io.writeFile(ref, '.symphony/pending_review.md', reviewText);
      } catch (err) {
        logger.error(`Self-review failed for ${issue.identifier}`, { error: String(err) });
        return false;
      }
    }

    if (!reviewText) return false;

    // Send to Slack
    const watched = this.slackPoller.getThread(issue.identifier);
    const threadTs = watched?.threadInfo.thread_ts;
    const wsName = this.io.nameForIssue(issue);
    const result = await sendSlackMessageChunked(
      this.config.slack.bot_token,
      this.config.slack.channel,
      reviewText,
      threadTs ?? undefined,
      (ts) => this.slackPoller?.updateLastReadTs(issue.identifier, ts),
    );

    if (result && !threadTs) {
      // First message in thread — start watching
      this.slackPoller.watch(issue.identifier, issue.id, wsName, {
        channel: result.channel,
        thread_ts: result.ts,
        message_ts: result.ts,
      });
    }

    logger.info(`Self-review results sent to Slack for ${issue.identifier}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Plan handling
  // ---------------------------------------------------------------------------

  /** Returns true if a plan was sent to Slack. */
  private async handlePendingPlan(issue: Issue): Promise<boolean> {
    if (!this.slackPoller || !this.config.slack) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    const plan = await this.io.readFile(ref, '.symphony/pending_plan.md');
    if (!plan || plan.trim() === '') return false;

    // Race condition 방지: plan 전송 중 Slack 응답 처리 차단
    this.pendingDispatch.add(issue.identifier);
    try {
      const existingThread = this.slackPoller.getThread(issue.identifier);
      const wsName = this.io.nameForIssue(issue);
      const planNumber = this.slackPoller.incrementPlanNumber(issue.identifier);
      const text = `📋 *[${issue.identifier}] 계획 #${planNumber}*\n\n${plan}\n\n✅ 승인: 이 메시지에 ✅ 리액션 또는 "승인" 답글, 피드백: 자유롭게 작성`;

      const result = await sendSlackMessage(
        this.config.slack.bot_token,
        existingThread?.threadInfo.channel ?? this.config.slack.channel,
        text,
        existingThread?.threadInfo.thread_ts,
      );
      if (!result) return false;

      if (!existingThread) {
        this.slackPoller.watch(issue.identifier, issue.id, wsName, {
          channel: result.channel,
          thread_ts: result.ts,
          message_ts: result.ts,
        });
      } else {
        this.slackPoller.updateLastReadTs(issue.identifier, result.ts);
      }

      // 계획 메시지에 ✅ 리액션 감시 설정
      this.slackPoller.setPlanMessageTs(issue.identifier, result.ts);

      // pending_plan.md 비우기 (재전송 방지)
      try { await this.io.writeFile(ref, '.symphony/pending_plan.md', ''); } catch { /* non-fatal */ }
      return true;
    } finally {
      this.pendingDispatch.delete(issue.identifier);
    }
  }

  /** Returns true if a question was sent to Slack. */
  private async handleQuestion(issue: Issue): Promise<boolean> {
    if (!this.slackPoller || !this.config.slack) return false;

    const ref = this.io.refForIssue(issue);
    if (!(await this.io.exists(ref))) return false;

    const question = await this.io.readFile(ref, '.symphony/question.md');
    if (!question || question.trim() === '') return false;

    this.pendingDispatch.add(issue.identifier);
    try {
      const thread = this.slackPoller.getThread(issue.identifier);
      const wsName = this.io.nameForIssue(issue);
      const text = `❓ *[${issue.identifier}]* 질문\n\n${question}`;

      const result = await sendSlackMessage(
        this.config.slack.bot_token,
        thread?.threadInfo.channel ?? this.config.slack.channel,
        text,
        thread?.threadInfo.thread_ts,
      );
      if (!result) return false;

      if (thread) {
        this.slackPoller.updateLastReadTs(issue.identifier, result.ts);
      } else {
        this.slackPoller.watch(issue.identifier, issue.id, wsName, {
          channel: result.channel,
          thread_ts: result.ts,
          message_ts: result.ts,
        });
      }

      // question.md 비우기 (재전송 방지)
      try { await this.io.writeFile(ref, '.symphony/question.md', ''); } catch { /* non-fatal */ }
      return true;
    } finally {
      this.pendingDispatch.delete(issue.identifier);
    }
  }

  private async handleSlackResponse(event: SlackResponseEvent): Promise<void> {
    const { issueIdentifier: identifier } = event;

    const ref = this.io.refFromName(event.workspaceName);
    const isRunning = this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier);

    // 워크스페이스가 있으면 응답을 항상 append (에이전트 실행 중이어도)
    if (await this.io.exists(ref)) {
      await this.appendSlackResponse(ref, event.responseText);
    }

    if (isRunning) {
      logger.info(`Slack response for ${identifier}: agent running — appended to slack_response.json, skipping dispatch`);
      return;
    }

    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      if (!(await this.io.exists(ref))) {
        logger.info(`Workspace ${event.workspaceName} not found; dispatching fresh run for ${identifier}`);
        this.dispatch(issue, { fromRepoEvent: true });
        return;
      }

      // ✅ 리액션 승인 시 Slack 스레드에 작업 시작 알림
      if (event.isApproval && this.slackPoller && this.config.slack) {
        const thread = this.slackPoller.getThread(identifier);
        if (thread) {
          const planNumber = thread.planNumber;
          const result = await sendSlackMessage(
            this.config.slack.bot_token,
            thread.threadInfo.channel,
            `🚀 *[${identifier}]* 계획 #${planNumber} 작업을 시작합니다.`,
            thread.threadInfo.thread_ts,
          );
          if (result) {
            this.slackPoller.updateLastReadTs(identifier, result.ts);
          }
        }
      }

      this.dispatch(issue, { fromRepoEvent: true });
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  /** Append a Slack response to the slack_response.json array in the workspace. */
  private async appendSlackResponse(ref: WorkspaceRef, text: string): Promise<void> {
    const filePath = '.symphony/slack_response.json';
    let responses: Array<{ text: string; received_at: string }> = [];

    try {
      const existing = await this.io.readFile(ref, filePath);
      if (existing && existing.trim() !== '') {
        const parsed = JSON.parse(existing);
        // 기존 단일 객체 형식 호환
        responses = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch {
      // 파일 없거나 파싱 실패 → 빈 배열로 시작
    }

    responses.push({ text, received_at: new Date().toISOString() });
    await this.io.writeFile(ref, filePath, JSON.stringify(responses, null, 2));
  }

  // ---------------------------------------------------------------------------
  // Repository events
  // ---------------------------------------------------------------------------

  private startRepoPoller(): void {
    const repoCfg = this.trackerConfig.repository;
    if (!repoCfg) return;

    this.repoPoller = new RepoPoller(repoCfg, (event) => this.handleRepoEvent(event));
    this.repoPoller.start();
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
      case 'review_approved':
        logger.info(`PR #${event.pr.number} approved for issue ${identifier ?? 'unknown'}`);
        if (identifier) {
          void this.handleReviewApproved(identifier, event.pr.labels);
        }
        break;

      case 'changes_requested':
        logger.info(`Changes requested on PR #${event.pr.number} for issue ${identifier ?? 'unknown'}`);
        if (identifier) {
          void this.handleChangesRequested(identifier, event.pr.labels);
        }
        break;

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

  private async handleReviewApproved(identifier: string, prLabels: string[]): Promise<void> {
    if (this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier)) {
      logger.info(`Review approved for ${identifier}: agent busy, queueing`);
      this.queuedReviewEvent.set(identifier, { kind: 'review_approved', prLabels });
      return;
    }
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;
      this.dispatch(issue, { prLabels, fromRepoEvent: true });
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  private async handleChangesRequested(identifier: string, prLabels: string[]): Promise<void> {
    if (this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier)) {
      logger.info(`Changes requested for ${identifier}: agent busy, queueing`);
      this.queuedReviewEvent.set(identifier, { kind: 'changes_requested', prLabels });
      return;
    }
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;
      this.dispatch(issue, { prLabels, fromRepoEvent: true });
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  private async handleNewComments(
    identifier: string,
    prLabels: string[],
    comments: Comment[],
  ): Promise<void> {
    // Case 1: Agent running or dispatch in progress → queue for later
    if (this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier)) {
      this.enqueueComments(identifier, prLabels, comments);
      return;
    }

    // Case 2: Slack approval pending → merge feedback & re-plan
    if (this.slackPoller?.isWatching(identifier)) {
      await this.mergeAndReplan(identifier, prLabels, comments);
      return;
    }

    // Case 3: Idle → dispatch immediately
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      const ref = this.io.refForIssue(issue);
      if (await this.io.exists(ref)) {
        await this.writePrFeedback(ref, comments);
      }

      this.dispatch(issue, {
        prLabels,
        fromRepoEvent: true,
      });
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  // ---------------------------------------------------------------------------
  // PR merged handling
  // ---------------------------------------------------------------------------

  private async handlePRMerged(
    identifier: string,
    pr: import('./types.js').PullRequest,
  ): Promise<void> {
    // Transition issue to terminal state, delete branch, clean up — no agent dispatch
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

      const issue = await this.resolveIssueFromIdentifier(identifier, true);
      if (!issue) return;

      // 1. Transition issue to terminal state
      const terminalState = this.trackerConfig.terminal_states[0];
      if (terminalState) {
        try {
          await this.tracker.transitionIssue(issue.id, terminalState);
          logger.info(`Transitioned ${identifier} to ${terminalState} after PR merge`);
        } catch (err) {
          logger.warn(`Failed to transition ${identifier} to ${terminalState}`, { error: String(err) });
        }
      }

      // 2. Delete feature branch
      if (this.repoPoller && pr.branchName) {
        try {
          await this.repoPoller.deleteBranch(pr.branchName);
          logger.info(`Deleted branch ${pr.branchName} after PR merge`);
        } catch (err) {
          logger.warn(`Failed to delete branch ${pr.branchName}`, { error: String(err) });
        }
      }

      // 3. Slack notification
      if (this.slackPoller && this.config.slack) {
        const thread = this.slackPoller.getThread(identifier);
        if (thread) {
          void sendSlackMessage(
            this.config.slack.bot_token,
            thread.threadInfo.channel,
            `:merged: *${identifier}* PR이 머지되어 작업이 완료되었습니다.`,
            thread.threadInfo.thread_ts,
          );
        }
        this.slackPoller.unwatch(identifier);
      }

      // 4. Clean up queues
      this.queuedComments.delete(identifier);
      this.queuedReviewEvent.delete(identifier);

      // 5. Clean up workspace
      await this.cleanupTerminalWorkspace(issue);
    } catch (err) {
      logger.error(`handlePRMerged failed for ${identifier}`, { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // PR comment queue & merge helpers
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

  private drainReviewQueue(identifier: string): void {
    const queued = this.queuedReviewEvent.get(identifier);
    if (!queued) return;

    this.queuedReviewEvent.delete(identifier);
    logger.info(`Draining queued review event (${queued.kind}) for ${identifier}`);
    if (queued.kind === 'review_approved') {
      void this.handleReviewApproved(identifier, queued.prLabels);
    } else {
      void this.handleChangesRequested(identifier, queued.prLabels);
    }
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
        this.dispatch(issue, { prLabels, fromRepoEvent: true });
        return;
      }

      // Merge new comments into existing pr_feedback.json
      await this.appendPrFeedback(ref, comments);

      // Notify Slack thread that plan is being updated
      if (this.config.slack) {
        const thread = this.slackPoller!.getThread(identifier);
        if (thread) {
          const result = await sendSlackMessage(
            this.config.slack.bot_token,
            thread.threadInfo.channel,
            `🔄 새로운 PR 피드백이 도착하여 계획을 작성합니다.`,
            thread.threadInfo.thread_ts,
          );
          if (result) {
            this.slackPoller!.updateLastReadTs(identifier, result.ts);
          }
        }
      }

      this.dispatch(issue, {
        prLabels,
        fromRepoEvent: true,
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
    const payload = JSON.stringify({
      comments: this.serializeComments(comments),
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

    const payload = JSON.stringify({
      comments: allEntries,
      received_at: new Date().toISOString(),
    });
    await this.io.writeFile(ref, '.symphony/pr_feedback.json', payload);
  }

  /**
   * Resolve an issue from its identifier (e.g. "TES-7").
   *
   * Resolution order:
   *  1. Found in watchedIssues cache → return directly.
   *  2. Fallback: fetch from tracker by identifier.
   */
  private async resolveIssueFromIdentifier(identifier: string, skipCache = false): Promise<Issue | null> {
    if (!skipCache) {
      const cached = this.watchedIssues.get(identifier);
      if (cached) {
        logger.info(`Resolved ${identifier} from cache`);
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
// Helpers
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

/** Exhaustive check helper — TypeScript ensures this is unreachable at compile time. */
function assertNever(x: never): never {
  throw new Error(`Unhandled discriminated union case: ${JSON.stringify(x)}`);
}
