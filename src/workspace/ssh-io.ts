/**
 * SSH 워크스페이스 I/O — 향후 SSH 원격 실행 지원을 위한 스텁입니다.
 */

import type { Issue, WorkspaceRef, WorkspaceIO } from '../types.js';

export class SshWorkspaceIO implements WorkspaceIO {
  readFile(_ref: WorkspaceRef, _relativePath: string): Promise<string | null> {
    throw new Error('SSH workspace IO not yet implemented');
  }
  writeFile(_ref: WorkspaceRef, _relativePath: string, _content: string): Promise<void> {
    throw new Error('SSH workspace IO not yet implemented');
  }
  getDiff(_ref: WorkspaceRef, _base?: string): Promise<string | null> {
    throw new Error('SSH workspace IO not yet implemented');
  }
  exists(_ref: WorkspaceRef): Promise<boolean> {
    throw new Error('SSH workspace IO not yet implemented');
  }
  list(): Promise<{ name: string; identifier: string }[]> {
    throw new Error('SSH workspace IO not yet implemented');
  }
  identifierFromName(_name: string): string | null {
    throw new Error('SSH workspace IO not yet implemented');
  }
  nameForIssue(_issue: Issue): string {
    throw new Error('SSH workspace IO not yet implemented');
  }
  refForIssue(_issue: Issue): WorkspaceRef {
    throw new Error('SSH workspace IO not yet implemented');
  }
  refFromName(_name: string): WorkspaceRef {
    throw new Error('SSH workspace IO not yet implemented');
  }
}
