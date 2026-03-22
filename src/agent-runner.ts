/**
 * Agent runner — executes a single issue through one or more agent turns.
 * Mirrors elixir/lib/symphony_elixir/agent_runner.ex
 *
 * Responsibilities:
 *  - Select candidate worker hosts (SSH or local)
 *  - Create workspace via WorkspaceBackend
 *  - Run before/after hooks
 *  - Drive multi-turn agent loop (unified for Claude/Codex)
 *  - Check issue state after each turn to decide continue/done
 */

import { logger } from './logger.js';
import { issueCtx } from './utils.js';
import { buildPrompt, buildResumePrompt, type PromptExtras } from './prompt-builder.js';
import { createAgentBackend } from './agent/factory.js';
import { createWorkspaceBackend } from './workspace/io.js';
import type { Issue, AgentBackend, WorkspaceBackend, WorkspaceRef, WorkspaceIO, AgentMessageHandler, TrackerClient, DispatchReason } from './types.js';
import type { Config, AgentConfig, RepositoryConfig, StatesConfig } from './config/schema.js';

export interface RunOptions {
  workerHost?: string;
  /** Override issue state fetcher for testing */
  issueStateFetcher?: (ids: string[]) => Promise<Issue[]>;
  onMessage?: AgentMessageHandler;
  /** Called with runtime info (workspace path, container name) once ready */
  onRuntimeInfo?: (info: RuntimeInfo) => void;
  /** Called after each agent turn with cost/token info */
  onTurnComplete?: (info: { cost?: number; tokensTotal?: number }) => void;
  /** Tracker kind (linear/jira) for prompt template context */
  trackerKind?: string;
  /** Repository kind (github/bitbucket) for prompt template context */
  repositoryKind?: string;
  /** AbortSignal — when aborted, the current agent turn is killed */
  signal?: AbortSignal;
  /** Active states for the specific tracker dispatching this issue. */
  activeStates?: string[];
  /** Why this run was dispatched */
  reason?: DispatchReason;
  /** WorkspaceIO for file access (pending_plan/question detection) */
  io?: WorkspaceIO;
  /** Repository config for auto-clone */
  repository?: RepositoryConfig;
  /** Semantic state mapping for prompt template */
  states?: StatesConfig;
  /** Model override for this run (e.g. 'opus', 'sonnet') */
  model?: string;
}

export interface RuntimeInfo {
  workerHost: string | null;
  workspacePath: string;
  containerName?: string;
}

export async function runIssue(
  issue: Issue,
  tracker: TrackerClient,
  config: Config,
  promptTemplate: string,
  agentConfigs: AgentConfig[],
  opts: RunOptions = {},
): Promise<void> {
  const workerHosts = candidateWorkerHosts(
    opts.workerHost,
    config.worker.ssh_hosts,
  );

  logger.info(
    `Starting agent run for ${issueCtx(issue)} worker_hosts=${JSON.stringify(workerHostsForLog(workerHosts))}`,
  );

  const errors: Error[] = [];

  for (const host of workerHosts) {
    try {
      await runOnWorkerHost(issue, tracker, config, promptTemplate, agentConfigs, host, opts);
      return;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      errors.push(wrapped);

      // Abort된 경우 다음 호스트 시도 불필요
      if (opts.signal?.aborted) throw wrapped;

      if (workerHosts.indexOf(host) < workerHosts.length - 1) {
        logger.warn(
          `Agent run failed for ${issueCtx(issue)} worker_host=${host ?? 'local'}, trying next`,
          { error: String(err) },
        );
      }
    }
  }

  const last = errors[errors.length - 1];
  throw last ?? new Error('No worker hosts available');
}

// ---------------------------------------------------------------------------
// Per-host execution
// ---------------------------------------------------------------------------

async function runOnWorkerHost(
  issue: Issue,
  tracker: TrackerClient,
  config: Config,
  promptTemplate: string,
  agentConfigs: AgentConfig[],
  workerHost: string | null,
  opts: RunOptions & { promptExtras?: PromptExtras },
): Promise<void> {
  logger.info(
    `Starting worker attempt for ${issueCtx(issue)} worker_host=${workerHost ?? 'local'}`,
  );

  const workspaceBackend = createWorkspaceBackend(config, opts.repository);
  const ref = await workspaceBackend.create(issue, workerHost ?? undefined);

  opts.onRuntimeInfo?.({
    workerHost,
    workspacePath: ref.workspace,
    containerName: ref.containerName,
  });

  try {
    await workspaceBackend.runBeforeRunHook(ref, issue);
    await runAgentSequence(issue, tracker, config, promptTemplate, agentConfigs, ref, opts);
  } finally {
    await workspaceBackend.runAfterRunHook(ref, issue).catch((err) => {
      logger.warn('after_run hook failed (non-fatal)', { error: String(err) });
    });
  }
}

// ---------------------------------------------------------------------------
// Sequential agent dispatch
// ---------------------------------------------------------------------------

