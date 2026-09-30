/**
 * Structured JSON logs, one object per line on stdout. Callers pass metadata only:
 * device IDs, IPs, codes and sizes. Frame `data`, tokens and signatures must never be
 * logged.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, string | number | boolean | null | undefined>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? '').toLowerCase()
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info'
}

export function createLogger(level: LogLevel, write: (line: string) => void = (line) => process.stdout.write(line + '\n')): Logger {
  const min = RANK[level]
  const emit = (lvl: LogLevel, event: string, fields?: LogFields): void => {
    if (RANK[lvl] < min) return
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...fields }))
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields)
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
