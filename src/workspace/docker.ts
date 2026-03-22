/**
 * Docker workspace backend — creates/reuses per-issue containers.
 * Mirrors elixir/lib/symphony_elixir/workspace_backend/docker.ex
 *
 * Lifecycle:
 *  - create: reuse existing container if present; otherwise start new one and
 *    run after_create hook inside the container.
 *  - cleanup: called only on terminal state — removes the container.
 *  - hooks (before_run/after_run): run inside the container via `docker exec`.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { shellEscape } from '../shell-utils.js';
import { spawnAsync } from '../spawn-async.js';
import type { Issue, WorkspaceRef, WorkspaceBackend } from '../types.js';
import type { Config, RepositoryConfig } from '../config/schema.js';
import { buildCloneUrl } from './clone-url.js';

const WORKSPACE_PATH = '/workspace';
const CONTAINER_PREFIX = 'symphony-';
const ENV_PASS_THROUGH = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'LINEAR_API_KEY',
  'JIRA_API_TOKEN',
  'JIRA_EMAIL',
  'JIRA_HOST',
  'BITBUCKET_API_TOKEN',
  'BITBUCKET_WORKSPACE',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID',
];

export class DockerWorkspaceBackend implements WorkspaceBackend {
  private readonly config: Config;
  private readonly repository?: RepositoryConfig;

  constructor(config: Config, repository?: RepositoryConfig) {
    this.config = config;
    this.repository = repository;
  }

  private get hooks() { return this.repository?.hooks; }
  private get hookTimeoutMs() { return this.hooks?.timeout_ms ?? 300_000; }

  async create(issue: Issue, _workerHost?: string): Promise<WorkspaceRef> {
    const name = containerName(issue);

    if (await containerExists(name)) {
      logger.info(`Reusing existing container for ${issueCtx(issue)}`, { container: name });
      return { workspace: WORKSPACE_PATH, containerName: name };
    }

    return this.startContainer(name, issue);
  }

  async runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    const command = this.hooks?.before_run;
    if (!command || command.trim() === '') return;
    if (!ref.containerName) return;

    await dockerExec(ref.containerName, command, this.hookTimeoutMs);
  }

  async runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    const command = this.hooks?.after_run;
    if (!command || command.trim() === '') return;
    if (!ref.containerName) return;

    await dockerExec(ref.containerName, command, this.hookTimeoutMs);
  }

  async cleanup(ref: WorkspaceRef, _issue: Issue): Promise<void> {
    const name = ref.containerName;
    if (!name) return;

    const command = this.hooks?.before_remove;
    if (command && command.trim() !== '') {
      try {
        await dockerExec(name, command, this.hookTimeoutMs);
      } catch (err) {
        logger.warn('before_remove hook failed', { container: name, error: String(err) });
      }
    }

    logger.info(`Removing container`, { container: name });
    const result = await spawnAsync('docker', ['rm', '-f', name], { timeoutMs: 30_000 });

    if (result.status !== 0) {
      logger.warn('Failed to remove container', {
        container: name,
        exit: result.status,
        stderr: result.stderr?.trim().slice(0, 500),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Container startup
  // ---------------------------------------------------------------------------

  private async startContainer(name: string, issue: Issue): Promise<WorkspaceRef> {
    const cfg = this.config.docker;

    logger.info(`Starting container for ${issueCtx(issue)}`, { container: name, image: cfg.image });

    const dockerArgs = [
      'run', '-d',
      '--name', name,
      '--workdir', WORKSPACE_PATH,
    ];

    // Resource limits
    if (cfg.memory) dockerArgs.push('--memory', cfg.memory);
    if (cfg.cpus) dockerArgs.push('--cpus', cfg.cpus);

    // Environment variables
    for (const envVar of ENV_PASS_THROUGH) {
      const value = process.env[envVar];
      if (value) dockerArgs.push('-e', `${envVar}=${value}`);
    }
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }

    dockerArgs.push(cfg.image, 'sleep', 'infinity');

    const result = await spawnAsync('docker', dockerArgs, { timeoutMs: 120_000 });

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new Error(`docker run failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
    }

    const ref: WorkspaceRef = { workspace: WORKSPACE_PATH, containerName: name };

    // Inject Claude credentials directly into the container (no file written to host disk).
    await injectClaudeCredentials(name, cfg.auth_mount);

    // Inject git credentials via credential.helper store (no token in git URLs).
    await injectGitCredentials(name);

    // after_create hook (runs after credentials, before clone — fatal on failure)
    const afterCreate = this.hooks?.after_create;
    if (afterCreate && afterCreate.trim() !== '') {
      logger.info(`Running after_create hook in container ${name} for ${issueCtx(issue)}`);
      await dockerExec(name, afterCreate, this.hookTimeoutMs);
    }

    // Auto-clone
    if (this.repository) {
      const cloneUrl = buildCloneUrl(this.repository);
      logger.info(`Cloning ${cloneUrl} into container ${name}`);
      await dockerExec(name, `git clone --depth 1 ${cloneUrl} .`, this.hookTimeoutMs);

      // after_clone hook
      if (this.hooks?.after_clone?.trim()) {
        await dockerExec(name, this.hooks.after_clone, this.hookTimeoutMs);
      }
    }

    return ref;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function dockerExec(
  containerName: string,
  command: string,
  timeoutMs: number,
): Promise<void> {
  const result = await spawnAsync(
    'docker',
    ['exec', '--user', 'worker', containerName, 'bash', '-lc', command],
    { timeoutMs },
  );

  if (result.status === 0) {
    return;
  } else if (result.timedOut || result.signal === 'SIGTERM') {
    throw new Error(`docker exec timed out after ${timeoutMs}ms: ${command}`);
  } else {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(`docker exec failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
  }
}

export async function containerExists(name: string): Promise<boolean> {
  const result = await spawnAsync('docker', ['inspect', '--format', '{{.Name}}', name], { timeoutMs: 10_000 });
  return result.status === 0;
}

function containerName(issue: Issue): string {
  return containerNameForIssue(issue);
}

export function containerNameForIssue(issue: Issue): string {
  const safe = issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
  return CONTAINER_PREFIX + safe;
}

/** List all running symphony containers, returning their names. */
export async function listSymphonyContainers(): Promise<string[]> {
  const result = await spawnAsync(
    'docker',
    ['ps', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
    { timeoutMs: 10_000 },
  );
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** Extract issue identifier from container name (reverse of containerNameForIssue). */
export function identifierFromContainerName(name: string): string | null {
  if (!name.startsWith(CONTAINER_PREFIX)) return null;
  return name.slice(CONTAINER_PREFIX.length);
}

export async function dockerExecRead(containerName: string, filePath: string): Promise<string | null> {
  const result = await spawnAsync(
    'docker', ['exec', '--user', 'worker', containerName, 'cat', filePath],
    { timeoutMs: 5_000 },
  );
  return result.status === 0 ? result.stdout : null;
}

export async function dockerExecWrite(containerName: string, filePath: string, content: string): Promise<void> {
  const result = await spawnAsync(
    'docker', ['exec', '--user', 'worker', '-i', containerName, 'bash', '-c', `cat > ${shellEscape(filePath)}`],
    { input: content, timeoutMs: 5_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to write ${filePath} in ${containerName}`);
  }
}

async function injectGitCredentials(container: string): Promise<void> {
  const lines: string[] = [];

  // GitHub
  const ghToken = process.env['GITHUB_TOKEN'];
  if (ghToken) {
    lines.push(`https://oauth2:${ghToken}@github.com`);
  }

  // Bitbucket
  const bbToken = process.env['BITBUCKET_API_TOKEN'];
  if (bbToken) {
    const bbUser = process.env['BITBUCKET_EMAIL'] || 'x-token-auth';
    lines.push(`https://${encodeURIComponent(bbUser)}:${encodeURIComponent(bbToken)}@bitbucket.org`);
  }

  if (lines.length === 0) {
    logger.info('No git credentials found in environment; skipping credential injection', { container });
    return;
  }

  const credContent = lines.join('\n') + '\n';
  const script =
    'git config --global credential.helper store && ' +
    'cat > /home/worker/.git-credentials && ' +
    'chmod 600 /home/worker/.git-credentials';

  const result = await spawnAsync(
    'docker',
    ['exec', '--user', 'worker', '-i', container, 'bash', '-c', script],
    { input: credContent, timeoutMs: 10_000 },
  );

  if (result.status !== 0) {
    logger.warn('Failed to inject git credentials into container', {
      container,
      stderr: result.stderr?.trim().slice(0, 200),
    });
  } else {
    logger.info('Injected git credentials into container', { container });
  }
}

async function injectClaudeCredentials(container: string, configuredAuthMount: string | undefined): Promise<void> {
  const json = readClaudeCredentials(configuredAuthMount);
  if (!json) {
    logger.warn('Claude credentials not found; container may not authenticate', { container });
    return;
  }

  // Write directly into the container via docker exec — nothing touches the host disk.
  const result = await spawnAsync(
    'docker',
    ['exec', '--user', 'worker', '-i', container, 'bash', '-c',
      'mkdir -p /home/worker/.claude && cat > /home/worker/.claude/.credentials.json && chmod 600 /home/worker/.claude/.credentials.json'],
    { input: json, timeoutMs: 10_000 },
  );

  if (result.status !== 0) {
    logger.warn('Failed to inject Claude credentials into container', {
      container,
      stderr: result.stderr?.trim().slice(0, 200),
    });
  } else {
    logger.info('Injected Claude credentials into container', { container });
  }
}

function readClaudeCredentials(configuredAuthMount: string | undefined): string | null {
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      logger.warn('Could not read Claude credentials from macOS Keychain; falling back to file');
    }
  }

  const dir = configuredAuthMount && configuredAuthMount.trim() !== ''
    ? (configuredAuthMount.startsWith('~') ? path.join(os.homedir(), configuredAuthMount.slice(1)) : configuredAuthMount)
    : path.join(os.homedir(), '.claude');

  const credFile = path.join(dir, '.credentials.json');
  try {
    return fs.readFileSync(credFile, 'utf8');
  } catch {
    return null;
  }
}
