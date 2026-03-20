/**
 * WorkspaceIO factory — creates the appropriate I/O backend
 * based on the configured workspace_backend.
 */

import { DockerWorkspaceIO } from './docker-io.js';
import { LocalWorkspaceIO } from './local-io.js';
import type { WorkspaceIO } from '../types.js';
import type { Config } from '../config/schema.js';

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
