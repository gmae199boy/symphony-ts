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
 *    reschedule, new_comment → reschedule)
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
import type { Issue, TrackerClient, RepoEvent, AgentMessage } from './types.js';
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
  linearIssueId: string | null;
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
  private completedCount = 0;
  private failedCount = 0;
  private repoEvents: RepoEventRecord[] = [];

  private pollTimer: NodeJS.Timeout | null = null;
  private repoPoller: RepoPoller | null = null;
  private stopped = false;

  constructor(config: Config, trackerConfig: TrackerConfig, promptTemplate: string) {
    super();
    this.config = config;
    this.trackerConfig = trackerConfig;
    this.promptTemplate = promptTemplate;
    this.tracker = createTrackerClient(trackerConfig);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    logger.info(`Orchestrator starting for tracker kind=${this.trackerConfig.kind}`);
    this.schedulePoll(0);
    this.startRepoPoller();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.repoPoller?.stop();
    logger.info('Orchestrator stopped');
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

    // Dispatch new issues
    const maxConcurrent = this.config.agent.max_concurrent_agents;
    const available = maxConcurrent - this.running.size;

    if (available <= 0) {
      logger.info(`At concurrency limit (${maxConcurrent}); skipping dispatch`);
      return;
    }

    const toDispatch = candidates
      .filter((issue) => !this.running.has(issue.id))
      .filter((issue) => !this.isBlocked(issue, candidates))
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
  // Dispatch
  // ---------------------------------------------------------------------------

  private dispatch(issue: Issue, prLabels?: string[], fromRepoEvent = false): void {
    const agents = this.selectAgents(issue, prLabels);

    if (agents.length === 0) {
      logger.info(`No matching agents for ${issue.identifier}; skipping dispatch`);
      return;
    }

    logger.info(
      `Dispatching issue ${issue.identifier} to ${agents.map((a) => a.kind).join(', ')} agent(s)`,
    );

    const entry: RunningEntry = {
      issue,
      promise: Promise.resolve(), // filled below
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      containerName: null,
      agentLogLines: [],
      fromRepoEvent,
    };

    const promise = runIssue(issue, this.tracker, this.config, this.promptTemplate, agents, {
      trackerKind: this.trackerConfig.kind,
      repositoryKind: this.trackerConfig.repository?.kind,
      onMessage: (msg: AgentMessage) => this.handleAgentMessage(issue.id, msg),
      onRuntimeInfo: (info) => {
        const e = this.running.get(issue.id);
        if (e) {
          e.workerHost = info.workerHost;
          e.workspacePath = info.workspacePath;
          e.containerName = info.containerName ?? null;
        }
      },
    });

    entry.promise = promise;
    this.running.set(issue.id, entry);

    promise
      .then(() => {
        logger.info(`Agent completed for ${issue.identifier}`);
        this.running.delete(issue.id);
        this.watchedIssues.set(issue.identifier, issue);
        this.completedCount++;
        this.cleanupTerminalWorkspace(issue);
        this.emit('agent:completed', issue);
      })
      .catch((err: unknown) => {
        logger.error(`Agent failed for ${issue.identifier}`, { error: String(err) });
        this.running.delete(issue.id);
        this.watchedIssues.set(issue.identifier, issue);
        this.failedCount++;
        this.emit('agent:failed', issue, err);
      });
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
        logger.info(`Issue ${entry.issue.identifier} left active states; removing from running`);
        this.running.delete(id);
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
        this.running.delete(id);
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

    logger.info(`Issue ${issue.identifier} reached terminal state; cleaning up workspace`);

    try {
      const backend = this.config.workspace_backend === 'docker'
        ? new DockerWorkspaceBackend(this.config)
        : new LocalWorkspaceBackend(this.config);

      const ref = this.config.workspace_backend === 'docker'
        ? { workspace: '/workspace', containerName: `symphony-${issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_')}` }
        : { workspace: `${this.config.workspace.root}/${issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_')}` };

      await backend.cleanup(ref, latest);
    } catch (err) {
      logger.warn('Workspace cleanup failed', { issue: issue.identifier, error: String(err) });
    }
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
      linearIssueId: event.pr.linearIssueId,
      timestamp: new Date(),
    };

    this.repoEvents.unshift(record);
    if (this.repoEvents.length > MAX_REPO_EVENTS) this.repoEvents.pop();

    this.emit('repo:event', event);

    const identifier = event.pr.linearIssueId;

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

      case 'new_comment':
        logger.info(`New comment on PR #${event.pr.number} for issue ${identifier ?? 'unknown'}`);
        if (identifier) {
          void this.handleNewComment(identifier, event.pr.labels);
        }
        break;
    }
  }

  private async handleReviewApproved(identifier: string, prLabels: string[]): Promise<void> {
    if (this.pendingDispatch.has(identifier)) return;
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier);
      if (!issue) return;
      this.dispatch(issue, prLabels, true);
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  private async handleChangesRequested(identifier: string, prLabels: string[]): Promise<void> {
    if (this.pendingDispatch.has(identifier)) return;
    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier);
      if (!issue) return;
      this.dispatch(issue, prLabels, true);
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  private async handleNewComment(identifier: string, prLabels: string[]): Promise<void> {
    if (this.isRunningByIdentifier(identifier) || this.pendingDispatch.has(identifier)) {
      logger.info(`New comment for ${identifier}: agent already running or pending, skipping`);
      return;
    }

    this.pendingDispatch.add(identifier);
    try {
      const issue = await this.resolveIssueFromIdentifier(identifier);
      if (!issue) return;
      this.dispatch(issue, prLabels, true);
    } finally {
      this.pendingDispatch.delete(identifier);
    }
  }

  /**
   * Resolve an issue from its identifier (e.g. "TES-7").
   *
   * Resolution order:
   *  1. Found in watchedIssues cache → return directly.
   *  2. Fallback: fetch from tracker by identifier.
   */
  private async resolveIssueFromIdentifier(identifier: string): Promise<Issue | null> {
    const cached = this.watchedIssues.get(identifier);
    if (cached) {
      logger.info(`Resolved ${identifier} from cache`);
      return cached;
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
