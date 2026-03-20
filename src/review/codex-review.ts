/**
 * Codex-based review backend — runs codex app-server RPC in one-shot mode.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../logger.js';
import { buildReviewPrompt, buildValidationPrompt } from './prompt.js';
import type { ReviewBackend, ReviewContext, ReviewFinding } from './types.js';
import type { CodexAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// JSON-RPC helpers (simplified from agent/codex.ts for one-shot use)
// ---------------------------------------------------------------------------

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
  }).optional(),
});

const FindingsArraySchema = z.array(
  z.object({
    file: z.string(),
    lineStart: z.number(),
    lineEnd: z.number(),
    severity: z.enum(['high', 'medium', 'low']),
    category: z.string(),
    description: z.string(),
    suggestedFix: z.string().optional(),
    agent: z.string().optional(),
    round: z.number().optional(),
  }),
);

function rpcCall(
  child: ChildProcess,
  id: string | number,
  method: string,
  params: unknown,
  timeoutMs = 60_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RPC call ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let rawParsed: unknown;
        try { rawParsed = JSON.parse(trimmed); } catch { continue; }

        const msg = JsonRpcResponseSchema.safeParse(rawParsed);
        if (!msg.success || msg.data.id !== id) continue;

        cleanup();
        if (msg.data.error) {
          reject(new Error(`JSON-RPC error ${msg.data.error.code}: ${msg.data.error.message}`));
        } else {
          resolve(msg.data.result);
        }
      }
    };

    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('Codex process exited before RPC response')); };

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
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class CodexReviewBackend implements ReviewBackend {
  private readonly config: CodexAgentConfig;
  private readonly workspace: string;

  constructor(config: CodexAgentConfig, workspace: string) {
    this.config = config;
    this.workspace = workspace;
  }

  async review(diff: string, context: ReviewContext): Promise<ReviewFinding[]> {
    const prompt = buildReviewPrompt(diff, context.previousFindings, context.round, context.totalRounds);
    const output = await this.runOneShot(prompt);
    return this.parseFindings(output);
  }

  async validate(diff: string, allFindings: ReviewFinding[]): Promise<ReviewFinding[]> {
    const prompt = buildValidationPrompt(diff, allFindings);
    const output = await this.runOneShot(prompt);
    return this.parseFindings(output);
  }

  private async runOneShot(prompt: string): Promise<string> {
    const parts = this.config.command.split(/\s+/);
    const cmd = parts[0];
    const cmdArgs = parts.slice(1);

    const child = spawn(cmd, cmdArgs, {
      cwd: this.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const sessionId = `review-${Date.now()}`;

      await rpcCall(child, sessionId, 'session.start', {
        workdir: this.workspace,
        approvalPolicy: this.config.approval_policy,
        sandboxPolicy: this.config.turn_sandbox_policy,
      });

      const turnId = `review-turn-${Date.now()}`;
      const raw = await rpcCall(child, turnId, 'turn.run', { sessionId, prompt });

      await rpcCall(child, `stop-${sessionId}`, 'session.stop', {}, 5_000).catch(() => undefined);

      const result = z.object({ result: z.string().optional() }).safeParse(raw);
      return result.success ? (result.data.result ?? '') : '';
    } finally {
      child.kill();
    }
  }

  private parseFindings(output: string): ReviewFinding[] {
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('Codex review returned no JSON array', { preview: output.slice(0, 300) });
      return [];
    }

    let raw: unknown;
    try { raw = JSON.parse(jsonMatch[0]); } catch {
      logger.warn('Codex review returned unparseable JSON', { preview: jsonMatch[0].slice(0, 300) });
      return [];
    }

    const result = FindingsArraySchema.safeParse(raw);
    if (!result.success) {
      logger.warn('Codex review findings did not match schema', { error: result.error.message });
      return [];
    }

    return result.data.map((f) => ({ ...f, agent: '', round: 0 }));
  }
}
