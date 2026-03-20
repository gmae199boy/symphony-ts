/**
 * Local workspace backend — creates per-issue directories on the host filesystem.
 * Mirrors elixir/lib/symphony_elixir/workspace_backend/local.ex
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { spawnAsync } from '../spawn-async.js';
import type { Issue, WorkspaceRef, WorkspaceBackend } from '../types.js';
import type { Config } from '../config/schema.js';

export class LocalWorkspaceBackend implements WorkspaceBackend {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async create(issue: Issue, _workerHost?: string): Promise<WorkspaceRef> {
    const root = path.resolve(this.config.workspace.root);
    fs.mkdirSync(root, { recursive: true });

    const workspacePath = path.join(root, issueDir(issue));
    const isNew = !fs.existsSync(workspacePath);

    fs.mkdirSync(workspacePath, { recursive: true });

    const ref: WorkspaceRef = { workspace: workspacePath };

    if (isNew) {
      logger.info(`Created local workspace for ${issueCtx(issue)}`, { path: workspacePath });
      await this.runHook(this.config.hooks.after_create, ref, issue, 'after_create');
    } else {
      logger.info(`Reusing existing local workspace for ${issueCtx(issue)}`, { path: workspacePath });
    }

    return ref;
  }

  async runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.config.hooks.before_run, ref, issue, 'before_run');
  }

  async runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.config.hooks.after_run, ref, issue, 'after_run');
  }

  async cleanup(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.config.hooks.before_remove, ref, issue, 'before_remove');
    // Local backend does not delete the directory — preserve work artifacts.
  }

  private async runHook(
    command: string | null | undefined,
    ref: WorkspaceRef,
    issue: Issue,
    hookName: string,
  ): Promise<void> {
    if (!command || command.trim() === '') return;

    const timeoutMs = this.config.hooks.timeout_ms;
    logger.info(`Running ${hookName} hook for ${issueCtx(issue)}`, { workspace: ref.workspace });

    const result = await spawnAsync('bash', ['-lc', command], {
      cwd: ref.workspace,
      timeoutMs,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const msg = `${hookName} hook failed for ${issueCtx(issue)} (exit ${result.status}): ${stderr.slice(0, 500)}`;
      if (hookName === 'before_run' || hookName === 'after_create') {
        throw new Error(msg);
      }
      logger.warn(msg);
    }
  }
}

export function issueDir(issue: Issue): string {
  return issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
}