async function runAgentSequence(
  issue: Issue,
  tracker: TrackerClient,
  config: Config,
  promptTemplate: string,
  agentConfigs: AgentConfig[],
  ref: WorkspaceRef,
  opts: RunOptions,
): Promise<void> {
  const issueStateFetcher = opts.issueStateFetcher ?? ((ids) => tracker.fetchIssuesByIds(ids));

  for (const agentConfig of agentConfigs) {
    logger.info(
      `Running ${agentConfig.kind} agent for ${issueCtx(issue)}`,
    );

    const backend = createAgentBackend(agentConfig);
    try {
      await runAgentTurns(issue, backend, agentConfig, config, promptTemplate, ref, opts, issueStateFetcher);
    } finally {
      await backend.dispose?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Unified multi-turn loop
// ---------------------------------------------------------------------------

async function runAgentTurns(
  issue: Issue,
  agentBackend: AgentBackend,
  agentConfig: AgentConfig,
  config: Config,
  promptTemplate: string,
  ref: WorkspaceRef,
  opts: RunOptions,
  issueStateFetcher: (ids: string[]) => Promise<Issue[]>,
): Promise<void> {
  const maxTurns = agentConfig.max_turns;
  const reason = opts.reason;
  let currentIssue = issue;

  for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
    // Build prompt — two branches:
    //   1. New issue on turn 1 → full prompt
    //   2. Everything else (re-dispatch or continuation) → resume prompt
    let prompt: string;

    if (turnNumber === 1 && (reason === 'new_issue' || reason == null)) {
      prompt = await buildPrompt(promptTemplate, currentIssue, turnNumber, {
        trackerKind: opts.trackerKind,
        repositoryKind: opts.repositoryKind,
        states: opts.states,
      });
    } else {
      prompt = buildResumePrompt(reason, turnNumber, maxTurns, opts.trackerKind);
    }

    if (opts.signal?.aborted) throw new Error('Agent run aborted');

    const turnTimeoutMs = 'turn_timeout_ms' in agentConfig ? agentConfig.turn_timeout_ms : undefined;

    const result = await agentBackend.run(ref.workspace, prompt, currentIssue, {
      containerName: ref.containerName,
      workerHost: ref.workerHost,
      onMessage: opts.onMessage,
      timeoutMs: turnTimeoutMs,
      signal: opts.signal,
      model: opts.model,
    });

    logger.info(
      `Completed ${agentConfig.kind} turn for ${issueCtx(currentIssue)} workspace=${ref.workspace} turn=${turnNumber}/${maxTurns}`,
    );

    opts.onTurnComplete?.({ cost: result.cost, tokensTotal: result.tokensTotal });

    const perTrackerActive = opts.activeStates ?? config.trackers.flatMap((t) => t.active_states);
    const { action, refreshedIssue } = await checkContinue(currentIssue, issueStateFetcher, perTrackerActive);
    currentIssue = refreshedIssue;

    // pending_plan.md 또는 question.md가 존재하면 Slack 응답 대기 — 턴 루프 강제 중단
    if (action === 'continue' && opts.io) {
      if (await hasPendingPlan(opts.io, ref)) {
        logger.info(`Pending plan detected for ${issueCtx(refreshedIssue)}; pausing turn loop for Slack approval`);
        return;
      }
      if (await hasQuestion(opts.io, ref)) {
        logger.info(`Question detected for ${issueCtx(refreshedIssue)}; pausing turn loop for Slack answer`);
        return;
      }
    }

    if (action !== 'continue' || turnNumber >= maxTurns) {
      if (action === 'continue') {
        logger.info(`Reached max_turns for ${issueCtx(refreshedIssue)} with issue still active; returning control to orchestrator`);
      }
      return;
    }

    logger.info(`Continuing ${agentConfig.kind} run for ${issueCtx(refreshedIssue)} turn=${turnNumber}/${maxTurns}`);
  }
}

// ---------------------------------------------------------------------------
// Issue state check
// ---------------------------------------------------------------------------

async function checkContinue(
  issue: Issue,
  fetcher: (ids: string[]) => Promise<Issue[]>,
  activeStates: string[],
): Promise<{ action: 'continue' | 'done'; refreshedIssue: Issue }> {
  if (!issue.id) return { action: 'done', refreshedIssue: issue };

  const [refreshed] = await fetcher([issue.id]);

  if (!refreshed) return { action: 'done', refreshedIssue: issue };

  const normalizedActive = activeStates.map((s) => s.toLowerCase().trim());
  const isActive = normalizedActive.includes(refreshed.state.toLowerCase().trim());

  return {
    action: isActive ? 'continue' : 'done',
    refreshedIssue: refreshed,
  };
}

// ---------------------------------------------------------------------------
// Worker host selection
// ---------------------------------------------------------------------------

function candidateWorkerHosts(
  preferredHost: string | undefined,
  configuredHosts: string[],
): Array<string | null> {
  const hosts = configuredHosts
    .map((h) => h.trim())
    .filter((h) => h !== '');

  const unique = [...new Set(hosts)];

  if (preferredHost && preferredHost.trim() !== '') {
    const preferred = preferredHost.trim();
    return [preferred, ...unique.filter((h) => h !== preferred)];
  }

  if (unique.length === 0) return [null];

  return unique;
}

function workerHostsForLog(hosts: Array<string | null>): string[] {
  return hosts.map((h) => h ?? 'local');
}

// ---------------------------------------------------------------------------
// Pending plan / question detection (via WorkspaceIO)
// ---------------------------------------------------------------------------

async function hasPendingPlan(io: WorkspaceIO, ref: WorkspaceRef): Promise<boolean> {
  try {
    const content = await io.readFile(ref, '.symphony/pending_plan.md');
    return content != null && content.trim() !== '';
  } catch {
    return false;
  }
}

async function hasQuestion(io: WorkspaceIO, ref: WorkspaceRef): Promise<boolean> {
  try {
    const content = await io.readFile(ref, '.symphony/question.md');
    return content != null && content.trim() !== '';
  } catch {
    return false;
  }
}
