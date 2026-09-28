import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

/**
 * The relay's only durable state (§3.6): which phone is authorized for which desktop,
 * with both Ed25519 public keys. Offers, pending phones and lastSeen live in memory.
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

export class MemoryStore implements RelayStore {
  readonly #pairs = new Map<string, Pair>()

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
export class SqliteStore implements RelayStore {
  readonly #db: DatabaseSync
  readonly #get: StatementSync
  readonly #put: StatementSync
  readonly #delete: StatementSync
  readonly #byPhone: StatementSync
  readonly #byDesktop: StatementSync

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
    `)
    this.#get = this.#db.prepare('SELECT * FROM pairs WHERE desktop_id = ? AND phone_id = ?')
    this.#put = this.#db.prepare(
      'INSERT OR REPLACE INTO pairs (desktop_id, phone_id, phone_pub, desktop_pub, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    this.#delete = this.#db.prepare('DELETE FROM pairs WHERE desktop_id = ? AND phone_id = ?')
    this.#byPhone = this.#db.prepare('SELECT desktop_id FROM pairs WHERE phone_id = ?')
    this.#byDesktop = this.#db.prepare('SELECT phone_id FROM pairs WHERE desktop_id = ?')
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

  close(): void {
    if (this.#db.isOpen) this.#db.close()
  }
}
