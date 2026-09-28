import { describe, expect, it } from 'vitest'
import { deadKernelExitMessage, killProcessTree } from '../src/main/notebook-kernel'
import { NOTEBOOK_ERROR_MISSING_JUPYTER } from '../src/shared/notebook'

describe('deadKernelExitMessage', () => {
  it('does not append the missing-jupyter hint on a generic non-zero exit', () => {
    const message = deadKernelExitMessage(1, null)
    expect(message).toBe('Kernel exited (code 1).')
    expect(message).not.toContain('conda install')
    expect(message).not.toContain(NOTEBOOK_ERROR_MISSING_JUPYTER)
  })

  it('names a signal when the helper is killed', () => {
    expect(deadKernelExitMessage(null, 'SIGKILL')).toBe('Kernel exited (SIGKILL).')
  })
})

describe('killProcessTree', () => {
  it('uses taskkill /T on Windows for helper and kernel PIDs', () => {
    const calls: string[][] = []
    killProcessTree(
      { helperPid: 10, kernelPid: 11 },
      {
        platform: 'win32',
        execFile: (file, args, callback) => {
          calls.push([file, ...args])
          callback(null)
          return undefined
        }
      }
    )
    expect(calls).toEqual([
      ['taskkill', '/T', '/F', '/PID', '10'],
      ['taskkill', '/T', '/F', '/PID', '11']
    ])
  })

  it('does not taskkill the same PID twice', () => {
    const calls: string[][] = []
    killProcessTree(
      { helperPid: 10, kernelPid: 10 },
      {
        platform: 'win32',
        execFile: (file, args, callback) => {
          calls.push([file, ...args])
          callback(null)
          return undefined
        }
      }
    )
    expect(calls).toEqual([['taskkill', '/T', '/F', '/PID', '10']])
  })

  it('SIGKILLs kernel pid then the helper process group on POSIX', () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = []
    killProcessTree(
      { helperPid: 10, kernelPid: 11 },
      {
        platform: 'linux',
        kill: (pid, signal) => {
          killed.push([pid, signal])
          return true
        }
      }
    )
    expect(killed).toEqual([
      [11, 'SIGKILL'],
      [-10, 'SIGKILL'],
      [10, 'SIGKILL']
    ])
  })

  it('still kills a leftover kernel when the helper pid is gone', () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = []
    killProcessTree(
      { helperPid: null, kernelPid: 11 },
      {
        platform: 'linux',
        kill: (pid, signal) => {
          killed.push([pid, signal])
          return true
        }
      }
    )
    expect(killed).toEqual([[11, 'SIGKILL']])
  })
})
