import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

/**
 * The relay's only durable state (§3.6): which phone is authorized for which desktop,
 * with both Ed25519 public keys. Offers, pending phones and lastSeen live in memory.
 * A push gateway (§7.1) also keeps one generation counter per registered device.
 */

export interface Pair {
  desktopId: string
  phoneId: string
  /** b64u Ed25519 public key of the phone. */
  phonePub: string
  /** b64u Ed25519 public key of the desktop. */
  desktopPub: string
  /** Unix ms. */
  createdAt: number
}

export interface RelayStore {
  getPair(desktopId: string, phoneId: string): Pair | null
  /** Inserts or replaces the pair. */
  putPair(pair: Pair): void
  /** Returns whether a pair was deleted. */
  deletePair(desktopId: string, phoneId: string): boolean
  desktopsForPhone(phoneId: string): string[]
  phonesForDesktop(desktopId: string): string[]
  close(): void
}

/** §7.1 `push_devices`: the current push generation of each device. No tokens. */
export interface PushStore {
  /** The device's current generation, 0 if it never registered. */
  pushGeneration(deviceId: string): number
  /** A new registration: bumps the generation (first one is 1) and returns it. */
  bumpPushGeneration(deviceId: string, now: number): number
  /**
   * Retires `generation` if it is still the current one (APNs said the token is dead),
   * so a registration that raced ahead of it isn't invalidated. Returns whether it did.
   */
  retirePushGeneration(deviceId: string, generation: number, now: number): boolean
}

export class MemoryStore implements RelayStore, PushStore {
  readonly #pairs = new Map<string, Pair>()
  readonly #push = new Map<string, number>()

  #key(desktopId: string, phoneId: string): string {
    return `${desktopId}:${phoneId}`
  }

  getPair(desktopId: string, phoneId: string): Pair | null {
    const pair = this.#pairs.get(this.#key(desktopId, phoneId))
    return pair ? { ...pair } : null
  }

  putPair(pair: Pair): void {
    this.#pairs.set(this.#key(pair.desktopId, pair.phoneId), { ...pair })
  }

  deletePair(desktopId: string, phoneId: string): boolean {
    return this.#pairs.delete(this.#key(desktopId, phoneId))
  }

  desktopsForPhone(phoneId: string): string[] {
    return [...this.#pairs.values()].filter((p) => p.phoneId === phoneId).map((p) => p.desktopId)
  }

  phonesForDesktop(desktopId: string): string[] {
    return [...this.#pairs.values()].filter((p) => p.desktopId === desktopId).map((p) => p.phoneId)
  }

  pushGeneration(deviceId: string): number {
    return this.#push.get(deviceId) ?? 0
  }

  bumpPushGeneration(deviceId: string): number {
    const generation = this.pushGeneration(deviceId) + 1
    this.#push.set(deviceId, generation)
    return generation
  }

  retirePushGeneration(deviceId: string, generation: number): boolean {
    if (this.#push.get(deviceId) !== generation) return false
    this.#push.set(deviceId, generation + 1)
    return true
  }

  close(): void {}
}

interface PairRow {
  desktop_id: string
  phone_id: string
  phone_pub: string
  desktop_pub: string
  created_at: number
}

function rowToPair(row: PairRow): Pair {
  return {
    desktopId: row.desktop_id,
    phoneId: row.phone_id,
    phonePub: row.phone_pub,
    desktopPub: row.desktop_pub,
    createdAt: Number(row.created_at)
  }
}

/** `node:sqlite` at the given path (normally `$RELAY_DATA/relay.db`). */
export class SqliteStore implements RelayStore, PushStore {
  readonly #db: DatabaseSync
  readonly #get: StatementSync
  readonly #put: StatementSync
  readonly #delete: StatementSync
  readonly #byPhone: StatementSync
  readonly #byDesktop: StatementSync
  readonly #pushGet: StatementSync
  readonly #pushBump: StatementSync
  readonly #pushRetire: StatementSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS pairs (
        desktop_id  TEXT    NOT NULL,
        phone_id    TEXT    NOT NULL,
        phone_pub   TEXT    NOT NULL,
        desktop_pub TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (desktop_id, phone_id)
      );
      CREATE INDEX IF NOT EXISTS pairs_by_phone ON pairs (phone_id);
      CREATE TABLE IF NOT EXISTS push_devices (
        device_id  TEXT    PRIMARY KEY,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.#get = this.#db.prepare('SELECT * FROM pairs WHERE desktop_id = ? AND phone_id = ?')
    this.#put = this.#db.prepare(
      'INSERT OR REPLACE INTO pairs (desktop_id, phone_id, phone_pub, desktop_pub, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    this.#delete = this.#db.prepare('DELETE FROM pairs WHERE desktop_id = ? AND phone_id = ?')
    this.#byPhone = this.#db.prepare('SELECT desktop_id FROM pairs WHERE phone_id = ?')
    this.#byDesktop = this.#db.prepare('SELECT phone_id FROM pairs WHERE desktop_id = ?')
    this.#pushGet = this.#db.prepare('SELECT generation FROM push_devices WHERE device_id = ?')
    this.#pushBump = this.#db.prepare(
      `INSERT INTO push_devices (device_id, generation, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (device_id) DO UPDATE SET generation = generation + 1, updated_at = excluded.updated_at
       RETURNING generation`
    )
    this.#pushRetire = this.#db.prepare(
      'UPDATE push_devices SET generation = generation + 1, updated_at = ? WHERE device_id = ? AND generation = ?'
    )
  }

  getPair(desktopId: string, phoneId: string): Pair | null {
    const row = this.#get.get(desktopId, phoneId) as PairRow | undefined
    return row ? rowToPair(row) : null
  }

  putPair(pair: Pair): void {
    this.#put.run(pair.desktopId, pair.phoneId, pair.phonePub, pair.desktopPub, pair.createdAt)
  }

  deletePair(desktopId: string, phoneId: string): boolean {
    return Number(this.#delete.run(desktopId, phoneId).changes) > 0
  }

  desktopsForPhone(phoneId: string): string[] {
    return (this.#byPhone.all(phoneId) as Array<{ desktop_id: string }>).map((r) => r.desktop_id)
  }

  phonesForDesktop(desktopId: string): string[] {
    return (this.#byDesktop.all(desktopId) as Array<{ phone_id: string }>).map((r) => r.phone_id)
  }

  pushGeneration(deviceId: string): number {
    const row = this.#pushGet.get(deviceId) as { generation: number } | undefined
    return row ? Number(row.generation) : 0
  }

  bumpPushGeneration(deviceId: string, now: number): number {
    return Number((this.#pushBump.get(deviceId, now) as { generation: number }).generation)
  }

  retirePushGeneration(deviceId: string, generation: number, now: number): boolean {
    return Number(this.#pushRetire.run(now, deviceId, generation).changes) > 0
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close()
  }
}
