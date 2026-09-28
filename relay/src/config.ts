import { resolve } from 'node:path'
import { parseLogLevel } from './log.ts'
import type { LogLevel } from './log.ts'

export interface RelayConfig {
  port: number
  host: string
  /** Directory holding relay.db. */
  dataDir: string
  trustProxy: boolean
  logLevel: LogLevel
}

/** Reads PORT, HOST, RELAY_DATA, RELAY_TRUST_PROXY and LOG_LEVEL. */
export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const port = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env.PORT}`)
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: resolve(env.RELAY_DATA || './data'),
    trustProxy: env.RELAY_TRUST_PROXY === '1' || env.RELAY_TRUST_PROXY === 'true',
    logLevel: parseLogLevel(env.LOG_LEVEL)
  }
}
