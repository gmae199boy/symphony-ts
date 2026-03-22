/**
 * Codex-based review backend — runs `codex exec` in one-shot mode.
 */

import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import { shellEscape } from '../shell-utils.js';
import { buildReviewPrompt, buildValidationPrompt } from './prompt.js';
import type { ReviewBackend, ReviewContext } from './types.js';
import type { WorkspaceRef } from '../types.js';
import type { CodexAgentConfig } from '../config/schema.js';

export class CodexReviewBackend implements ReviewBackend {
  private readonly config: CodexAgentConfig;
  private readonly ref: WorkspaceRef;

  constructor(config: CodexAgentConfig, ref: WorkspaceRef) {
    this.config = config;
    this.ref = ref;
  }

  async review(diff: string, context: ReviewContext): Promise<string> {
    const prompt = buildReviewPrompt(diff, context.previousResults, context.round, context.totalRounds);
    return this.runOneShot(prompt);
  }

  async validate(diff: string, allResults: string[]): Promise<string> {
    const prompt = buildValidationPrompt(diff, allResults);
    return this.runOneShot(prompt);
  }

  private runOneShot(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutMs = 3_600_000; // codex config has no turn_timeout_ms; use 1h default

      let cmd: string;
      let spawnArgs: string[];
      let cwd: string;

      const args = ['exec', '--full-auto', prompt];

      if (this.ref.containerName) {
        cmd = 'docker';
        const codexCmd = ['codex', ...args].map(shellEscape).join(' ');
        const innerCmd = `cd ${shellEscape(this.ref.workspace)} && ${codexCmd}`;
        spawnArgs = ['exec', '-i', '--user', 'worker', this.ref.containerName, 'bash', '-lc', innerCmd];
        cwd = process.cwd();
      } else {
        cmd = this.config.command || 'codex';
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
        reject(new Error(`Codex review timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => chunks.push(chunk));
      child.stderr.on('data', (chunk: string) => {
        if (chunk.trim()) logger.warn(`[codex-review] ${chunk.trim()}`);
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
          reject(new Error(`Codex review exited with code ${code}: ${output.slice(0, 500)}`));
        }
      });
    });
  }
}
