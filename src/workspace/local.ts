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
import type { Config, RepositoryConfig, TrackerConfig } from '../config/schema.js';
import { buildCloneUrl } from './clone-url.js';
import { shellEscape } from '../shell-utils.js';

export class LocalWorkspaceBackend implements WorkspaceBackend {
  private readonly config: Config;
  private readonly repository?: RepositoryConfig;
  private readonly trackerConfig?: TrackerConfig;

  constructor(config: Config, repository?: RepositoryConfig, trackerConfig?: TrackerConfig) {
    this.config = config;
    this.repository = repository;
    this.trackerConfig = trackerConfig;
  }

  private get hooks() { return this.repository?.hooks; }
  private get hookTimeoutMs() { return this.hooks?.timeout_ms ?? 300_000; }

  async create(issue: Issue, _workerHost?: string, baseBranch?: string): Promise<WorkspaceRef> {
    const root = path.resolve(this.config.workspace.root);
    fs.mkdirSync(root, { recursive: true });

    const workspacePath = path.join(root, issueDir(issue));
    const isNew = !fs.existsSync(workspacePath);

    fs.mkdirSync(workspacePath, { recursive: true });

    const ref: WorkspaceRef = { workspace: workspacePath };

    if (isNew) {
      logger.info(`Created local workspace for ${issueCtx(issue)}`, { path: workspacePath });

      // after_create hook (runs before clone — fatal on failure)
      await this.runHook(this.hooks?.after_create, ref, issue, 'after_create');

      // Auto-clone
      if (this.repository) {
        const cloneUrl = buildCloneUrl(this.repository);
        logger.info(`Cloning ${cloneUrl} into ${workspacePath}${baseBranch ? ` (branch: ${baseBranch})` : ''}`);
        const cloneCmd = buildLocalCloneCommand(cloneUrl, this.repository, baseBranch);
        const cloneResult = await spawnAsync('bash', ['-lc', cloneCmd], {
          cwd: workspacePath, timeoutMs: this.hookTimeoutMs,
        });
        if (cloneResult.status !== 0) {
          throw new Error(`git clone failed (exit ${cloneResult.status}): ${cloneResult.stderr?.trim().slice(0, 500)}`);
        }

        // after_clone hook
        if (this.hooks?.after_clone?.trim()) {
          await this.runHook(this.hooks.after_clone, ref, issue, 'after_clone');
        }
      }
    } else {
      logger.info(`Reusing existing local workspace for ${issueCtx(issue)}`, { path: workspacePath });
    }

    return ref;
  }

  async runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.hooks?.before_run, ref, issue, 'before_run');
  }

  async runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.hooks?.after_run, ref, issue, 'after_run');
  }

  async cleanup(ref: WorkspaceRef, issue: Issue): Promise<void> {
    await this.runHook(this.hooks?.before_remove, ref, issue, 'before_remove');
    // Local backend does not delete the directory — preserve work artifacts.
  }

  private async runHook(
    command: string | null | undefined,
    ref: WorkspaceRef,
    issue: Issue,
    hookName: string,
  ): Promise<void> {
    if (!command || command.trim() === '') return;

    const timeoutMs = this.hookTimeoutMs;
    logger.info(`Running ${hookName} hook for ${issueCtx(issue)}`, { workspace: ref.workspace });

    const result = await spawnAsync('bash', ['-lc', command], {
      cwd: ref.workspace,
      timeoutMs,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const msg = `${hookName} hook failed for ${issueCtx(issue)} (exit ${result.status}): ${stderr.slice(0, 500)}`;
      if (hookName === 'before_run' || hookName === 'after_create' || hookName === 'after_clone') {
        throw new Error(msg);
      }
      logger.warn(msg);
    }
  }
}

export function issueDir(issue: Pick<Issue, 'identifier'>): string {
  return issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Builds a git clone command that passes credentials via an inline credential helper,
 * without embedding them in the URL or modifying the global ~/.git-credentials.
 */
function buildLocalCloneCommand(cloneUrl: string, repository: RepositoryConfig, baseBranch?: string): string {
  const branchFlag = baseBranch ? `--branch ${shellEscape(baseBranch)} ` : '';
  if (repository.kind === 'bitbucket') {
    const token = repository.api_token ?? process.env['BITBUCKET_API_TOKEN'];
    if (token) {
      const raw = repository.username ?? process.env['BITBUCKET_USERNAME'];
      const user = raw ? encodeURIComponent(raw) : 'x-token-auth';
      const pass = encodeURIComponent(token);
      // Inline credential helper — one-shot, does not modify global git config.
      const helper = `!f() { echo username=${user}; echo password=${pass}; }; f`;
      return `git -c ${shellEscape(`credential.helper=${helper}`)} clone --depth 1 ${branchFlag}${shellEscape(cloneUrl)} .`;
    }
  }
  return `git clone --depth 1 ${branchFlag}${shellEscape(cloneUrl)} .`;
}
