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
import { execFileSync, spawnSync } from 'node:child_process';

import { logger } from '../logger.js';
import type { Issue, WorkspaceRef, WorkspaceBackend } from '../types.js';
import type { Config } from '../config/schema.js';

const WORKSPACE_PATH = '/workspace';
const CONTAINER_PREFIX = 'symphony-';
const ENV_PASS_THROUGH = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'LINEAR_API_KEY',
  'JIRA_API_TOKEN',
  'JIRA_EMAIL',
  'JIRA_HOST',
  'BITBUCKET_EMAIL',
  'BITBUCKET_API_TOKEN',
  'BITBUCKET_WORKSPACE',
];

export class DockerWorkspaceBackend implements WorkspaceBackend {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async create(issue: Issue, _workerHost?: string): Promise<WorkspaceRef> {
    const name = containerName(issue);

    if (containerExists(name)) {
      logger.info(`Reusing existing container for ${issueCtx(issue)}`, { container: name });
      return { workspace: WORKSPACE_PATH, containerName: name };
    }

    return this.startContainer(name, issue);
  }

  async runBeforeRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    const command = this.config.hooks.before_run;
    if (!command || command.trim() === '') return;
    if (!ref.containerName) return;

    await dockerExec(ref.containerName, command, this.config.hooks.timeout_ms);
  }

  async runAfterRunHook(ref: WorkspaceRef, issue: Issue): Promise<void> {
    const command = this.config.hooks.after_run;
    if (!command || command.trim() === '') return;
    if (!ref.containerName) return;

    await dockerExec(ref.containerName, command, this.config.hooks.timeout_ms);
  }

  async cleanup(ref: WorkspaceRef, _issue: Issue): Promise<void> {
    const name = ref.containerName;
    if (!name) return;

    const command = this.config.hooks.before_remove;
    if (command && command.trim() !== '') {
      try {
        await dockerExec(name, command, this.config.hooks.timeout_ms);
      } catch (err) {
        logger.warn('before_remove hook failed', { container: name, error: String(err) });
      }
    }

    logger.info(`Removing container`, { container: name });
    const result = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', stdio: 'pipe' });

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

    const result = spawnSync('docker', dockerArgs, { encoding: 'utf8', stdio: 'pipe' });

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new Error(`docker run failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
    }

    const ref: WorkspaceRef = { workspace: WORKSPACE_PATH, containerName: name };

    // Inject Claude credentials directly into the container (no file written to host disk).
    await injectClaudeCredentials(name, cfg.auth_mount);

    // Run after_create hook
    const afterCreate = this.config.hooks.after_create;
    if (afterCreate && afterCreate.trim() !== '') {
      logger.info(`Running after_create hook in container ${name} for ${issueCtx(issue)}`);
      try {
        await dockerExec(name, afterCreate, this.config.hooks.timeout_ms);
      } catch (err) {
        logger.warn('after_create hook failed (non-fatal)', { container: name, error: String(err) });
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
  return new Promise((resolve, reject) => {
    const result = spawnSync(
      'docker',
      ['exec', '--user', 'worker', containerName, 'bash', '-lc', command],
      { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs },
    );

    if (result.status === 0) {
      resolve();
    } else if (result.error?.message.includes('ETIMEDOUT') || result.signal === 'SIGTERM') {
      reject(new Error(`docker exec timed out after ${timeoutMs}ms: ${command}`));
    } else {
      const stderr = result.stderr?.trim() ?? '';
      reject(new Error(`docker exec failed (exit ${result.status}): ${stderr.slice(0, 500)}`));
    }
  });
}

function containerExists(name: string): boolean {
  const result = spawnSync('docker', ['inspect', '--format', '{{.Name}}', name], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function containerName(issue: Issue): string {
  const safe = issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
  return CONTAINER_PREFIX + safe;
}

async function injectClaudeCredentials(container: string, configuredAuthMount: string | undefined): Promise<void> {
  const json = readClaudeCredentials(configuredAuthMount);
  if (!json) {
    logger.warn('Claude credentials not found; container may not authenticate', { container });
    return;
  }

  // Write directly into the container via docker exec — nothing touches the host disk.
  const result = spawnSync(
    'docker',
    ['exec', '--user', 'worker', '-i', container, 'bash', '-c',
      'mkdir -p /home/worker/.claude && cat > /home/worker/.claude/.credentials.json && chmod 600 /home/worker/.claude/.credentials.json'],
    { input: json, encoding: 'utf8', stdio: 'pipe' },
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

function issueCtx(issue: Issue): string {
  return `issue_id=${issue.id} issue_identifier=${issue.identifier}`;
}
