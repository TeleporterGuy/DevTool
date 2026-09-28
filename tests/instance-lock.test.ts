import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { acquireInstanceLock } from '../src/main/instance-lock'

describe('instance lock', () => {
  let dir: string
  const releases: Array<() => void> = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-lock-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    for (const r of releases.splice(0)) r()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('acquires the lock and writes pid + socket', async () => {
    const lock = await acquireInstanceLock(dir, () => {})
    expect(lock.acquired).toBe(true)
    if (lock.acquired) releases.push(lock.release)
    const contents = JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf-8'))
    expect(contents.pid).toBe(process.pid)
    expect(typeof contents.socket).toBe('string')
  })

  it('a second launch on the same dir is refused and asks the owner to focus', async () => {
    const onFocus = vi.fn()
    const first = await acquireInstanceLock(dir, onFocus)
    expect(first.acquired).toBe(true)
    if (first.acquired) releases.push(first.release)
    // Pretend the owner is another live process (our own pid counts as "not alive").
    const lockPath = path.join(dir, 'instance.lock')
    const contents = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    fs.writeFileSync(lockPath, JSON.stringify({ ...contents, pid: process.ppid }))

    const second = await acquireInstanceLock(dir, () => {})
    expect(second.acquired).toBe(false)
    await vi.waitFor(() => expect(onFocus).toHaveBeenCalledTimes(1))
  })

  it('different config dirs get independent locks', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-lock-'))
    try {
      const a = await acquireInstanceLock(dir, () => {})
      const b = await acquireInstanceLock(other, () => {})
      expect(a.acquired && b.acquired).toBe(true)
      if (a.acquired) releases.push(a.release)
      if (b.acquired) releases.push(b.release)
    } finally {
      for (const r of releases.splice(0)) r()
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('takes over a lock whose pid is gone', async () => {
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, socket: path.join(dir, 'nope.sock') }))
    const lock = await acquireInstanceLock(dir, () => {})
    expect(lock.acquired).toBe(true)
    if (lock.acquired) releases.push(lock.release)
  })

  it('takes over an old lock from a live pid that does not answer (pid reuse)', async () => {
    const lockPath = path.join(dir, 'instance.lock')
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, socket: path.join(dir, 'nope.sock') }))
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, old, old)
    const lock = await acquireInstanceLock(dir, () => {})
    expect(lock.acquired).toBe(true)
    if (lock.acquired) releases.push(lock.release)
  })

  it('release removes the lock file', async () => {
    const lock = await acquireInstanceLock(dir, () => {})
    expect(lock.acquired).toBe(true)
    if (lock.acquired) lock.release()
    expect(fs.existsSync(path.join(dir, 'instance.lock'))).toBe(false)
  })
})
