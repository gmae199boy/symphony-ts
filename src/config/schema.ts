/**
 * Zod configuration schema — mirrors elixir/lib/symphony_elixir/config/schema.ex
 *
 * WORKFLOW.md format:
 *
 *   trackers:
 *     - kind: linear
 *       project_slug: "my-project"
 *       active_states: [Todo, In Progress]
 *       terminal_states: [Done, Closed]
 *       repository:             # optional GitHub / Bitbucket integration
 *         kind: github
 *         repo: owner/repo
 *         token: $GITHUB_TOKEN
 *         event_source: polling
 *
 *   agents:
 *     - kind: claude
 *       max_turns: 20
 *     - kind: codex
 *       trigger:
 *         pr_labels: [security]
 *
 * For backwards compatibility a top-level `tracker:` (single object) is also
 * accepted and normalised into a one-element `trackers` array.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve "$ENV_VAR" tokens from the environment. */
function resolveEnv(value: string): string {
  return value.replace(/\$([A-Z0-9_]+)/g, (_match, name: string) => {
    return process.env[name] ?? '';
  });
}

/** Zod preprocessor: resolve env vars in string fields. */
const envString = z.preprocess(
  (v) => (typeof v === 'string' ? resolveEnv(v) : v),
  z.string(),
);

const optionalEnvString = z.preprocess(
  (v) => (typeof v === 'string' ? resolveEnv(v) : v),
  z.string().optional(),
);

// ---------------------------------------------------------------------------
// Repository (GitHub / Bitbucket)
// ---------------------------------------------------------------------------

const githubRepositorySchema = z.object({
  kind: z.literal('github'),
  repo: envString,
  token: optionalEnvString,
  poll_interval_ms: z.number().int().positive().default(30_000),
  pr_label_filter: z.string().default('symphony'),
  event_source: z.enum(['polling', 'webhook']).default('polling'),
  webhook_secret: optionalEnvString,
});

const bitbucketRepositorySchema = z.object({
  kind: z.literal('bitbucket'),
  workspace: envString,
  repo_slug: envString,
  email: optionalEnvString,
  api_token: optionalEnvString,
  poll_interval_ms: z.number().int().positive().default(30_000),
  pr_label_filter: z.string().optional(),
  event_source: z.enum(['polling', 'webhook']).default('polling'),
  webhook_secret: optionalEnvString,
});

export const repositorySchema = z.discriminatedUnion('kind', [
  githubRepositorySchema,
  bitbucketRepositorySchema,
]);

export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type GitHubRepositoryConfig = z.infer<typeof githubRepositorySchema>;
export type BitbucketRepositoryConfig = z.infer<typeof bitbucketRepositorySchema>;

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const baseTrackerSchema = z.object({
  active_states: z.array(z.string()).min(1, 'At least one active_state required'),
  terminal_states: z.array(z.string()).min(1, 'At least one terminal_state required'),
  /** How often to poll this tracker for candidate issues (ms). */
  poll_interval_ms: z.number().int().positive().default(30_000),
  assignee: z.string().optional(),
  endpoint: z.string().url().optional(),
  repository: repositorySchema.optional(),
});

const linearTrackerSchema = baseTrackerSchema.extend({
  kind: z.literal('linear'),
  project_slug: envString,
  api_key: optionalEnvString,
});

const jiraTrackerSchema = baseTrackerSchema.extend({
  kind: z.literal('jira'),
  project_key: envString,
  host: envString,
  email: optionalEnvString,
  api_token: optionalEnvString,
});

export const trackerSchema = z.discriminatedUnion('kind', [
  linearTrackerSchema,
  jiraTrackerSchema,
]);

export type TrackerConfig = z.infer<typeof trackerSchema>;
export type LinearTrackerConfig = z.infer<typeof linearTrackerSchema>;
export type JiraTrackerConfig = z.infer<typeof jiraTrackerSchema>;

// ---------------------------------------------------------------------------
// Agent trigger conditions
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  /**
   * Run this agent only if the issue has at least one of these labels.
   * If omitted, the issue label is not checked.
   */
  issue_labels: z.array(z.string()).optional(),
  /**
   * Run this agent only if the PR that triggered the dispatch has at least
   * one of these labels.  Ignored when dispatch is not PR-triggered.
   * If omitted, the PR label is not checked.
   */
  pr_labels: z.array(z.string()).optional(),
}).optional();

export type TriggerConfig = z.infer<typeof triggerSchema>;

// ---------------------------------------------------------------------------
// Agent backends — discriminated union
// ---------------------------------------------------------------------------

