/**
 * Codex (OpenAI) CLI agent backend.
 * Uses `codex exec` CLI mode (spawn → complete → exit), mirroring claude.ts.
 *
 * Session resumption:
 *  1. Always try `codex exec resume --last "prompt"` first
 *  2. If that fails (no previous session), fall back to `codex exec "prompt"`
 *
 * All JSON parsing uses Zod schemas. No type assertions (`as`) are used.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { shellEscape } from '../shell-utils.js';
import type { Issue, AgentBackend, AgentRunOpts, AgentRunResult, AgentMessage } from '../types.js';
import type { CodexAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Zod schema for Codex CLI JSON output
// ---------------------------------------------------------------------------

const CodexOutputSchema = z.object({
  total_tokens: z.number().optional(),
  result: z.string().optional(),
});

type CodexOutput = z.infer<typeof CodexOutputSchema>;

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class CodexBackend implements AgentBackend {
  private readonly config: CodexAgentConfig;

  constructor(config: CodexAgentConfig) {
    this.config = config;
  }

  async run(
    workspace: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult> {
    const prompt = opts.resumeMessage
      ? `${opts.workflow}\n\n---\n\n## Current instruction\n\n${opts.resumeMessage}`
      : opts.workflow;
    const timeoutMs = opts.timeoutMs ?? 3_600_000;

    logger.info(
      `Starting Codex agent for ${issueCtx(issue)} workspace=${workspace}` +
        ` container=${opts.containerName ?? 'local'}`,
    );

    // Try resume --last first, fall back to plain exec
    try {
      const args = buildArgs(prompt, this.config, true);
      const output = await spawnCodex(workspace, args, opts, timeoutMs, issue, opts.onMessage, this.config);
      return parseResult(output, issue);
    } catch (resumeErr) {
      // If aborted, don't retry
      if (opts.signal?.aborted) throw resumeErr;

      logger.info(
        `Codex resume --last failed for ${issueCtx(issue)}, falling back to fresh exec: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
      );

      const args = buildArgs(prompt, this.config, false);
      const output = await spawnCodex(workspace, args, opts, timeoutMs, issue, opts.onMessage, this.config);
      return parseResult(output, issue);
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

function spawnCodex(
  workspace: string,
  args: string[],
  opts: AgentRunOpts,
  timeoutMs: number,
  issue: Issue,
  onMessage: ((m: AgentMessage) => void) | undefined,
  agentConfig: CodexAgentConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let spawnArgs: string[];
    let cwd: string;

    if (opts.containerName) {
      cmd = 'docker';
      const codexCmd = ['codex', ...args].map(shellEscape).join(' ');
      const innerCmd = `cd ${shellEscape(workspace)} && ${codexCmd}`;
      spawnArgs = ['exec', '-i', '--user', 'worker', opts.containerName, 'bash', '-lc', innerCmd];
      cwd = process.cwd();
    } else {
      const parts = agentConfig.command.split(/\s+/);
      cmd = parts[0];
      spawnArgs = args;
      cwd = workspace;
    }

    const child = spawn(cmd, spawnArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    let timedOut = false;

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      clearTimeout(timer);
      reject(new Error('Codex turn aborted'));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Codex turn timed out after ${timeoutMs}ms`));
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
        reject(new Error('Codex turn aborted'));
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
        logger.warn(`Codex exited with code ${code} for ${issueCtx(issue)}`, {
          preview: output.slice(0, 500),
        });
        reject(new Error(`Codex exited with code ${code}`));
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
  agentConfig: CodexAgentConfig,
  resume: boolean,
): string[] {
  const args: string[] = ['exec'];

  if (resume) {
    args.push('resume', '--last');
  }

  if (agentConfig.approval_policy === 'never') {
    args.push('--full-auto');
  }

  args.push(prompt);

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
    // Codex may not output structured JSON — treat as successful with no metadata
    logger.info(`Codex turn complete for ${issueCtx(issue)} (no structured output)`);
    return {};
  }

  const result = CodexOutputSchema.safeParse(raw);

  if (!result.success) {
    logger.warn(`Unexpected Codex JSON shape for ${issueCtx(issue)}`, {
      preview: lastLine.slice(0, 200),
      error: result.error.message,
    });
    return {};
  }

  const data: CodexOutput = result.data;
  const tokensTotal = data.total_tokens;

  logger.info(`Codex turn complete for ${issueCtx(issue)}`, { tokensTotal });

  return { tokensTotal };
}
