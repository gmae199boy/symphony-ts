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

  async getDiff(ref: WorkspaceRef, base?: string): Promise<string | null> {
    const range = base ? `${base}..HEAD` : 'origin/main...HEAD';
    const proc = await spawnAsync('git', ['diff', range], {
      cwd: ref.workspace,
      timeoutMs: 30_000,
    });
    return proc.status === 0 ? proc.stdout : null;
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

  nameForIssue(issue: Issue): string {
    return issueDir(issue);
  }

  refForIssue(issue: Issue): WorkspaceRef {
    return { workspace: path.join(this.workspaceRoot, issueDir(issue)) };
  }

  refFromName(name: string): WorkspaceRef {
    return { workspace: path.join(this.workspaceRoot, name) };
  }
}
