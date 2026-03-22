/**
 * Agent backend factory — creates the appropriate agent backend
 * based on the agent config kind.
 */

import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';
import type { AgentBackend } from '../types.js';
import type { AgentConfig } from '../config/schema.js';

export function createAgentBackend(config: AgentConfig): AgentBackend {
  switch (config.kind) {
    case 'claude':
      return new ClaudeBackend(config);
    case 'codex':
      return new CodexBackend(config);
    default:
      throw new Error(`Unknown agent kind: ${(config as { kind: string }).kind}`);
  }
}
