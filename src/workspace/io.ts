/**
 * Workspace factories — creates the appropriate I/O and lifecycle backends
 * based on the configured workspace_backend.
 */

import { DockerWorkspaceIO } from './docker-io.js';
import { LocalWorkspaceIO } from './local-io.js';
import { DockerWorkspaceBackend } from './docker.js';
import { LocalWorkspaceBackend } from './local.js';
import type { WorkspaceIO, WorkspaceBackend } from '../types.js';
import type { Config, RepositoryConfig } from '../config/schema.js';

export function createWorkspaceIO(config: Config): WorkspaceIO {
  switch (config.workspace_backend) {
    case 'docker':
      return new DockerWorkspaceIO();
    case 'local':
      return new LocalWorkspaceIO(config.workspace.root);
    default:
      throw new Error(`Unknown workspace backend: ${config.workspace_backend}`);
  }
}

export function createWorkspaceBackend(config: Config, repository?: RepositoryConfig): WorkspaceBackend {
  switch (config.workspace_backend) {
    case 'docker':
      return new DockerWorkspaceBackend(config, repository);
    case 'local':
      return new LocalWorkspaceBackend(config, repository);
    default:
      throw new Error(`Unknown workspace backend: ${config.workspace_backend}`);
  }
}
