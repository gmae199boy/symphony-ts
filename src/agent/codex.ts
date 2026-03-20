/**
 * Codex (OpenAI) app-server agent backend.
 * Mirrors elixir/lib/symphony_elixir/agent_backend/codex.ex
 *
 * All JSON parsing uses Zod schemas. No type assertions (`as`) are used.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import type { Issue, AgentBackend, AgentRunOpts, AgentRunResult, AgentMessage } from '../types.js';
import type { CodexAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Zod schemas for JSON-RPC 2.0
// ---------------------------------------------------------------------------

const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});

const TurnResultSchema = z.object({
  session_id: z.string().nullable().optional(),
  total_tokens: z.number().optional(),
  result: z.string().optional(),
});

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

let sessionCounter = 0;

export class CodexBackend implements AgentBackend {
  private readonly config: CodexAgentConfig;

  constructor(config: CodexAgentConfig) {
    this.config = config;
  }

  async run(
    workspace: string,
    prompt: string,
    issue: Issue,
    opts: AgentRunOpts,
  ): Promise<AgentRunResult> {
    const parts = this.config.command.split(/\s+/);
    const cmd = parts[0];
    const cmdArgs = parts.slice(1);

    logger.info(`Starting Codex agent for ${issueCtx(issue)} workspace=${workspace}`);

    const child = spawn(cmd, cmdArgs, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Abort signal support — kill child process when signal fires
    const onAbort = () => { child.kill('SIGTERM'); };
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
        throw new Error('Codex run aborted');
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const sessionId = `session-${Date.now()}-${++sessionCounter}`;

      await rpcCall(child, sessionId, 'session.start', {
        workdir: workspace,
        approvalPolicy: this.config.approval_policy,
        sandboxPolicy: this.config.turn_sandbox_policy,
      });

      const result = await this.runTurn(child, sessionId, prompt, opts.onMessage);

      await rpcCall(child, `stop-${sessionId}`, 'session.stop', {}, 5_000).catch(() => undefined);

      return result;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      child.kill();
    }
  }

  private async runTurn(
    child: ChildProcess,
    sessionId: string,
    prompt: string,
    onMessage: ((m: AgentMessage) => void) | undefined,
  ): Promise<AgentRunResult> {
    const turnId = `turn-${Date.now()}`;
    const raw = await rpcCall(child, turnId, 'turn.run', { sessionId, prompt });

    const parsed = TurnResultSchema.safeParse(raw);

    if (!parsed.success) {
      logger.warn('Unexpected Codex turn result shape', { error: parsed.error.message });
      return { sessionId: null };
    }

    const data = parsed.data;

    if (onMessage && data.result) {
      for (const line of data.result.split('\n')) {
        onMessage({ event: { type: 'output', line }, timestamp: new Date() });
      }
    }

    return {
      sessionId: data.session_id ?? null,
      tokensTotal: data.total_tokens,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function rpcCall(
  child: ChildProcess,
  id: string | number,
  method: string,
  params: unknown,
  timeoutMs = 60_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    let settled = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RPC call ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let buf = '';

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let rawParsed: unknown;
        try {
          rawParsed = JSON.parse(trimmed);
        } catch {
          continue; // not JSON — skip
        }

        const msg = JsonRpcResponseSchema.safeParse(rawParsed);
        if (!msg.success) continue;

        if (msg.data.id === id) {
          cleanup();
          if (msg.data.error) {
            reject(
              new Error(
                `JSON-RPC error ${msg.data.error.code}: ${msg.data.error.message}`,
              ),
            );
          } else {
            resolve(msg.data.result);
          }
        }
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Codex process exited before RPC response'));
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };

    child.stdout?.on('data', onData);
    child.on('error', onError);
    child.on('close', onClose);
    try {
      child.stdin?.write(JSON.stringify(request) + '\n');
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
