/**
 * Structured logger — format matches Elixir Logger default:
 *
 *   HH:MM:SS.mmm [level] message
 *   HH:MM:SS.mmm [level] message {"key":"value"}
 *
 * Writes to stderr (same as Elixir Logger).
 */

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const ts = `${hh}:${mm}:${ss}.${ms}`;
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stderr.write(`${ts} [${level}] ${message}${metaStr}\n`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug',   msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => log('info',    msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warning', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error',   msg, meta),
};
