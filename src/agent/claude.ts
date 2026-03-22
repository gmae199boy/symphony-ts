/**
 * Claude Code CLI agent backend.
 * Mirrors elixir/lib/symphony_elixir/agent_backend/claude.ex
 *
 * All JSON parsing uses Zod schemas. No type assertions (`as`) are used.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { shellEscape } from '../shell-utils.js';
import type { Issue, AgentBackend, AgentRunOpts, AgentRunResult, AgentMessage } from '../types.js';
import type { ClaudeAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Zod schema for Claude CLI JSON output
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
// Backend
// ---------------------------------------------------------------------------

export class ClaudeBackend implements AgentBackend {
  private readonly config: ClaudeAgentConfig;

  constructor(config: ClaudeAgentConfig) {
    this.config = config;
  }

  async run(
    workspace: string,
    prompt: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult> {
    const timeoutMs = opts.timeoutMs ?? this.config.turn_timeout_ms;
    const args = buildArgs(prompt, opts, this.config, workspace);

    const containerLabel = opts.containerName ?? 'local';
    logger.info(
      `Starting Claude agent for ${issueCtx(issue)} workspace=${workspace}` +
        ` container=${containerLabel}`,
    );

    const output = await spawnClaude(workspace, args, opts, timeoutMs, issue, opts.onMessage, this.config);
    return parseResult(output, issue);
  }
}

// ---------------------------------------------------------------------------
// Spawn
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

    // Abort signal support — kill child process when signal fires
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

    const handleLine = (line: string) => {
      lines.push(line);
      onMessage?.({
        event: { type: 'output', line },
        timestamp: new Date(),
      });
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop() ?? '';
      parts.forEach(handleLine);
    });

    const containerCtx = opts.containerName ?? 'local';

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
// Arg builder
// ---------------------------------------------------------------------------

function buildArgs(
  prompt: string,
  opts: AgentRunOpts,
  agentConfig: ClaudeAgentConfig,
  workspace: string,
): string[] {
  const args: string[] = [
    '-p', prompt,
    '--output-format', 'json',
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
// Output parsing — Zod, no `as`
// ---------------------------------------------------------------------------

function parseResult(output: string, issue: Issue): AgentRunResult {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const lastLine = lines[lines.length - 1] ?? '';

  let raw: unknown;
  try {
    raw = JSON.parse(lastLine);
  } catch {
    throw new Error(`Claude returned unparseable output: ${output.slice(0, 200)}`);
  }

  const result = ClaudeOutputSchema.safeParse(raw);

  if (!result.success) {
    logger.warn(`Unexpected Claude JSON shape for ${issueCtx(issue)}`, {
      preview: lastLine.slice(0, 200),
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
