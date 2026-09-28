import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../storage'

/** One paired phone. Keys are raw 32-byte public keys, base64url without padding. */
export interface MobilePairing {
  /** Device ID: hex of the first 16 bytes of SHA-256(ed25519Pub). */
  id: string
  name: string
  x25519Pub: string
  ed25519Pub: string
  pairedAt: number
  /** Epoch ms; null until the phone is seen after pairing. */
  lastSeen: number | null
}

const B64U = /^[A-Za-z0-9_-]+$/

function isPairing(value: unknown): value is MobilePairing {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string' && p.id.length > 0
    && typeof p.name === 'string'
    && typeof p.x25519Pub === 'string' && B64U.test(p.x25519Pub)
    && typeof p.ed25519Pub === 'string' && B64U.test(p.ed25519Pub)
    && typeof p.pairedAt === 'number' && Number.isFinite(p.pairedAt)
    && (p.lastSeen === null || p.lastSeen === undefined || (typeof p.lastSeen === 'number' && Number.isFinite(p.lastSeen)))
}

/**
 * `<configDir>/mobile/pairings.json`: the phones this desktop accepted. The relay
 * keeps its own copy of the (desktop, phone) pairs for routing, but only this file
 * says which Noise keys may resume a session.
 */
export class PairingsStore {
  private readonly file: string
  private readonly revokesFile: string
  private pairings: MobilePairing[]
  private revokes: string[]

  constructor(private readonly dir: string, private readonly log: (message: string) => void = () => {}) {
    this.file = path.join(dir, 'pairings.json')
    this.revokesFile = path.join(dir, 'pending-revokes.json')
    this.pairings = this.load()
    this.revokes = this.loadRevokes()
  }

  /**
   * Phones revoked here that the relay has not been told about (it was offline, or
   * Mobile was off). Separate file so pairings.json keeps its plain-array shape.
   */
  pendingRevokes(): string[] {
    return [...this.revokes]
  }

  setPendingRevoke(id: string, pending: boolean): void {
    const has = this.revokes.includes(id)
    if (has === pending) return
    this.revokes = pending ? [...this.revokes, id] : this.revokes.filter((r) => r !== id)
    fs.mkdirSync(this.dir, { recursive: true })
    atomicWriteFileSync(this.revokesFile, JSON.stringify(this.revokes, null, 2))
  }

  private loadRevokes(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.revokesFile, 'utf-8')) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) : []
    } catch {
      return []
    }
  }

  list(): MobilePairing[] {
    return this.pairings.map((p) => ({ ...p }))
  }

  get(id: string): MobilePairing | null {
    const found = this.pairings.find((p) => p.id === id)
    return found ? { ...found } : null
  }

  /** Adds, or replaces a pairing with the same id (the phone re-paired). */
  add(pairing: MobilePairing): void {
    this.pairings = [...this.pairings.filter((p) => p.id !== pairing.id), { ...pairing }]
    this.persist()
  }

  /** False when there was no such pairing. */
  remove(id: string): boolean {
    const next = this.pairings.filter((p) => p.id !== id)
    if (next.length === this.pairings.length) return false
    this.pairings = next
    this.persist()
    return true
  }

  touchLastSeen(id: string, at: number): void {
    const current = this.pairings.find((p) => p.id === id)
    if (!current || (current.lastSeen !== null && current.lastSeen >= at)) return
    this.pairings = this.pairings.map((p) => (p.id === id ? { ...p, lastSeen: at } : p))
    this.persist()
  }

  private load(): MobilePairing[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.log(`mobilePairings unreadable error=${String(err)}`)
      this.quarantine()
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) throw new Error('top-level JSON value is not an array')
      return parsed.filter(isPairing).map((p) => ({ ...p, lastSeen: p.lastSeen ?? null }))
    } catch (err) {
      this.log(`mobilePairings corrupt error=${String(err)}`)
      this.quarantine()
      return []
    }
  }

  /** Keep a bad file for manual recovery rather than overwriting it on the next save. */
  private quarantine(): void {
    try {
      fs.renameSync(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    } catch {
      // Nothing more to do; the next save replaces it.
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    atomicWriteFileSync(this.file, JSON.stringify(this.pairings, null, 2))
  }
}
