/**
 * Zod 설정 스키마 — elixir/lib/symphony_elixir/config/schema.ex 를 미러링
 *
 * WORKFLOW.md 형식:
 *
 *   trackers:
 *     - kind: linear
 *       project_slug: "my-project"
 *       active_states:
 *         - Todo
 *         - In Progress
 *       terminal_states:
 *         - Done
 *         - Closed
 *       repository:             # optional GitHub / Bitbucket integration
 *         kind: github
 *         repo: owner/repo
 *         token: $GITHUB_TOKEN
 *         event_source: polling
 *         hooks:
 *           after_create: |          # credentials 후, clone 전
 *             echo "container ready"
 *           after_clone: |           # clone 후
 *             npm ci
 *           before_run: |            # 매 에이전트 실행 전
 *             git fetch origin
 *           after_run: |             # 매 에이전트 실행 후
 *             rm -rf node_modules/.cache
 *           before_remove: |         # 워크스페이스 제거 전
 *             echo "cleanup"
 *           timeout_ms: 300000
 *
 *   agents:
 *     max_concurrent: 10
 *     review:
 *       rounds: 2
 *       kinds:
 *         - claude
 *     backends:
 *       - kind: claude
 *         primary: true
 *         models:
 *           planning: opus
 *           implementation: sonnet
 *       - kind: codex
 *         trigger:
 *           pr_labels: [security]
 *
 * 하위 호환성을 위해 최상위 `tracker:` (단일 객체) 형식도 허용하며,
 * 단일 요소 `trackers` 배열로 정규화됩니다.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/** 환경 변수에서 "$ENV_VAR" 토큰을 해석합니다. */
function resolveEnv(value: string): string {
  return value.replace(/\$([A-Z0-9_]+)/g, (_match, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new Error(`Environment variable $${name} is not set (referenced in config)`);
    }
    return val;
  });
}

/** Zod 전처리기: 문자열 필드의 환경 변수를 해석합니다. */
const envString = z.preprocess(
  (v) => (typeof v === 'string' ? resolveEnv(v) : v),
  z.string(),
);

const optionalEnvString = z.preprocess(
  (v) => (typeof v === 'string' ? resolveEnv(v) : v),
  z.string().optional(),
);

// ---------------------------------------------------------------------------
// 저장소 훅
// ---------------------------------------------------------------------------

const repositoryHooksSchema = z.object({
  after_create: z.string().nullable().optional(),
  after_clone: z.string().nullable().optional(),
  before_run: z.string().nullable().optional(),
  after_run: z.string().nullable().optional(),
  before_remove: z.string().nullable().optional(),
  timeout_ms: z.number().int().positive().default(300_000),
}).default({});

// ---------------------------------------------------------------------------
// 저장소 (GitHub / Bitbucket)
// ---------------------------------------------------------------------------

const githubRepositorySchema = z.object({
  kind: z.literal('github'),
  repo: envString,
  token: optionalEnvString,
  poll_interval_ms: z.number().int().positive().default(30_000),
  pr_label_filter: z.string().default('symphony'),
  event_source: z.enum(['polling', 'webhook']).default('polling'),
  webhook_secret: optionalEnvString,
  hooks: repositoryHooksSchema,
});

const bitbucketRepositorySchema = z.object({
  kind: z.literal('bitbucket'),
  workspace: envString,
  repo_slug: envString,
  /** Bitbucket 개인 API 토큰 사용 시 필수 — Basic(이메일:토큰) 인증. 워크스페이스 토큰만 사용할 경우 생략 가능. */
  email: optionalEnvString,
  api_token: optionalEnvString,
  poll_interval_ms: z.number().int().positive().default(30_000),
  pr_label_filter: z.string().optional(),
  event_source: z.enum(['polling', 'webhook']).default('polling'),
  webhook_secret: optionalEnvString,
  hooks: repositoryHooksSchema,
});

const baseRepositoryExtensions = {
  /** 이 저장소에 매핑되는 이슈 레이블. 다중 저장소 설정에서 사용합니다. */
  issue_labels: z.array(z.string()).default([]),
  /** 레이블 일치 항목이 없을 때 이 저장소를 사용합니다 (다중 저장소 폴백). */
  default: z.boolean().default(false),
};

export const repositorySchema = z.discriminatedUnion('kind', [
  githubRepositorySchema.extend(baseRepositoryExtensions),
  bitbucketRepositorySchema.extend(baseRepositoryExtensions),
]);

export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type GitHubRepositoryConfig = z.infer<typeof githubRepositorySchema>;
export type BitbucketRepositoryConfig = z.infer<typeof bitbucketRepositorySchema>;

// ---------------------------------------------------------------------------
// 트래커 상태 (시맨틱 매핑)
// ---------------------------------------------------------------------------