const claudeAgentSchema = z.object({
  kind: z.literal('claude'),
  /** Path or name of the `claude` binary. */
  command: z.string().default('claude'),
  /** Maximum agent turns before returning control to the orchestrator. */
  max_turns: z.number().int().positive().default(20),
  /** Optional per-turn spending cap in USD. */
  max_budget_usd: z.number().positive().optional(),
  /** Path to an MCP server config JSON file. */
  mcp_config: z.string().optional(),
  /** Restrict which tools Claude may use (empty = all tools allowed). */
  allowed_tools: z.array(z.string()).default([]),
  /** Per-turn wall-clock timeout in milliseconds. */
  turn_timeout_ms: z.number().int().positive().default(3_600_000),
  trigger: triggerSchema,
});

const codexAgentSchema = z.object({
  kind: z.literal('codex'),
  /** Full command string for the Codex app-server process. */
  command: z.string().default('codex app-server'),
  /** Maximum agent turns before returning control to the orchestrator. */
  max_turns: z.number().int().positive().default(20),
  /** Codex approval policy (e.g. "never", "on-failure"). */
  approval_policy: z.string().default('never'),
  thread_sandbox: z.string().optional(),
  turn_sandbox_policy: z.record(z.unknown()).optional(),
  trigger: triggerSchema,
});

export const agentConfigSchema = z.discriminatedUnion('kind', [
  claudeAgentSchema,
  codexAgentSchema,
]);

export type ClaudeAgentConfig = z.infer<typeof claudeAgentSchema>;
export type CodexAgentConfig = z.infer<typeof codexAgentSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const workspaceSchema = z.object({
  root: z.string().default('./symphony-workspaces'),
}).default({});

// ---------------------------------------------------------------------------
// Worker (SSH)
// ---------------------------------------------------------------------------

const workerSchema = z.object({
  ssh_hosts: z.array(z.string()).default([]),
  max_concurrent_agents: z.number().int().positive().default(10),
}).default({});

// ---------------------------------------------------------------------------
// Agent (concurrency + retry settings; per-agent turn limits live in AgentConfig)
// ---------------------------------------------------------------------------

const agentSchema = z.object({
  max_concurrent_agents: z.number().int().positive().default(10),
  retry_backoff_ms: z.number().int().positive().default(5_000),
}).default({});

// ---------------------------------------------------------------------------
// Docker workspace backend
// ---------------------------------------------------------------------------

const dockerSchema = z.object({
  image: z.string().default('symphony-worker:latest'),
  auth_mount: z.string().optional(),
  memory: z.string().optional(),
  cpus: z.string().optional(),
  env: z.record(z.string()).default({}),
}).default({});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const hooksSchema = z.object({
  after_create: z.string().nullable().optional(),
  before_run: z.string().nullable().optional(),
  after_run: z.string().nullable().optional(),
  before_remove: z.string().nullable().optional(),
  timeout_ms: z.number().int().positive().default(300_000),
}).default({});

// ---------------------------------------------------------------------------
// Observability / Dashboard
// ---------------------------------------------------------------------------

const observabilitySchema = z.object({
  dashboard: z.boolean().default(true),
  refresh_interval_ms: z.number().int().positive().default(2_000),
}).default({});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const serverSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
}).default({});

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

/** Raw YAML-parsed object before normalization. */
const rawConfigSchema = z.object({
  workspace_backend: z.enum(['local', 'docker']).default('local'),
  trackers: z.array(trackerSchema).optional(),
  /** Legacy single-tracker key — normalised to trackers[0] */
  tracker: trackerSchema.optional(),
  /** One or more agent backends to run sequentially per issue. */
  agents: z.array(agentConfigSchema).optional(),
  workspace: workspaceSchema,
  worker: workerSchema,
  agent: agentSchema,
  docker: dockerSchema,
  hooks: hooksSchema,
  observability: observabilitySchema,
  server: serverSchema,
});

/** Fully-parsed, validated config with `trackers` and `agents` always populated. */
export const configSchema = rawConfigSchema.transform((raw) => {
  const trackers: TrackerConfig[] = raw.trackers ?? (raw.tracker ? [raw.tracker] : []);

  if (trackers.length === 0) {
    throw new Error('Config must define at least one tracker (trackers[] or tracker:)');
  }

  // Default: single Claude agent with all defaults applied
  const agents: AgentConfig[] = raw.agents ?? [claudeAgentSchema.parse({ kind: 'claude' })];

  return {
    workspace_backend: raw.workspace_backend,
    trackers,
    agents,
    workspace: raw.workspace,
    worker: raw.worker,
    agent: raw.agent,
    docker: raw.docker,
    hooks: raw.hooks,
    observability: raw.observability,
    server: raw.server,
  };
});

export type Config = z.infer<typeof configSchema>;
