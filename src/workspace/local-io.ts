/**
 * 로컬 워크스페이스 I/O — 호스트 파일시스템의 파일을 읽고 씁니다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnAsync } from '../spawn-async.js';
import { issueDir } from './local.js';
import type { Issue, WorkspaceRef, WorkspaceIO } from '../types.js';

export class LocalWorkspaceIO implements WorkspaceIO {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async readFile(ref: WorkspaceRef, relativePath: string): Promise<string | null> {
    const fullPath = path.join(ref.workspace, relativePath);
    try {
      return await fs.promises.readFile(fullPath, 'utf8');
    } catch {
      return null;
    }
  }

  async writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(ref.workspace, relativePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, 'utf8');
  }

  async getDiff(ref: WorkspaceRef, base?: string, baseBranch?: string): Promise<string | null> {
    // base가 없는 fallback 경로는 base_commit이 없는 경우에만 사용됨.
    // baseBranch가 설정된 경우 해당 브랜치 기준으로 diff를 계산하고,
    // 없으면 origin/main으로 폴백 (하위 호환성 유지).
    const fallback = baseBranch ? `origin/${baseBranch}...HEAD` : 'origin/main...HEAD';
    const range = base ? `${base}..HEAD` : fallback;
    const proc = await spawnAsync('git', ['diff', range], {
      cwd: ref.workspace,
      timeoutMs: 30_000,
    });
    return proc.status === 0 ? proc.stdout : null;
  }

  async getCommitHash(ref: WorkspaceRef): Promise<string | null> {
    const proc = await spawnAsync('git', ['rev-parse', 'HEAD'], {
      cwd: ref.workspace,
      timeoutMs: 10_000,
    });
    return proc.status === 0 ? proc.stdout.trim() : null;
  }

  async exists(ref: WorkspaceRef): Promise<boolean> {
    return fs.existsSync(ref.workspace);
  }

  async list(): Promise<{ name: string; identifier: string }[]> {
    try {
      const entries = await fs.promises.readdir(this.workspaceRoot);
      return entries
        .filter((name) => {
          const fullPath = path.join(this.workspaceRoot, name);
          return fs.statSync(fullPath).isDirectory();
        })
        .map((name) => ({ name, identifier: name }));
    } catch {
      return [];
    }
  }

  identifierFromName(name: string): string | null {
    return name || null;
  }

  nameForIssue(issue: Pick<Issue, 'identifier'>): string {
    return issueDir(issue);
  }

  refForIssue(issue: Pick<Issue, 'identifier'>): WorkspaceRef {
    return { workspace: path.join(this.workspaceRoot, issueDir(issue)) };
  }

  refFromName(name: string): WorkspaceRef {
    return { workspace: path.join(this.workspaceRoot, name) };
  }
}
