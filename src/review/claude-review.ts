/**
 * Claude-based review backend — runs `claude -p` in one-shot mode (no session).
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../logger.js';
import { shellEscape } from '../shell-utils.js';
import { buildReviewPrompt, buildValidationPrompt } from './prompt.js';
import type { ReviewBackend, ReviewContext, ReviewFinding } from './types.js';
import type { WorkspaceRef } from '../types.js';
import type { ClaudeAgentConfig } from '../config/schema.js';

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

export class ClaudeReviewBackend implements ReviewBackend {
  private readonly config: ClaudeAgentConfig;
  private readonly ref: WorkspaceRef;

  constructor(config: ClaudeAgentConfig, ref: WorkspaceRef) {
    this.config = config;
    this.ref = ref;
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

  private runOneShot(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.turn_timeout_ms;

      let cmd: string;
      let spawnArgs: string[];
      let cwd: string;

      const args = ['-p', prompt, '--output-format', 'text'];

      if (this.ref.containerName) {
        cmd = 'docker';
        const claudeCmd = ['claude', ...args].map(shellEscape).join(' ');
        const innerCmd = `cd ${shellEscape(this.ref.workspace)} && ${claudeCmd}`;
        spawnArgs = ['exec', '--user', 'worker', this.ref.containerName, 'bash', '-lc', innerCmd];
        cwd = process.cwd();
      } else {
        cmd = this.config.command || 'claude';
        spawnArgs = args;
        cwd = this.ref.workspace;
      }

      const child = spawn(cmd, spawnArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: string[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(new Error(`Claude review timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => chunks.push(chunk));
      child.stderr.on('data', (chunk: string) => {
        if (chunk.trim()) logger.warn(`[claude-review] ${chunk.trim()}`);
      });

      let settled = false;

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) return;

        const output = chunks.join('');
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Claude review exited with code ${code}: ${output.slice(0, 500)}`));
        }
      });
    });
  }

  private parseFindings(output: string): ReviewFinding[] {
    // Extract JSON array from output (may be wrapped in markdown code block)
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('Claude review returned no JSON array', { preview: output.slice(0, 300) });
      return [];
    }

    let raw: unknown;
    try {
      raw = JSON.parse(jsonMatch[0]);
    } catch {
      logger.warn('Claude review returned unparseable JSON', { preview: jsonMatch[0].slice(0, 300) });
      return [];
    }

    const result = FindingsArraySchema.safeParse(raw);
    if (!result.success) {
      logger.warn('Claude review findings did not match schema', { error: result.error.message });
      return [];
    }

    return result.data.map((f) => ({
      ...f,
      agent: '',
      round: 0,
    }));
  }
}
