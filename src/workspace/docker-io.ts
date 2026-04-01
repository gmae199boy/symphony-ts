/**
 * Docker 워크스페이스 I/O — Docker 컨테이너 내부의 파일을 읽고 씁니다.
 */

import { spawnAsync } from '../spawn-async.js';
import {
  containerExists,
  containerNameForIssue,
  listSymphonyContainers,
  identifierFromContainerName,
  dockerExecRead,
  dockerExecWrite,
} from './docker.js';
import type { Issue, WorkspaceRef, WorkspaceIO } from '../types.js';

export class DockerWorkspaceIO implements WorkspaceIO {
  async readFile(ref: WorkspaceRef, relativePath: string): Promise<string | null> {
    if (!ref.containerName) return null;
    const fullPath = `/workspace/${relativePath}`;
    return dockerExecRead(ref.containerName, fullPath);
  }

  async writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void> {
    if (!ref.containerName) throw new Error('DockerWorkspaceIO: containerName required');
    const fullPath = `/workspace/${relativePath}`;
    await dockerExecWrite(ref.containerName, fullPath, content);
  }

  async getDiff(ref: WorkspaceRef, base?: string): Promise<string | null> {
    if (!ref.containerName) return null;
    const range = base ? `${base}..HEAD` : 'origin/main...HEAD';
    const proc = await spawnAsync('docker', [
      'exec', '--user', 'worker', ref.containerName,
      'bash', '-lc', `cd /workspace && git diff ${range}`,
    ], { timeoutMs: 30_000 });
    return proc.status === 0 ? proc.stdout : null;
  }

  async exists(ref: WorkspaceRef): Promise<boolean> {
    if (!ref.containerName) return false;
    return containerExists(ref.containerName);
  }

  async list(): Promise<{ name: string; identifier: string }[]> {
    const names = await listSymphonyContainers();
    return names
      .map((name) => ({ name, identifier: identifierFromContainerName(name) ?? '' }))
      .filter((e) => e.identifier !== '');
  }

  identifierFromName(name: string): string | null {
    return identifierFromContainerName(name);
  }

  nameForIssue(issue: Issue): string {
    return containerNameForIssue(issue);
  }

  refForIssue(issue: Issue): WorkspaceRef {
    return { workspace: '/workspace', containerName: containerNameForIssue(issue) };
  }

  refFromName(name: string): WorkspaceRef {
    return { workspace: '/workspace', containerName: name };
  }
}
