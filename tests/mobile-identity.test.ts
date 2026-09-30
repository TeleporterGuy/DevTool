import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IdentityStore, type SecretEncryptor } from '../src/main/mobile/identity'
import { createInvite } from '../src/main/mobile/invite'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import {
  b64uDecode,
  b64uEncode,
  bytesEqual,
  decodePairingUri,
  derivePairProof,
  deriveRelayToken,
  deviceId,
  tokenHash
} from '../protocol/ts/index.ts'

/** Reversible and visibly not plaintext, so a test can tell the file was "encrypted". */
function fakeEncryptor(available = true): SecretEncryptor & { calls: number } {
  const enc = {
    calls: 0,
    isAvailable: () => available,
    encrypt: (plaintext: string) => { enc.calls++; return Buffer.from(`ENC:${Buffer.from(plaintext).toString('hex')}`) },
    decrypt: (ciphertext: Buffer) => {
      enc.calls++
      const text = ciphertext.toString()
      if (!text.startsWith('ENC:')) throw new Error('not ours')
      return Buffer.from(text.slice(4), 'hex').toString()
    }
  }
  return enc
}

describe('IdentityStore', () => {
  let root: string
  let dir: string
  let file: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-identity-'))
    dir = path.join(root, 'mobile')
    file = path.join(dir, 'identity.json')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('touches nothing until first used', () => {
    const encryptor = fakeEncryptor()
    const store = new IdentityStore(dir, encryptor)
    expect(store.peekId()).toBeNull()
    expect(fs.existsSync(dir)).toBe(false)
    expect(encryptor.calls).toBe(0)
  })

  it('creates an identity once, encrypted, with mode 0600, and reloads the same keys', () => {
    const store = new IdentityStore(dir, fakeEncryptor())
    const identity = store.get()
    expect(identity.id).toBe(deviceId(identity.ed25519.pub))
    expect(store.get()).toBe(identity)
    expect(store.peekId()).toBe(identity.id)

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(onDisk.enc).toBe('safeStorage')
    expect(JSON.stringify(onDisk)).not.toContain(b64uEncode(identity.x25519.priv))
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    const again = new IdentityStore(dir, fakeEncryptor()).get()
    expect(again.id).toBe(identity.id)
    expect(bytesEqual(again.x25519.priv, identity.x25519.priv)).toBe(true)
    expect(bytesEqual(again.x25519.pub, identity.x25519.pub)).toBe(true)
  })

  it('falls back to an unencrypted 0600 file when safeStorage is unavailable', () => {
    const logs: string[] = []
    const identity = new IdentityStore(dir, fakeEncryptor(false), (m) => logs.push(m)).get()
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(onDisk).toMatchObject({ enc: 'none', x25519Priv: b64uEncode(identity.x25519.priv) })
    expect(logs.some(l => l.includes('unencrypted'))).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(new IdentityStore(dir, fakeEncryptor(false)).get().id).toBe(identity.id)
  })

  it('moves an unreadable identity aside and starts over', () => {
    const first = new IdentityStore(dir, fakeEncryptor()).get()
    const broken: SecretEncryptor = { ...fakeEncryptor(), decrypt: () => { throw new Error('keychain says no') } }
    const second = new IdentityStore(dir, broken).get()
    expect(second.id).not.toBe(first.id)
    expect(fs.readdirSync(dir).some(n => n.startsWith('identity.json.unreadable-'))).toBe(true)
  })
})

describe('createInvite', () => {
  it('builds a §2 pairing URI with this desktop keys and matching derivations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-invite-'))
    try {
      const identity = new IdentityStore(root, fakeEncryptor()).get()
      const secret = new Uint8Array(32).fill(3)
      const invite = createInvite(identity, { relayUrl: 'ws://localhost:8787', desktopName: 'box', now: 1_790_000_000_500 }, () => secret)
      expect(invite.exp).toBe(1_790_000_300)
      const payload = decodePairingUri(invite.uri)
      expect(payload).toEqual({
        v: 1,
        relay: 'ws://localhost:8787',
        id: identity.id,
        x: b64uEncode(identity.x25519.pub),
        e: b64uEncode(identity.ed25519.pub),
        s: b64uEncode(secret),
        n: 'box',
        exp: 1_790_000_300
      })
      expect(invite.tokenHash).toBe(b64uEncode(tokenHash(deriveRelayToken(secret))))
      expect(bytesEqual(invite.pairProof, derivePairProof(secret))).toBe(true)
      // A fresh secret each time by default.
      const other = createInvite(identity, { relayUrl: 'ws://localhost:8787', desktopName: 'box', now: 0 })
      expect(b64uDecode(decodePairingUri(other.uri).s)).not.toEqual(secret)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('PairingsStore pending revokes', () => {
  it('persists across instances in its own file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-revokes-'))
    try {
      const id = 'a'.repeat(32)
      const store = new PairingsStore(root)
      store.setPendingRevoke(id, true)
      store.setPendingRevoke(id, true)
      expect(new PairingsStore(root).pendingRevokes()).toEqual([id])
      expect(JSON.parse(fs.readFileSync(path.join(root, 'pending-revokes.json'), 'utf-8'))).toEqual([id])
      store.setPendingRevoke(id, false)
      expect(new PairingsStore(root).pendingRevokes()).toEqual([])
      expect(fs.existsSync(path.join(root, 'pairings.json'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
