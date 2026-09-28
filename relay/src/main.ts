#!/usr/bin/env node
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { createLogger } from './log.ts'
import { startRelayServer } from './server.ts'
import { SqliteStore } from './store.ts'

/**
 * Entry point: `node src/main.ts` (Node >= 24 strips the types itself; no build step).
 * Configuration comes from the environment, see README.md.
 */

const config = loadConfig()
const log = createLogger(config.logLevel)
const dbPath = join(config.dataDir, 'relay.db')
const store = new SqliteStore(dbPath)

const server = await startRelayServer({
  store,
  port: config.port,
  host: config.host,
  trustProxy: config.trustProxy,
  logger: log
})
log.info('listening', { host: config.host, port: server.port, db: dbPath, trustProxy: config.trustProxy })

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info('shutting-down', { signal })
  const hard = setTimeout(() => {
    log.warn('shutdown-timeout')
    process.exit(1)
  }, 10_000)
  hard.unref()
  try {
    await server.close()
  } finally {
    store.close()
    log.info('stopped')
    process.exit(0)
  }
}

process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
process.on('uncaughtException', (err) => {
  log.error('uncaught', { error: err.message, stack: err.stack })
  process.exit(1)
})