const statesSchema = z.object({
  /** 새 이슈 진입 상태 (계획 생성). */
  planning: z.string(),
  /** Slack 계획 승인 대기 중. */
  plan_review: z.string(),
  /** 구현 진행 중. */
  in_progress: z.string(),
  /** 사람의 PR 리뷰 대기 중. */
  in_review: z.string(),
  /** 완료됨. */
  done: z.string(),
  /** 취소됨 / 중복됨 (선택 사항). */
  canceled: z.string().optional(),
});

export type StatesConfig = z.infer<typeof statesSchema>;

// ---------------------------------------------------------------------------
// 트래커
// ---------------------------------------------------------------------------

const baseTrackerSchema = z.object({
  states: statesSchema,
  /** 자동 파생된 active_states를 재정의합니다. 비어 있으면 states에서 파생됩니다. */
  active_states: z.array(z.string()).default([]),
  /** 자동 파생된 terminal_states를 재정의합니다. 비어 있으면 states에서 파생됩니다. */
  terminal_states: z.array(z.string()).default([]),
  /** 이 트래커에서 후보 이슈를 폴링하는 주기 (ms). */
  poll_interval_ms: z.number().int().positive().default(30_000),
  assignee: z.string().optional(),
  endpoint: z.string().url().optional(),
  repository: repositorySchema.optional(),
  /** 이 트래커에 연결된 다중 저장소. 설정 시 `repository`를 덮어씁니다. */
  repositories: z.array(repositorySchema).optional(),
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
// 에이전트 트리거 조건
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  /**
   * 이슈에 이 레이블 중 하나 이상이 있을 때만 이 에이전트를 실행합니다.
   * 생략 시 이슈 레이블을 확인하지 않습니다.
   */
  issue_labels: z.array(z.string()).optional(),
  /**
   * 디스패치를 트리거한 PR에 이 레이블 중 하나 이상이 있을 때만 이 에이전트를 실행합니다.
   * PR 트리거가 아닌 경우 무시됩니다.
   * 생략 시 PR 레이블을 확인하지 않습니다.
   */
  pr_labels: z.array(z.string()).optional(),
  /**
   * 이슈 담당자의 이메일이 이 목록 중 하나와 일치할 때만 이 에이전트를 실행합니다.
   * 생략 시 담당자를 확인하지 않습니다.
   */
  assignees: z.array(z.string()).optional(),
}).optional();

export type TriggerConfig = z.infer<typeof triggerSchema>;

// ---------------------------------------------------------------------------
// 에이전트 백엔드 — 판별 유니온
// ---------------------------------------------------------------------------

const agentModelsSchema = z.object({
  planning: z.string().default('opus'),
  implementation: z.string().default('sonnet'),
}).optional();

const claudeAgentSchema = z.object({
  kind: z.literal('claude'),
  /** 이 에이전트를 주 에이전트로 지정합니다 (계획/구현/리뷰 통합). 미설정 시 첫 번째 에이전트가 기본값. */
  primary: z.boolean().optional(),
  /** `claude` 바이너리의 경로 또는 이름. */
  command: z.string().default('claude'),
  /** 단계별 모델 선택 (계획 vs 구현). */
  models: agentModelsSchema,
  /** 최대 에이전트 턴 수 (CLI --max-turns에 전달). 생략 시 무제한 (Claude CLI 기본값). */
  max_turns: z.number().int().positive().optional(),
  /** 턴당 선택적 지출 한도 (USD). */
  max_budget_usd: z.number().positive().optional(),
  /** MCP 서버 설정 JSON 파일 경로. */
  mcp_config: z.string().optional(),
  /** Claude가 사용할 수 있는 도구를 제한합니다 (비어 있으면 모든 도구 허용). */
  allowed_tools: z.array(z.string()).default([]),
  /** 턴당 실제 시간 타임아웃 (밀리초). */
  turn_timeout_ms: z.number().int().positive().default(3_600_000),
  /** Claude Code 인증/세션 파일이 있는 호스트 디렉터리. 기본 자격 증명 주입을 재정의합니다. */
  claude_auth_dir: z.string().optional(),
  trigger: triggerSchema,
});

