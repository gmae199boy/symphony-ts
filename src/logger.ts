/**
 * 구조화된 로거 — Elixir Logger 기본 형식과 동일:
 *
 *   HH:MM:SS.mmm [level] message
 *   HH:MM:SS.mmm [level] message {"key":"value"}
 *
 * error는 stderr, 나머지는 stdout에 출력.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 호출별 비동기 컨텍스트 — 현재 이슈 식별자를 전달. */
export const logContext = new AsyncLocalStorage<{ identifier: string }>();

export interface LogSink {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

const fileSinks: LogSink[] = [];

export function addFileSink(s: LogSink): void { fileSinks.push(s); }
export function removeFileSink(s: LogSink): void {
  const i = fileSinks.indexOf(s);
  if (i >= 0) fileSinks.splice(i, 1);
}

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const minLevel = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? 1;

// ---------------------------------------------------------------------------
// 이슈 식별자용 ANSI 색상
// ---------------------------------------------------------------------------

const ANSI_COLORS = [
  '\x1b[36m',  // 시안
  '\x1b[32m',  // 초록
  '\x1b[35m',  // 마젠타
  '\x1b[34m',  // 파랑
  '\x1b[33m',  // 노랑
  '\x1b[31m',  // 빨강
  '\x1b[96m',  // 밝은 시안
  '\x1b[92m',  // 밝은 초록
  '\x1b[95m',  // 밝은 마젠타
  '\x1b[93m',  // 밝은 노랑
];
const ANSI_RESET = '\x1b[0m';
const LEVEL_COLORS: Partial<Record<LogLevel, string>> = {
  error: '\x1b[31m',
  warning: '\x1b[33m',
};

const issueColorCache = new Map<string, string>();

function colorForIssue(identifier: string): string {
  let color = issueColorCache.get(identifier);
  if (!color) {
    let hash = 0;
    for (let i = 0; i < identifier.length; i++) {
      hash = ((hash << 5) - hash + identifier.charCodeAt(i)) | 0;
    }
    color = ANSI_COLORS[Math.abs(hash) % ANSI_COLORS.length];
    if (issueColorCache.size >= 500) {
      const firstKey = issueColorCache.keys().next().value;
      if (firstKey !== undefined) issueColorCache.delete(firstKey);
    }
    issueColorCache.set(identifier, color);
  }
  return color;
}

// ---------------------------------------------------------------------------
// 포맷팅
// ---------------------------------------------------------------------------

export function formatLogLine(level: string, message: string, meta?: Record<string, unknown>): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const ts = `${hh}:${mm}:${ss}.${ms}`;
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level}] ${message}${metaStr}\n`;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;

  // ANSI 색상을 적용하여 stderr에 출력
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const ts = `${hh}:${mm}:${ss}.${ms}`;
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';

  const levelColor = LEVEL_COLORS[level] ?? '';
  const levelReset = levelColor ? ANSI_RESET : '';

  const identifier = logContext.getStore()?.identifier;
  const issuePrefix = identifier
    ? `${colorForIssue(identifier)}[${identifier}]${ANSI_RESET} `
    : '';

  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(`${ts} ${levelColor}[${level}]${levelReset} ${issuePrefix}${message}${metaStr}\n`);

  // 파일 싱크에는 색상 없는 일반 출력 전달
  for (const fs of fileSinks) fs.log(level, message, meta);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug',   msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => log('info',    msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warning', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error',   msg, meta),
};
