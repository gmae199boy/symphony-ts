/**
 * File-based session ID persistence for Claude --resume support.
 * Mirrors the session_file_path/load_session_id/save_session_id/clear_session_id
 * functions in elixir/lib/symphony_elixir/agent_runner.ex
 *
 * Session files are stored in /tmp/symphony_sessions/<identifier>.session_id
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../logger.js';

const SESSION_DIR = path.join(os.tmpdir(), 'symphony_sessions');

function sessionFilePath(identifier: string): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return path.join(SESSION_DIR, `${identifier}.session_id`);
}

export function loadSessionId(identifier: string): string | null {
  try {
    const p = sessionFilePath(identifier);
    const content = fs.readFileSync(p, 'utf8').trim();
    return content === '' ? null : content;
  } catch {
    return null;
  }
}

export function saveSessionId(identifier: string, sessionId: string | null): void {
  if (!sessionId || sessionId.trim() === '') return;

  try {
    fs.writeFileSync(sessionFilePath(identifier), sessionId, 'utf8');
  } catch (err) {
    logger.warn('Failed to save session ID', { identifier, error: String(err) });
  }
}

export function clearSessionId(identifier: string): void {
  try {
    fs.rmSync(sessionFilePath(identifier));
  } catch {
    // ignore — file may not exist
  }
}
