/**
 * Docker 워크스페이스 백엔드 — 이슈별 컨테이너를 생성하거나 재사용합니다.
 * elixir/lib/symphony_elixir/workspace_backend/docker.ex 를 미러링합니다.
 *
 * 생명주기:
 *  - create: 기존 컨테이너가 있으면 재사용하고, 없으면 새로 시작한 뒤
 *    컨테이너 내부에서 after_create 훅을 실행합니다.
 *  - cleanup: 종료 상태에서만 호출되며 컨테이너를 제거합니다.
 *  - hooks (before_run/after_run): `docker exec`를 통해 컨테이너 내부에서 실행됩니다.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { logger } from '../logger.js';
import { issueCtx } from '../utils.js';
import { shellEscape } from '../shell-utils.js';
import { spawnAsync } from '../spawn-async.js';
import type { Issue, WorkspaceRef, WorkspaceBackend } from '../types.js';
import type { Config, RepositoryConfig, TrackerConfig } from '../config/schema.js';
import { buildCloneUrl } from './clone-url.js';

const WORKSPACE_PATH = '/workspace';
const CONTAINER_PREFIX = 'symphony-';
const ENV_PASS_THROUGH = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'LINEAR_API_KEY',
  'JIRA_API_TOKEN',
  'JIRA_EMAIL',
  'BITBUCKET_API_TOKEN',
  'BITBUCKET_WORKSPACE',
  'BITBUCKET_USERNAME',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID',
];

export class DockerWorkspaceBackend implements WorkspaceBackend {
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
    const name = containerName(issue);

    if (await containerExists(name)) {
      logger.debug(`Reusing existing container for ${issueCtx(issue)}`, { container: name });
      await injectClaudeCredentials(name, this.config.docker.auth_mount);
      await injectGitCredentials(name, this.repository);
      return { workspace: WORKSPACE_PATH, containerName: name };
    }

    return this.startContainer(name, issue, baseBranch);
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
  // 컨테이너 시작
  // ---------------------------------------------------------------------------

  private async startContainer(name: string, issue: Issue, baseBranch?: string): Promise<WorkspaceRef> {
    const cfg = this.config.docker;

    logger.info(`Starting container for ${issueCtx(issue)}`, { container: name, image: cfg.image });

    const dockerArgs = [
      'run', '-d',
      '--name', name,
      '--workdir', WORKSPACE_PATH,
    ];

    // 리소스 제한
    if (cfg.memory) dockerArgs.push('--memory', cfg.memory);
    if (cfg.cpus) dockerArgs.push('--cpus', cfg.cpus);

    // .claude/skills 읽기 전용 마운트 (서브 에이전트 및 리뷰용 스킬)
    const skillsDir = path.resolve('.claude/skills');
    if (fs.existsSync(skillsDir)) {
      dockerArgs.push('-v', `${skillsDir}:/home/worker/.claude/skills:ro`);
    }

    // .claude/agents 읽기 전용 마운트 (서브 에이전트 페르소나)
    const agentsDir = path.resolve('.claude/agents');
    if (fs.existsSync(agentsDir)) {
      dockerArgs.push('-v', `${agentsDir}:/home/worker/.claude/agents:ro`);
    }

    // 호스트 로그 디렉토리 마운트 — 컨테이너 제거 후에도 유지됨
    const logsDir = path.resolve('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    dockerArgs.push('-v', `${logsDir}:/logs`);

    // 환경 변수
    for (const envVar of ENV_PASS_THROUGH) {
      const value = process.env[envVar];
      if (value) dockerArgs.push('-e', `${envVar}=${value}`);
    }
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }

    // 레포별 credentials를 표준 이름으로 주입 (멀티레포 시 레포 config 우선)
    if (this.repository?.kind === 'bitbucket') {
      if (this.repository.api_token) dockerArgs.push('-e', `BITBUCKET_API_TOKEN=${this.repository.api_token}`);
      if (this.repository.email) dockerArgs.push('-e', `BITBUCKET_EMAIL=${this.repository.email}`);
      if (this.repository.username) dockerArgs.push('-e', `BITBUCKET_USERNAME=${this.repository.username}`);
    } else if (this.repository?.kind === 'github') {
      if (this.repository.token) dockerArgs.push('-e', `GITHUB_TOKEN=${this.repository.token}`);
    }

    // 트래커별 credentials를 표준 이름으로 주입 (멀티 트래커 시 트래커 config 우선)
    if (this.trackerConfig?.kind === 'jira') {
      const host = this.trackerConfig.host.replace(/\/$/, '');
      dockerArgs.push('-e', `JIRA_HOST=${host}`);
      if (this.trackerConfig.email) dockerArgs.push('-e', `JIRA_EMAIL=${this.trackerConfig.email}`);
      if (this.trackerConfig.api_token) dockerArgs.push('-e', `JIRA_API_TOKEN=${this.trackerConfig.api_token}`);
    } else if (this.trackerConfig?.kind === 'linear') {
      if (this.trackerConfig.api_key) dockerArgs.push('-e', `LINEAR_API_KEY=${this.trackerConfig.api_key}`);
    }

    dockerArgs.push(cfg.image, 'sleep', 'infinity');

    const result = await spawnAsync('docker', dockerArgs, { timeoutMs: 120_000 });

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new Error(`docker run failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
    }

    const ref: WorkspaceRef = { workspace: WORKSPACE_PATH, containerName: name };

    // Claude 자격증명을 컨테이너에 직접 주입 (호스트 디스크에는 파일을 기록하지 않음).
    await injectClaudeCredentials(name, cfg.auth_mount);

    // credential.helper store를 통해 git 자격증명 주입 (git URL에 토큰 포함하지 않음).
    await injectGitCredentials(name, this.repository);

    // after_create 훅 (자격증명 주입 후, 클론 전에 실행 — 실패 시 치명적 오류)
    const afterCreate = this.hooks?.after_create;
    if (afterCreate && afterCreate.trim() !== '') {
      logger.info(`Running after_create hook in container ${name} for ${issueCtx(issue)}`);
      await dockerExec(name, afterCreate, this.hookTimeoutMs);
    }

    // 자동 클론
    if (this.repository) {
      const cloneUrl = buildCloneUrl(this.repository);
      logger.info(`Cloning ${cloneUrl} into container ${name}${baseBranch ? ` (branch: ${baseBranch})` : ''}`);
      const branchFlag = baseBranch ? `--branch ${shellEscape(baseBranch)} ` : '';
      const cloneCmd = `if [ -d .git ]; then echo 'already cloned'; else find . -mindepth 1 -delete 2>/dev/null || true; git clone --depth 1 ${branchFlag}${shellEscape(cloneUrl)} .; fi`;
      await dockerExec(name, cloneCmd, this.hookTimeoutMs);

      // .claude/skills를 워크스페이스에 심볼릭 링크 (마운트 경로: /home/worker/.claude/skills)
      await dockerExec(name, `mkdir -p /workspace/.claude && test -d /home/worker/.claude/skills && ln -sf /home/worker/.claude/skills /workspace/.claude/skills || true`, 30_000);

      // after_clone hook
      if (this.hooks?.after_clone?.trim()) {
        await dockerExec(name, this.hooks.after_clone, this.hookTimeoutMs);
      }
    }

    return ref;
  }
}

// ---------------------------------------------------------------------------
// 헬퍼 함수
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

function containerName(issue: Pick<Issue, 'identifier'>): string {
  return containerNameForIssue(issue);
}

export function containerNameForIssue(issue: Pick<Issue, 'identifier'>): string {
  const safe = issue.identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
  return CONTAINER_PREFIX + safe;
}

/** 모든 symphony 컨테이너를 나열하고 이름을 반환합니다 (중지된 컨테이너 포함). */
export async function listSymphonyContainers(): Promise<string[]> {
  const result = await spawnAsync(
    'docker',
    ['ps', '-a', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
    { timeoutMs: 10_000 },
  );
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** 컨테이너가 실행 중인지 확인합니다. */
export async function isContainerRunning(name: string): Promise<boolean> {
  const result = await spawnAsync(
    'docker', ['inspect', '--format', '{{.State.Running}}', name],
    { timeoutMs: 10_000 },
  );
  return result.status === 0 && result.stdout.trim() === 'true';
}

/** 중지된 컨테이너를 재시작합니다. */
export async function restartStoppedContainer(name: string): Promise<boolean> {
  const result = await spawnAsync('docker', ['start', name], { timeoutMs: 30_000 });
  return result.status === 0;
}

/** 컨테이너 안의 잔존 claude 프로세스를 정리합니다. */
export async function killClaudeProcesses(name: string): Promise<void> {
  await spawnAsync(
    'docker', ['exec', '--user', 'worker', name, 'bash', '-c', 'pkill -f "claude" || true'],
    { timeoutMs: 10_000 },
  );
}

/**
 * 컨테이너 이름에서 이슈 식별자를 추출합니다 (containerNameForIssue의 역연산).
 * 표준 식별자([A-Z]+-[0-9]+)는 특수 문자가 없으므로 역연산이 성립한다.
 * 특수 문자가 '_'로 치환된 식별자는 원본 복원이 불가능하다.
 */
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
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (dir) {
    await spawnAsync(
      'docker', ['exec', '--user', 'worker', containerName, 'mkdir', '-p', dir],
      { timeoutMs: 5_000 },
    );
  }
  const result = await spawnAsync(
    'docker', ['exec', '--user', 'worker', '-i', containerName, 'bash', '-c', `cat > ${shellEscape(filePath)}`],
    { input: content, timeoutMs: 5_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to write ${filePath} in ${containerName}`);
  }
}

async function injectGitCredentials(container: string, repository?: RepositoryConfig): Promise<void> {
  const lines: string[] = [];

  // GitHub 자격증명: 레포 config 우선, 환경변수 폴백
  if (repository?.kind === 'github') {
    const token = repository.token ?? process.env['GITHUB_TOKEN'];
    if (token) lines.push(`https://oauth2:${token}@github.com`);
  } else {
    const ghToken = process.env['GITHUB_TOKEN'];
    if (ghToken) lines.push(`https://oauth2:${ghToken}@github.com`);
  }

  // Bitbucket 자격증명: git clone용 username 우선, 없으면 x-token-auth (Repository Access Token용).
  if (repository?.kind === 'bitbucket') {
    const token = repository.api_token ?? process.env['BITBUCKET_API_TOKEN'];
    if (token) {
      const username = repository.username ?? process.env['BITBUCKET_USERNAME'];
      const user = username ? encodeURIComponent(username) : 'x-token-auth';
      lines.push(`https://${user}:${encodeURIComponent(token)}@bitbucket.org`);
    }
  } else {
    const bbToken = process.env['BITBUCKET_API_TOKEN'];
    if (bbToken) {
      const bbUsername = process.env['BITBUCKET_USERNAME'];
      const user = bbUsername ? encodeURIComponent(bbUsername) : 'x-token-auth';
      lines.push(`https://${user}:${encodeURIComponent(bbToken)}@bitbucket.org`);
    }
  }

  if (lines.length === 0) {
    logger.info('No git credentials found in environment; skipping credential injection', { container });
    return;
  }

  // git user.name / user.email: GIT_USER_* 우선, Bitbucket 레포 설정 폴백
  const gitUserName =
    process.env['GIT_USER_NAME'] ??
    (repository?.kind === 'bitbucket' ? (repository.username ?? process.env['BITBUCKET_USERNAME']) : undefined);
  const gitUserEmail =
    process.env['GIT_USER_EMAIL'] ??
    (repository?.kind === 'bitbucket' ? (repository.email ?? process.env['BITBUCKET_EMAIL']) : undefined);

  const credContent = lines.join('\n') + '\n';
  const userConfigCmds = [
    ...(gitUserName ? [`git config --global user.name ${JSON.stringify(gitUserName)}`] : []),
    ...(gitUserEmail ? [`git config --global user.email ${JSON.stringify(gitUserEmail)}`] : []),
  ].join(' && ');
  const script =
    'git config --global credential.helper store && ' +
    'cat > /home/worker/.git-credentials && ' +
    'chmod 600 /home/worker/.git-credentials' +
    (userConfigCmds ? ` && ${userConfigCmds}` : '');

  const result = await spawnAsync(
    'docker',
    ['exec', '--user', 'worker', '-i', container, 'bash', '-c', script],
    { input: credContent, timeoutMs: 10_000 },
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim().slice(0, 200) ?? '';
    throw new Error(`Failed to inject git credentials into container (exit ${result.status}): ${stderr}`);
  }
  logger.info('Injected git credentials into container', { container });
}

export async function injectClaudeCredentials(container: string, configuredAuthMount: string | undefined): Promise<void> {
  const json = readClaudeCredentials(configuredAuthMount);
  if (!json) {
    logger.warn('Claude credentials not found; container may not authenticate', { container });
    return;
  }

  // docker exec를 통해 컨테이너에 직접 기록 — 호스트 디스크에는 아무것도 기록하지 않음.
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

/**
 * 특정 인증 디렉토리에서 Claude 자격증명을 주입합니다 (개발자별 오버라이드).
 * macOS Keychain을 건너뛰고 지정된 디렉토리의 .credentials.json을 직접 읽습니다.
 */
export async function injectClaudeCredentialsFromDir(
  container: string,
  authDir: string,
): Promise<void> {
  const dir = authDir.startsWith('~')
    ? path.join(os.homedir(), authDir.slice(1))
    : authDir;
  const credFile = path.join(dir, '.credentials.json');

  let json: string;
  try {
    json = fs.readFileSync(credFile, 'utf8');
  } catch {
    logger.warn(`Claude credentials not found at ${credFile}`, { container });
    return;
  }

  const result = await spawnAsync(
    'docker',
    ['exec', '--user', 'worker', '-i', container, 'bash', '-c',
      'mkdir -p /home/worker/.claude && cat > /home/worker/.claude/.credentials.json && chmod 600 /home/worker/.claude/.credentials.json'],
    { input: json, timeoutMs: 10_000 },
  );

  if (result.status !== 0) {
    logger.warn('Failed to inject Claude credentials from auth dir', {
      container, authDir,
      stderr: result.stderr?.trim().slice(0, 200),
    });
  } else {
    logger.info('Injected Claude credentials from auth dir', { container, authDir });
  }
}

export async function ensureDockerImage(config: Config): Promise<void> {
  const dockerfilePath = path.resolve('docker/Dockerfile');
  if (!fs.existsSync(dockerfilePath)) {
    logger.debug('docker/Dockerfile not found — skipping auto-build (external registry image assumed)');
    return;
  }

  const imageTag = config.docker.image;
  const currentHash = crypto.createHash('sha256').update(fs.readFileSync(dockerfilePath)).digest('hex');

  const inspectResult = await spawnAsync(
    'docker',
    ['image', 'inspect', '--format', '{{index .Config.Labels "symphony.dockerfile-hash"}}', imageTag],
    { timeoutMs: 10_000 },
  );

  const storedHash = inspectResult.status === 0 ? inspectResult.stdout.trim() || null : null;

  if (storedHash === currentHash) {
    logger.info(`Docker image ${imageTag} is up to date — skipping build`);
    return;
  }

  const reason = storedHash === null ? 'image not found or no hash label' : 'Dockerfile has changed';
  logger.info(`Building Docker image ${imageTag} (reason: ${reason})`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'build',
        '--no-cache',
        '--label', `symphony.dockerfile-hash=${currentHash}`,
        '-t', imageTag,
        '-f', dockerfilePath,
        '.',
      ],
      { stdio: 'inherit' },
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build failed (exit ${code})`));
    });
    child.on('error', reject);
  });

  logger.info(`Docker image ${imageTag} built successfully`);
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
