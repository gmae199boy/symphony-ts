/**
 * Claude Code CLI 에이전트 백엔드.
 * elixir/lib/symphony_elixir/agent_backend/claude.ex 를 미러링합니다.
 *
 * 모든 JSON 파싱은 Zod 스키마를 사용합니다. 타입 단언(`as`)은 사용하지 않습니다.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { shellEscape } from '../shell-utils.js';
import { dockerExecRead, dockerExec, dockerExecWrite } from '../workspace/docker.js';
import type { Issue, AgentBackend, AgentRunOpts, AgentRunResult, AgentMessage } from '../types.js';
import type { ClaudeAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Claude CLI JSON 출력용 Zod 스키마
// ---------------------------------------------------------------------------

const ClaudeOutputSchema = z.object({
  session_id: z.string().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

type ClaudeOutput = z.infer<typeof ClaudeOutputSchema>;

// ---------------------------------------------------------------------------
// 백엔드
// ---------------------------------------------------------------------------

export class ClaudeBackend implements AgentBackend {
  private readonly config: ClaudeAgentConfig;

  constructor(config: ClaudeAgentConfig) {
    this.config = config;
  }

  async run(
    workspace: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult> {
    await ensureWorkflowFile(workspace, opts.workflow, opts.containerName);

    const prompt = opts.resumeMessage ?? '이슈를 처리하세요.';
    const timeoutMs = opts.timeoutMs ?? this.config.turn_timeout_ms;
    const args = buildArgs(prompt, opts, this.config, workspace);

    const containerLabel = opts.containerName ?? 'local';
    logger.debug(
      `Starting Claude agent for ${issueCtx(issue)} workspace=${workspace}` +
        ` container=${containerLabel}`,
    );

    const output = await spawnClaude(workspace, args, opts, timeoutMs, issue, opts.onMessage, this.config);
    return parseResult(output, issue);
  }
}

// ---------------------------------------------------------------------------
// 로깅용 도구 사용 상세 정보
// ---------------------------------------------------------------------------

function toolUseDetail(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Read':
    case 'Write':
      return input.file_path ? ` ${input.file_path}` : '';
    case 'Edit':
      return input.file_path ? ` ${input.file_path}` : '';
    case 'Bash': {
      const cmd = input.command as string | undefined;
      return cmd ? ` $ ${cmd.slice(0, 80)}` : '';
    }
    case 'Grep':
      return input.pattern ? ` /${input.pattern}/` : '';
    case 'Glob':
      return input.pattern ? ` ${input.pattern}` : '';
    case 'Agent':
      return input.description ? ` (${input.description})` : '';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// 프로세스 실행
// ---------------------------------------------------------------------------

function spawnClaude(
  workspace: string,
  args: string[],
  opts: AgentRunOpts,
  timeoutMs: number,
  issue: Issue,
  onMessage: ((m: AgentMessage) => void) | undefined,
  agentConfig: ClaudeAgentConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let spawnArgs: string[];
    let cwd: string;

    if (opts.containerName) {
      cmd = 'docker';
      const claudeCmd = ['claude', ...args].map(shellEscape).join(' ');
      const innerCmd = `cd ${shellEscape(workspace)} && ${claudeCmd}`;
      spawnArgs = ['exec', '--user', 'worker', opts.containerName, 'bash', '-lc', innerCmd];
      cwd = process.cwd();
    } else {
      cmd = agentConfig.command || 'claude';
      spawnArgs = args;
      cwd = workspace;
    }

    const child = spawn(cmd, spawnArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    let timedOut = false;

    // 중단 신호 지원 — 신호 발생 시 자식 프로세스를 종료합니다
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      clearTimeout(timer);
      reject(new Error('Claude turn aborted'));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Claude turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const containerCtx = opts.containerName ?? 'local';
    let sessionLogged = false;
    const handleLine = (line: string) => {
      lines.push(line);
      onMessage?.({
        event: { type: 'output', line },
        timestamp: new Date(),
      });
      // stream-json stdout 로그 처리
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const t = parsed.type as string | undefined;
        if (t === 'system' && !sessionLogged) {
          sessionLogged = true;
          logger.debug(`[${containerCtx}] Claude session started`, { issue: issueCtx(issue), sessionId: parsed.session_id });
        } else if (t === 'assistant' && parsed.message) {
          const msg = parsed.message as Record<string, unknown>;
          const content = msg.content as Array<Record<string, unknown>> | undefined;
          if (!content) return;
          for (const block of content) {
            if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown> | undefined;
              const detail = toolUseDetail(block.name as string, input);
              logger.debug(`[${containerCtx}] Tool: ${block.name}${detail}`, { issue: issueCtx(issue) });
            } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              // 에이전트 텍스트 출력 (처음 120자만 표시)
              const preview = block.text.trim().slice(0, 120);
              logger.debug(`[${containerCtx}] ${preview}`, { issue: issueCtx(issue) });
            }
          }
        } else if (t === 'result') {
          const turns = parsed.num_turns as number | undefined;
          const cost = parsed.total_cost_usd as number | undefined;
          const stopReason = parsed.stop_reason as string | undefined;
          const isError = parsed.is_error as boolean | undefined;
          logger.info(`[${containerCtx}] Claude finished`, {
            issue: issueCtx(issue), turns, cost: cost?.toFixed(4), stopReason, isError,
          });
        }
      } catch { /* JSON이 아닌 줄은 무시합니다 */ }
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop() ?? '';
      parts.forEach(handleLine);
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      const parts = stderrBuf.split('\n');
      stderrBuf = parts.pop() ?? '';
      parts.forEach((line) => {
        handleLine(line);
        if (line.trim()) {
          logger.warn(`[${containerCtx}] ${line}`, { issue: issueCtx(issue) });
        }
      });
    });

    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true;
        child.kill('SIGTERM');
        clearTimeout(timer);
        reject(new Error('Claude turn aborted'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (timedOut || aborted) return;

      if (stdoutBuf) { lines.push(stdoutBuf); }
      if (stderrBuf) {
        lines.push(stderrBuf);
        logger.warn(`[${containerCtx}] ${stderrBuf}`, { issue: issueCtx(issue) });
      }

      const output = lines.join('\n');

      if (code === 0) {
        resolve(output);
      } else {
        logger.warn(`Claude exited with code ${code} for ${issueCtx(issue)}`, {
          preview: output.slice(0, 500),
        });
        reject(new Error(`Claude exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// WORKFLOW 파일 주입
// ---------------------------------------------------------------------------

const WORKFLOW_RULES_PATH = '.claude/rules/symphony-workflow.md';

async function ensureWorkflowFile(
  workspace: string,
  workflow: string,
  containerName?: string,
): Promise<void> {
  if (containerName) {
    const containerFile = `${workspace}/${WORKFLOW_RULES_PATH}`;
    const existing = await dockerExecRead(containerName, containerFile);
    if (existing !== null) return;

    const containerRulesDir = `${workspace}/${path.posix.dirname(WORKFLOW_RULES_PATH)}`;
    await dockerExec(containerName, `mkdir -p ${shellEscape(containerRulesDir)}`, 10_000);
    await dockerExecWrite(containerName, containerFile, workflow);
    logger.info(`Wrote WORKFLOW to ${containerFile} in container ${containerName}`);
  } else {
    const localFile = path.join(workspace, WORKFLOW_RULES_PATH);
    try {
      await fs.access(localFile);
      return;
    } catch {
      // 파일이 없으면 새로 작성합니다
    }
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.writeFile(localFile, workflow, 'utf8');
    logger.info(`Wrote WORKFLOW to ${localFile}`);
  }
}

// ---------------------------------------------------------------------------
// 인수 빌더
// ---------------------------------------------------------------------------

function buildArgs(
  prompt: string,
  opts: AgentRunOpts,
  agentConfig: ClaudeAgentConfig,
  workspace: string,
): string[] {
  const args: string[] = [
    '-p', prompt,
    '--verbose',
    '--output-format', 'stream-json',
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.containerName) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--continue');
  if (agentConfig.max_turns) args.push('--max-turns', String(agentConfig.max_turns));
  if (agentConfig.max_budget_usd) args.push('--max-budget-usd', String(agentConfig.max_budget_usd));
  if (agentConfig.mcp_config) {
    const isAbsolute = path.isAbsolute(agentConfig.mcp_config);
    const mcpPath = opts.containerName
      ? (isAbsolute ? agentConfig.mcp_config : path.posix.join(workspace, agentConfig.mcp_config))
      : path.resolve(agentConfig.mcp_config);
    args.push('--mcp-config', mcpPath);
  }
  if (agentConfig.allowed_tools.length > 0) {
    args.push('--allowedTools', agentConfig.allowed_tools.join(','));
  }

  return args;
}

// ---------------------------------------------------------------------------
// 출력 파싱 — Zod 사용, `as` 타입 단언 없음
// ---------------------------------------------------------------------------

function parseResult(output: string, issue: Issue): AgentRunResult {
  const lines = output.split('\n').filter((l) => l.trim() !== '');

  // stream-json: type=result 줄에서 최종 결과를 추출합니다
  let resultLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed.type === 'result') {
        resultLine = lines[i];
        break;
      }
    } catch { /* JSON이 아닌 줄은 건너뜁니다 */ }
  }

  // 폴백: 기존 방식으로 마지막 줄을 사용합니다
  if (!resultLine) resultLine = lines[lines.length - 1] ?? '';

  let raw: unknown;
  try {
    raw = JSON.parse(resultLine);
  } catch {
    throw new Error(`Claude returned unparseable output: ${output.slice(0, 200)}`);
  }

  const result = ClaudeOutputSchema.safeParse(raw);

  if (!result.success) {
    logger.warn(`Unexpected Claude JSON shape for ${issueCtx(issue)}`, {
      preview: resultLine.slice(0, 200),
      error: result.error.message,
    });
    throw new Error(`Claude output did not match expected shape: ${result.error.message}`);
  }

  const data: ClaudeOutput = result.data;
  const cost = data.total_cost_usd;
  const tokensTotal =
    data.usage
      ? (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
      : undefined;

  logger.info(`Claude turn complete for ${issueCtx(issue)}`, { costUsd: cost });

  return { cost, tokensTotal };
}