const codexAgentSchema = z.object({
  kind: z.literal('codex'),
  /** 이 에이전트를 주 에이전트로 지정합니다 (계획/구현/리뷰 통합). 미설정 시 첫 번째 에이전트가 기본값. */
  primary: z.boolean().optional(),
  /** `codex` 바이너리의 경로 또는 이름. */
  command: z.string().default('codex'),
  /** 오케스트레이터에 제어를 반환하기 전 최대 에이전트 턴 수. */
  max_turns: z.number().int().positive().default(20),
  /** Codex 승인 정책 (예: "never", "on-failure"). */
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
// 워크스페이스
// ---------------------------------------------------------------------------

const workspaceSchema = z.object({
  root: z.string().default('./symphony-workspaces'),
}).default({});

// ---------------------------------------------------------------------------
// 워커 (SSH)
// ---------------------------------------------------------------------------

const workerSchema = z.object({
  ssh_hosts: z.array(z.string()).default([]),
}).default({});

// ---------------------------------------------------------------------------
// Docker 워크스페이스 백엔드
// ---------------------------------------------------------------------------

const dockerSchema = z.object({
  image: z.string().default('symphony-worker:latest'),
  auth_mount: z.string().optional(),
  memory: z.string().optional(),
  cpus: z.string().optional(),
  env: z.record(z.string()).default({}),
}).default({});

// ---------------------------------------------------------------------------
// 관측 가능성 / 대시보드
// ---------------------------------------------------------------------------

const observabilitySchema = z.object({
  refresh_interval_ms: z.number().int().positive().default(2_000),
}).default({});

// ---------------------------------------------------------------------------
// 서버
// ---------------------------------------------------------------------------

const serverSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
}).default({});

// ---------------------------------------------------------------------------
// Slack (계획 승인 워크플로)
// ---------------------------------------------------------------------------

const slackSchema = z.object({
  bot_token: envString,
  app_token: envString,   // 앱 레벨 토큰 (xapp-...) — Socket Mode 연결에 필요
  channel: envString,
}).optional();

export type SlackConfig = z.infer<typeof slackSchema>;

// ---------------------------------------------------------------------------
// 에이전트 (통합: 백엔드 + 동시성 + 리뷰)
// ---------------------------------------------------------------------------

const reviewSchema = z.object({
  /** 에이전트당 리뷰 라운드 수. */
  rounds: z.number().int().min(1).max(5).default(2),
  /** 리뷰 세션을 실행할 에이전트 백엔드 종류 (병렬 실행). backends[].kind와 일치해야 합니다. */
  kinds: z.array(z.string()).min(1).default(['claude']),
});

const agentsSchema = z.object({
  /** 동시에 실행할 수 있는 최대 에이전트 수. */
  max_concurrent: z.number().int().positive().default(10),
  /** 재시도 간 지연 시간 (ms). */
  retry_backoff_ms: z.number().int().positive().default(5_000),
  /** 이슈당 최대 재시도 횟수. */
  max_retries: z.number().int().min(0).default(2),
  /** 자체 리뷰 설정. */
  review: reviewSchema.optional(),
  /** 에이전트 백엔드 정의. */
  backends: z.array(agentConfigSchema).min(1, 'At least one agent backend is required'),
});

export type ReviewConfig = z.infer<typeof reviewSchema>;

// ---------------------------------------------------------------------------
// 루트 설정
// ---------------------------------------------------------------------------

/** 정규화 전 원시 YAML 파싱 객체. */
const rawConfigSchema = z.object({
  workspace_backend: z.enum(['local', 'docker']).default('local'),
  trackers: z.array(trackerSchema).min(1, 'At least one tracker is required'),
  agents: agentsSchema,
  workspace: workspaceSchema,
  worker: workerSchema,
  docker: dockerSchema,
  observability: observabilitySchema,
  server: serverSchema,
  slack: slackSchema,
  /**
   * PR 코드 리뷰 피드백을 수신하는 출처.
   * 'pr' (기본값): GitHub/Bitbucket의 PR 댓글만 사용.
   * 'slack': Slack 스레드 답글만 사용 (이슈가 in_review 상태일 때).
   * 'both': 두 출처를 동시에 사용.
   */
  pr_feedback_source: z.enum(['pr', 'slack', 'both']).default('pr'),
});

/** `trackers`와 `agents`가 항상 채워진 완전히 파싱되고 검증된 설정. */
export const configSchema = rawConfigSchema.transform((raw) => {
  const trackers = raw.trackers.map((t) => {
    const s = t.states;
    const derivedActive = [s.planning, s.in_progress];
    const derivedTerminal = [s.done, ...(s.canceled ? [s.canceled] : [])];

    // 정규화: repository (단수) → repositories (배열)
    const repositories: RepositoryConfig[] = t.repositories && t.repositories.length > 0
      ? t.repositories
      : t.repository ? [t.repository] : [];

    return {
      ...t,
      active_states: t.active_states.length > 0 ? t.active_states : derivedActive,
      terminal_states: t.terminal_states.length > 0 ? t.terminal_states : derivedTerminal,
      repositories,
    };
  });

  return {
    workspace_backend: raw.workspace_backend,
    trackers,
    agents: raw.agents,
    workspace: raw.workspace,
    worker: raw.worker,
    docker: raw.docker,
    observability: raw.observability,
    server: raw.server,
    slack: raw.slack,
    pr_feedback_source: raw.pr_feedback_source,
  };
});

export type Config = z.infer<typeof configSchema>;
