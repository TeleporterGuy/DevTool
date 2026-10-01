import { describe, expect, it } from 'vitest'
import { b64uEncode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, generateEd25519 } from './keys.ts'
import { parseClientMessage, parseServerMessage } from './relay-messages.ts'
import {
  openPushCap, openPushPayload, parsePushParams, parsePushRegisterRequest, pushPayloadKeyId, sealPushCap,
  sealPushPayload, signPushRegister, verifyPushRegister
} from './push.ts'
import type { PushPayload } from './push.ts'

const TOKEN = 'ab'.repeat(32)
const KEY = new Uint8Array(32).fill(7)
const KEY_ID = new Uint8Array(8).fill(9)
const PAYLOAD: PushPayload = { v: 1, kind: 'permission', desktop: 'd'.repeat(32), tab: 't', prompt: 'p', title: 'a / b', body: 'Bash · ls', at: 1 }

describe('push registration', () => {
  it('verifies a signed registration and names the device', () => {
    const phone = generateEd25519()
    const body = parsePushRegisterRequest(JSON.parse(JSON.stringify({ ...signPushRegister(phone.priv, phone.pub, TOKEN, 'production', 1000), extra: 1 })))
    expect(verifyPushRegister(body, 1000)).toBe(deviceId(phone.pub))
    expect(verifyPushRegister(body, 1000 + 300)).toBe(deviceId(phone.pub))
    expect(verifyPushRegister(body, 1000 + 301)).toBeNull()
    expect(verifyPushRegister({ ...body, token: 'cd'.repeat(32) }, 1000)).toBeNull()
    expect(verifyPushRegister({ ...body, env: 'sandbox' }, 1000)).toBeNull()
  })

  it('rejects malformed bodies', () => {
    const phone = generateEd25519()
    const good = signPushRegister(phone.priv, phone.pub, TOKEN, 'sandbox', 1)
    for (const bad of [null, { ...good, token: 'AB'.repeat(32) }, { ...good, token: 'ab'.repeat(31) }, { ...good, token: 'ab'.repeat(101) },
      { ...good, env: 'dev' }, { ...good, ts: -1 }, { ...good, pub: 'x' }, { ...good, sig: b64uEncode(new Uint8Array(10)) }]) {
      expect(() => parsePushRegisterRequest(bad)).toThrow(ProtocolError)
    }
  })
})

describe('push cap', () => {
  it('round-trips and refuses anything else', () => {
    const sealKey = new Uint8Array(32).fill(3)
    const payload = { d: 'e'.repeat(32), g: 2, t: TOKEN, e: 'production' as const }
    const cap = sealPushCap(sealKey, payload)
    expect(openPushCap(sealKey, cap)).toEqual(payload)
    expect(sealPushCap(sealKey, payload)).not.toBe(cap) // random nonce
    expect(openPushCap(new Uint8Array(32).fill(4), cap)).toBeNull()
    expect(openPushCap(sealKey, cap.slice(0, -2) + (cap.endsWith('AA') ? 'AB' : 'AA'))).toBeNull()
    expect(openPushCap(sealKey, '')).toBeNull()
    expect(openPushCap(sealKey, '!!')).toBeNull()
    expect(openPushCap(sealKey, 'A'.repeat(1025))).toBeNull()
  })
})

describe('push payload', () => {
  it('seals for one key only and names its key ID', () => {
    const data = sealPushPayload(KEY, KEY_ID, PAYLOAD)
    expect(pushPayloadKeyId(data)).toBe(b64uEncode(KEY_ID))
    expect(openPushPayload(KEY, data)).toEqual(PAYLOAD)
    expect(openPushPayload(new Uint8Array(32), data)).toBeNull()
    expect(openPushPayload(KEY, 'AAAA')).toBeNull()
    expect(pushPayloadKeyId('AAAA')).toBeNull()
  })

  it('cuts title and body and always fits the data limit', () => {
    const data = sealPushPayload(KEY, KEY_ID, { ...PAYLOAD, title: '🙂'.repeat(500), body: '\u0000'.repeat(5000) })
    expect(data.length).toBeLessThanOrEqual(3072)
    const opened = openPushPayload(KEY, data)!
    expect([...opened.title]).toHaveLength(120)
    expect(opened.title.endsWith('…')).toBe(true)
    expect([...opened.body].length).toBeLessThan(400)
  })
})

describe('push params', () => {
  it('parses register and unregister, drops unknown kinds, ignores other ops', () => {
    const params = { cap: 'c', key: b64uEncode(KEY), keyId: b64uEncode(KEY_ID), kinds: ['done', 'nope', 'permission'] }
    expect(parsePushParams('push.register', params)).toEqual({ ...params, kinds: ['permission', 'done'] })
    expect(parsePushParams('push.unregister', undefined)).toEqual({})
    expect(parsePushParams('chat.open', {})).toBeNull()
    for (const bad of [{ ...params, cap: '' }, { ...params, key: b64uEncode(KEY_ID) }, { ...params, keyId: b64uEncode(KEY) }, { ...params, kinds: 'done' }]) {
      expect(() => parsePushParams('push.register', bad)).toThrow(ProtocolError)
    }
  })
})

describe('push relay messages', () => {
  it('parses push from a client and pushed from the server', () => {
    const data = b64uEncode(new Uint8Array(40))
    expect(parseClientMessage(JSON.stringify({ t: 'push', id: 4, cap: 'c', data, x: 1 }))).toEqual({ t: 'push', id: 4, cap: 'c', data })
    expect(() => parseClientMessage(JSON.stringify({ t: 'push', id: 4, cap: '', data }))).toThrow(ProtocolError)
    expect(() => parseClientMessage(JSON.stringify({ t: 'push', id: 4, cap: 'c', data: 'A'.repeat(3073) }))).toThrow(ProtocolError)
    expect(parseServerMessage(JSON.stringify({ t: 'pushed', id: 4, result: 'gone' }))).toEqual({ t: 'pushed', id: 4, result: 'gone' })
    expect(parseServerMessage(JSON.stringify({ t: 'pushed', id: 4, result: 'future' }))).toEqual({ t: 'pushed', id: 4, result: 'future' })
  })
})
