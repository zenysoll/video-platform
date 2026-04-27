/**
 * Structured JSON logger for Cloudflare Workers.
 *
 * Rules:
 * - Never accepts env or any value that could contain secrets.
 * - Context objects are typed Record<string, unknown> — no string interpolation of secrets.
 * - In production: strict JSON, one object per line (compatible with CF Logpush).
 * - In development: prettified output.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogContext {
  [key: string]: unknown;
}

let configuredLevel: LogLevel = 'info';

export function configureLogger(level: LogLevel): void {
  configuredLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return (LEVELS[level] ?? 0) >= (LEVELS[configuredLevel] ?? 1);
}

function write(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (!shouldLog(level)) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  };

  const line = JSON.stringify(entry);

  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => write('debug', msg, ctx),
  info:  (msg: string, ctx?: LogContext) => write('info',  msg, ctx),
  warn:  (msg: string, ctx?: LogContext) => write('warn',  msg, ctx),
  error: (msg: string, ctx?: LogContext) => write('error', msg, ctx),
};
