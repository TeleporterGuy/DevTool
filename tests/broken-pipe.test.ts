import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  installBrokenPipeUncaughtHandler,
  isBrokenPipeError,
  writeIgnoringBrokenPipe
} from '../src/main/broken-pipe'
import { safeWebContentsSend } from '../src/main/safe-ipc-send'

describe('isBrokenPipeError', () => {
  it('matches EIO and EPIPE only', () => {
    expect(isBrokenPipeError(Object.assign(new Error('write EIO'), { code: 'EIO' }))).toBe(true)
    expect(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true)
    expect(isBrokenPipeError(new Error('write EIO'))).toBe(false)
    expect(isBrokenPipeError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe(false)
    expect(isBrokenPipeError(null)).toBe(false)
  })
})

describe('writeIgnoringBrokenPipe', () => {
  it('swallows a sync throw from write', () => {
    const stdin = {
      write: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      }
    }
    expect(() => writeIgnoringBrokenPipe(stdin, 'x\n')).not.toThrow()
  })

  it('passes a callback that ignores async EIO', () => {
    let captured: ((err?: Error | null) => void) | undefined
    const stdin = {
      write: (_chunk: string, cb?: (err?: Error | null) => void) => {
        captured = cb
        return true
      }
    }
    writeIgnoringBrokenPipe(stdin, 'x\n')
    expect(captured).toBeTypeOf('function')
    expect(() => captured?.(Object.assign(new Error('write EIO'), { code: 'EIO' }))).not.toThrow()
  })
})

describe('installBrokenPipeUncaughtHandler', () => {
  it('swallows EIO/EPIPE and rethrows anything else', () => {
    const target = new EventEmitter()
    installBrokenPipeUncaughtHandler(target)
    expect(() =>
      target.emit('uncaughtException', Object.assign(new Error('write EIO'), { code: 'EIO' }))
    ).not.toThrow()
    expect(() => target.emit('uncaughtException', new Error('real bug'))).toThrow(/real bug/)
  })
})

describe('safeWebContentsSend', () => {
  it('skips destroyed windows and destroyed webContents', () => {
    const sends: string[] = []
    safeWebContentsSend(
      { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: (ch) => sends.push(ch) } },
      'notebook-kernel-event'
    )
    safeWebContentsSend(
      { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: (ch) => sends.push(ch) } },
      'notebook-kernel-event'
    )
    expect(sends).toEqual([])
  })

  it('does not throw when send itself throws', () => {
    expect(() =>
      safeWebContentsSend(
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: () => {
              throw Object.assign(new Error('write EIO'), { code: 'EIO' })
            }
          }
        },
        'notebook-kernel-event'
      )
    ).not.toThrow()
  })

  it('sends when the frame is alive', () => {
    const sends: unknown[][] = []
    safeWebContentsSend(
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel, ...args) => sends.push([channel, ...args])
        }
      },
      'notebook-kernel-event',
      'tab-1',
      { event: 'dead' }
    )
    expect(sends).toEqual([['notebook-kernel-event', 'tab-1', { event: 'dead' }]])
  })
})
