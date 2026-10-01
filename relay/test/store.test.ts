import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { IpLimiter, TokenBucket } from '../src/rate.ts'
import { MemoryStore, SqliteStore } from '../src/store.ts'
import type { Pair, PushStore, RelayStore } from '../src/store.ts'
import { tempDir } from './helpers.ts'

const pair = (desktopId: string, phoneId: string, createdAt = 1): Pair => ({
  desktopId, phoneId, phonePub: `p-${phoneId}`, desktopPub: `d-${desktopId}`, createdAt
})

function exercise(store: RelayStore): void {
  expect(store.getPair('d1', 'p1')).toBeNull()
  store.putPair(pair('d1', 'p1'))
  store.putPair(pair('d1', 'p2'))
  store.putPair(pair('d2', 'p1'))
  store.putPair(pair('d1', 'p1', 5))
  expect(store.getPair('d1', 'p1')).toEqual(pair('d1', 'p1', 5))
  expect(store.phonesForDesktop('d1').sort()).toEqual(['p1', 'p2'])
  expect(store.desktopsForPhone('p1').sort()).toEqual(['d1', 'd2'])
  expect(store.deletePair('d1', 'p1')).toBe(true)
  expect(store.deletePair('d1', 'p1')).toBe(false)
  expect(store.desktopsForPhone('p1')).toEqual(['d2'])
}

function exercisePush(store: PushStore): void {
  expect(store.pushGeneration('p1')).toBe(0)
  expect(store.bumpPushGeneration('p1', 1)).toBe(1)
  expect(store.bumpPushGeneration('p1', 2)).toBe(2)
  expect(store.bumpPushGeneration('p2', 2)).toBe(1)
  expect(store.pushGeneration('p1')).toBe(2)
  expect(store.retirePushGeneration('p1', 1, 3)).toBe(false)
  expect(store.pushGeneration('p1')).toBe(2)
  expect(store.retirePushGeneration('p1', 2, 3)).toBe(true)
  expect(store.pushGeneration('p1')).toBe(3)
  expect(store.retirePushGeneration('nobody', 0, 3)).toBe(false)
}

describe('stores', () => {
  it('MemoryStore', () => {
    exercise(new MemoryStore())
    exercisePush(new MemoryStore())
  })

  it('SqliteStore, including reopening the file', () => {
    const dir = tempDir()
    try {
      const path = `${dir.path}/nested/relay.db`
      const store = new SqliteStore(path)
      exercise(store)
      exercisePush(store)
      store.close()
      const again = new SqliteStore(path)
      expect(again.pushGeneration('p1')).toBe(3)
      expect(again.getPair('d2', 'p1')).toEqual(pair('d2', 'p1'))
      expect(again.phonesForDesktop('d1')).toEqual(['p2'])
      again.close()
    } finally {
      dir.remove()
    }
  })
})

describe('rate limiting', () => {
  it('token bucket allows the burst, then the steady rate', () => {
    const bucket = new TokenBucket(50, 200, 0)
    let allowed = 0
    for (let i = 0; i < 300; i++) if (bucket.take(0)) allowed++
    expect(allowed).toBe(200)
    expect(bucket.take(10)).toBe(false)
    expect(bucket.take(20)).toBe(true)
    // Refill caps at the burst.
    let later = 0
    for (let i = 0; i < 300; i++) if (bucket.take(60_000)) later++
    expect(later).toBe(200)
  })

  it('IP limiter uses a sliding one-minute window', () => {
    const limiter = new IpLimiter(20)
    for (let i = 0; i < 20; i++) expect(limiter.admit('a', i)).toBe(true)
    expect(limiter.admit('a', 30_000)).toBe(false)
    expect(limiter.admit('b', 30_000)).toBe(true)
    expect(limiter.admit('a', 60_000)).toBe(false)
    expect(limiter.admit('a', 90_001)).toBe(true)
    limiter.prune(200_000)
    expect(limiter.size).toBe(0)
  })
})

describe('config', () => {
  it('has the documented defaults and reads the environment', () => {
    expect(loadConfig({})).toMatchObject({ port: 8787, host: '0.0.0.0', trustProxy: false, logLevel: 'info' })
    expect(loadConfig({}).dataDir).toMatch(/\/data$/)
    expect(loadConfig({ PORT: '9000', HOST: '127.0.0.1', RELAY_DATA: '/data', RELAY_TRUST_PROXY: '1', LOG_LEVEL: 'debug' })).toEqual({
      port: 9000, host: '127.0.0.1', dataDir: '/data', trustProxy: true, logLevel: 'debug',
      push: { role: 'forward', upstream: 'https://relay.devtool.awantech.sk' }
    })
    expect(() => loadConfig({ PORT: 'x' })).toThrow()
  })
})
