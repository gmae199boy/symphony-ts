/**
 * Async wrapper around child_process.spawn — replaces spawnSync to avoid
 * blocking the event loop during long-running operations (docker exec, hooks).
 */

import { spawn } from 'node:child_process';

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface SpawnAsyncOptions {
  /** Input to write to stdin. */
  input?: string;
  /** Working directory. */
  cwd?: string;
  /** Wall-clock timeout in milliseconds. */
  timeoutMs?: number;
  /** Encoding for stdout/stderr (always utf8). */
  encoding?: BufferEncoding;
  /** SIGTERM 전송 후 SIGKILL까지 대기할 시간 (ms). 미설정 시 SIGKILL 전송 안 함. */
  killTimeoutMs?: number;
  /** 자식 프로세스에 전달할 환경변수. 미설정 시 부모 process.env 상속. */
  env?: NodeJS.ProcessEnv;
}

export function spawnAsync(
  command: string,
  args: string[],
  options: SpawnAsyncOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs != null && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        if (options.killTimeoutMs != null && options.killTimeoutMs > 0) {
          setTimeout(() => child.kill('SIGKILL'), options.killTimeoutMs);
        }
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    if (options.input != null) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        signal: signal as NodeJS.Signals | null,
        timedOut,
      });
    });
  });
}
