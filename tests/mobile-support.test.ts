import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { RevisionStore } from '../src/main/revision-store'
import { MAIN_OWNED_CONFIG_KEYS, sanitizeConfigUpdate } from '../src/main/ipc/config-sanitize'
import { Storage } from '../src/main/storage'
import {
  DEFAULT_MOBILE_RELAY_URL,
  isUnencryptedRemoteRelay,
  isValidRelayUrl,
  normalizeMobileConfig
} from '../src/shared/mobile'
import { DEFAULT_CONFIG } from '../src/shared/types'

describe('TabActivityRegistry change listener', () => {
  it('fires on status, activity and removal changes, not on no-ops', () => {
    const registry = new TabActivityRegistry(() => 10)
    const seen: string[] = []
    const unsubscribe = registry.subscribe((tabId) => seen.push(tabId))

    registry.touch('a')
    registry.touch('a') // already known
    registry.working('a')
    registry.working('a') // same status
    registry.applyHook('a', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    registry.applyHook('a', { unknown: true }) // not a hook event
    registry.remove('a')
    registry.remove('a') // already gone
    expect(seen).toEqual(['a', 'a', 'a', 'a'])

    unsubscribe()
    registry.working('b')
    expect(seen).toHaveLength(4)
  })

  it('exposes when the current status began', () => {
    let now = 5
    const registry = new TabActivityRegistry(() => now)
    expect(registry.getSince('a')).toBeNull()
    registry.touch('a')
    now = 9
    registry.working('a')
    expect(registry.getSince('a')).toBe(9)
  })

  it('a throwing listener does not break the registry', () => {
    const registry = new TabActivityRegistry()
    registry.subscribe(() => { throw new Error('boom') })
    expect(() => registry.working('a')).not.toThrow()
    expect(registry.getStatus('a')).toBe('working')
  })
})

describe('RevisionStore subscribe', () => {
  it('hands every commit to listeners until they unsubscribe', () => {
    const store = new RevisionStore<{ n: number }>({ initial: { n: 0 }, persist: () => {}, broadcast: () => {} })
    const seen: number[] = []
    const unsubscribe = store.subscribe((data) => seen.push(data.n))
    store.commit({ n: 1 })
    store.save(1, { n: 2 })
    store.save(0, { n: 99 }) // stale: refused, no commit
    unsubscribe()
    store.commit({ n: 3 })
    expect(seen).toEqual([1, 2])
  })
})

describe('mobile config', () => {
  it('validates relay URLs', () => {
    expect(isValidRelayUrl('wss://relay.devtool.awantech.sk')).toBe(true)
    expect(isValidRelayUrl('ws://localhost:8787')).toBe(true)
    expect(isValidRelayUrl('https://relay.example')).toBe(false)
    expect(isValidRelayUrl('wss://user:pw@relay.example')).toBe(false)
    expect(isValidRelayUrl('not a url')).toBe(false)
    expect(isValidRelayUrl('')).toBe(false)
    expect(isValidRelayUrl(42)).toBe(false)
  })

  it('flags ws:// relays that are not on this machine', () => {
    expect(isUnencryptedRemoteRelay('ws://relay.example.com')).toBe(true)
    expect(isUnencryptedRemoteRelay('ws://192.168.1.5:8787')).toBe(true)
    expect(isUnencryptedRemoteRelay('ws://localhost:8787')).toBe(false)
    expect(isUnencryptedRemoteRelay('ws://127.0.0.1:8787')).toBe(false)
    expect(isUnencryptedRemoteRelay('ws://[::1]:8787')).toBe(false)
    expect(isUnencryptedRemoteRelay('wss://relay.example.com')).toBe(false)
    expect(isUnencryptedRemoteRelay('nonsense')).toBe(false)
  })

  it('normalizes whatever config.json holds', () => {
    expect(normalizeMobileConfig(undefined)).toEqual({ enabled: false, relayUrl: DEFAULT_MOBILE_RELAY_URL })
    expect(normalizeMobileConfig({ enabled: 'yes', relayUrl: 'http://x' })).toEqual({ enabled: false, relayUrl: DEFAULT_MOBILE_RELAY_URL })
    expect(normalizeMobileConfig({ enabled: true, relayUrl: ' ws://localhost:8787/ ', desktopName: ' box ' }))
      .toEqual({ enabled: true, relayUrl: 'ws://localhost:8787', desktopName: 'box' })
  })

  it('is part of the default config, off', () => {
    expect(DEFAULT_CONFIG.mobile).toEqual({ enabled: false, relayUrl: DEFAULT_MOBILE_RELAY_URL })
  })

  it('sanitizes the mobile key and marks it main-owned', () => {
    expect(MAIN_OWNED_CONFIG_KEYS).toContain('mobile')
    expect(sanitizeConfigUpdate({ mobile: { enabled: true, relayUrl: 'ws://h:1' } }).config.mobile)
      .toEqual({ enabled: true, relayUrl: 'ws://h:1' })
    expect(sanitizeConfigUpdate({ mobile: { enabled: true, relayUrl: 'http://h' } }).rejectedKeys.map(r => r.key))
      .toEqual(['mobile'])
  })

  describe('Storage.loadConfig', () => {
    let dir: string | null = null
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

    it('fills in and repairs the mobile section', () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-mobile-config-'))
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mobile: { enabled: true, relayUrl: 'ftp://x' } }))
      expect(new Storage(dir).loadConfig().mobile).toEqual({ enabled: true, relayUrl: DEFAULT_MOBILE_RELAY_URL })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ fontSize: 12 }))
      expect(new Storage(dir).loadConfig().mobile).toEqual({ enabled: false, relayUrl: DEFAULT_MOBILE_RELAY_URL })
    })
  })
})
