import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

/**
 * One running DevTool per config dir. Saves write full snapshots of projects.json
 * (last writer wins), so a second instance on the same dir silently drops the first
 * one's changes.
 *
 * Why not `app.requestSingleInstanceLock()`: Electron keys that lock on userData,
 * and userData is `<appData>/devtool` for dev runs and `<appData>/DevTool` for the
 * packaged app — the same directory on macOS's case-insensitive filesystem. The
 * Electron lock would stop a dev instance from running beside the packaged app, and
 * would not separate DEVTOOL_CONFIG_DIR overrides. Moving userData per config dir
 * would strand existing cookies/localStorage (browser-tab logins live there), so the
 * lock lives in the config dir instead:
 *
 * - `<config dir>/instance.lock` holds `{ pid, socket }`, created with O_EXCL.
 * - The owner listens on `socket` (a Unix socket, or a named pipe on Windows). A
 *   second launch connects, sends "focus", and exits; the owner raises its window.
 * - A lock is stale when its pid is gone, or when nothing answers on its socket and
 *   the lock is older than a few seconds (a crash followed by pid reuse, or a lock
 *   left behind by a hung process). Stale locks are taken over.
 */

const LOCK_FILE = 'instance.lock'
const STARTUP_GRACE_MS = 10_000
const CONNECT_TIMEOUT_MS = 1_500

interface LockContents {
  pid: number
  socket: string
}

export type InstanceLockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; ownerPid: number | null }

export function instanceSocketPath(configDir: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(configDir).toLowerCase()).digest('hex').slice(0, 16)
  if (process.platform === 'win32') return `\\\\.\\pipe\\devtool-${hash}`
  // Unix socket paths are capped near 104 bytes, so the config dir itself can be too long.
  const inDir = path.join(configDir, 'instance.sock')
  return Buffer.byteLength(inDir) < 100 ? inDir : path.join(os.tmpdir(), `devtool-${hash}.sock`)
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(lockPath: string): LockContents | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockContents>
    if (typeof parsed.pid === 'number' && typeof parsed.socket === 'string') {
      return { pid: parsed.pid, socket: parsed.socket }
    }
  } catch {
    // unreadable / half-written
  }
  return null
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return Infinity
  }
}

/** Resolves true when the owner accepted the message. */
function sendToOwner(socket: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socket)
    const timer = setTimeout(() => {
      client.destroy()
      resolve(false)
    }, CONNECT_TIMEOUT_MS)
    client.once('connect', () => {
      client.end(`${message}\n`, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    client.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function listen(socket: string, onFocusRequest: () => void): Promise<net.Server | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      // We own the lock, so any socket file here is a leftover from a dead owner.
      try { fs.unlinkSync(socket) } catch { /* none */ }
    }
    const server = net.createServer((conn) => {
      let buffer = ''
      conn.setEncoding('utf-8')
      conn.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 1024) conn.destroy()
      })
      conn.on('end', () => {
        if (buffer.trim() === 'focus') onFocusRequest()
      })
      conn.on('error', () => {})
    })
    server.once('error', (err) => {
      // The lock still protects the data; only focus-forwarding is lost.
      console.error('[instance-lock] could not listen for second launches:', err)
      resolve(null)
    })
    server.listen(socket, () => resolve(server))
  })
}

export async function acquireInstanceLock(
  configDir: string,
  onFocusRequest: () => void
): Promise<InstanceLockResult> {
  fs.mkdirSync(configDir, { recursive: true })
  const lockPath = path.join(configDir, LOCK_FILE)
  const socket = instanceSocketPath(configDir)

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number
    try {
      fd = fs.openSync(lockPath, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const existing = readLock(lockPath)
      if (existing && isPidAlive(existing.pid)) {
        if (await sendToOwner(existing.socket, 'focus')) {
          return { acquired: false, ownerPid: existing.pid }
        }
        // Alive pid but no answer: either the owner is still starting up, or the pid
        // was reused after a crash. Only the latter survives the grace period.
        if (lockAgeMs(lockPath) < STARTUP_GRACE_MS) {
          return { acquired: false, ownerPid: existing.pid }
        }
      } else if (!existing && lockAgeMs(lockPath) < STARTUP_GRACE_MS) {
        // Unparseable and fresh: another instance is between open() and write().
        return { acquired: false, ownerPid: null }
      }
      console.warn(`[instance-lock] taking over stale lock ${lockPath}` + (existing ? ` (pid ${existing.pid})` : ''))
      try { fs.unlinkSync(lockPath) } catch { /* raced with someone else's cleanup */ }
      continue
    }

    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, socket } satisfies LockContents))
    } finally {
      fs.closeSync(fd)
    }
    const server = await listen(socket, onFocusRequest)
    let released = false
    return {
      acquired: true,
      release: () => {
        if (released) return
        released = true
        server?.close()
        if (process.platform !== 'win32') {
          try { fs.unlinkSync(socket) } catch { /* gone */ }
        }
        // Only remove the lock if it is still ours (a stale-takeover may have replaced it).
        if (readLock(lockPath)?.pid === process.pid) {
          try { fs.unlinkSync(lockPath) } catch { /* gone */ }
        }
      }
    }
  }
  return { acquired: false, ownerPid: null }
}
