import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PairingsStore, type MobilePairing } from '../src/main/mobile/pairings-store'

function pairing(id: string, extra: Partial<MobilePairing> = {}): MobilePairing {
  return { id, name: `phone ${id}`, x25519Pub: `x${id}`, ed25519Pub: `e${id}`, pairedAt: 100, lastSeen: null, ...extra }
}

describe('PairingsStore', () => {
  let root: string
  let dir: string
  let file: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-pairings-'))
    dir = path.join(root, 'mobile')
    file = path.join(dir, 'pairings.json')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('starts empty and creates nothing on disk until something is stored', () => {
    const store = new PairingsStore(dir)
    expect(store.list()).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('adds, persists as a JSON array and reloads', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    store.add(pairing('b'))
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(Array.isArray(onDisk)).toBe(true)
    expect(onDisk.map((p: MobilePairing) => p.id)).toEqual(['a', 'b'])
    expect(new PairingsStore(dir).list()).toEqual([pairing('a'), pairing('b')])
  })

  it('replaces a pairing with the same id', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    store.add(pairing('a', { name: 'renamed', pairedAt: 200 }))
    expect(store.list()).toEqual([pairing('a', { name: 'renamed', pairedAt: 200 })])
  })

  it('removes and reports whether anything was removed', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    expect(store.remove('missing')).toBe(false)
    expect(store.remove('a')).toBe(true)
    expect(new PairingsStore(dir).list()).toEqual([])
  })

  it('touchLastSeen only moves forward', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    store.touchLastSeen('a', 500)
    store.touchLastSeen('a', 400)
    store.touchLastSeen('missing', 900)
    expect(new PairingsStore(dir).get('a')?.lastSeen).toBe(500)
  })

  it('stores, reloads and clears a push registration; drops a malformed one on load', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    const push = { cap: 'cap', key: 'AAAA', keyId: 'BBBB', kinds: ['permission' as const, 'done' as const] }
    expect(store.setPush('a', push)).toBe(true)
    expect(store.setPush('missing', push)).toBe(false)
    expect(new PairingsStore(dir).get('a')?.push).toEqual(push)
    expect(store.setPush('a', null)).toBe(true)
    expect(new PairingsStore(dir).get('a')).not.toHaveProperty('push')

    fs.writeFileSync(file, JSON.stringify([{ ...pairing('b'), push: { ...push, kinds: ['bogus'] } }]))
    const reloaded = new PairingsStore(dir).get('b')
    expect(reloaded).not.toBeNull()
    expect(reloaded).not.toHaveProperty('push')
  })

  it('hands out copies', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    store.list()[0].name = 'mutated'
    store.get('a')!.name = 'mutated'
    expect(store.get('a')?.name).toBe('phone a')
  })

  it('writes atomically, leaving no temp files behind', () => {
    const store = new PairingsStore(dir)
    store.add(pairing('a'))
    store.touchLastSeen('a', 1)
    expect(fs.readdirSync(dir)).toEqual(['pairings.json'])
  })

  it('drops malformed entries but keeps the good ones', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify([pairing('a'), { id: 'b' }, 'junk', pairing('c', { x25519Pub: 'bad key!' })]))
    expect(new PairingsStore(dir).list().map(p => p.id)).toEqual(['a'])
  })

  it('moves an unparseable file aside instead of overwriting it', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, '{not json')
    const logs: string[] = []
    const store = new PairingsStore(dir, (m) => logs.push(m))
    expect(store.list()).toEqual([])
    expect(logs.some(l => l.includes('corrupt'))).toBe(true)
    const names = fs.readdirSync(dir)
    expect(names.some(n => n.startsWith('pairings.json.corrupt-'))).toBe(true)
    expect(names).not.toContain('pairings.json')
  })
})
