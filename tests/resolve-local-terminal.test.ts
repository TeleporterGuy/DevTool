import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/types'
import { isLocalInteractiveTerminal, resolveLocalTerminalSpawn } from '../src/main/resolve-local-terminal'
import { findGitBashExe } from '../src/main/shell-env'

const gitBin = 'C:\\Program Files\\Git\\bin\\bash.exe'
const gitUsr = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'

const win = {
  platform: 'win32' as const,
  path: path.win32
}

describe('findGitBashExe', () => {
  it('prefers Git\\bin\\bash.exe when usr\\bin is earlier on PATH', () => {
    const found = findGitBashExe({
      ...win,
      env: { PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32' },
      existsSync: (candidate) => {
        const n = candidate.toLowerCase()
        return n === gitUsr.toLowerCase() || n === gitBin.toLowerCase()
      }
    })
    expect(found?.toLowerCase()).toBe(gitBin.toLowerCase())
  })
})

describe('resolveLocalTerminalSpawn', () => {
  it('uses login SHELL on Unix when defaultShell is empty', () => {
    const spawn = resolveLocalTerminalSpawn(
      { ...DEFAULT_CONFIG, defaultShell: '' },
      { platform: 'linux', path: path.posix, env: { SHELL: '/bin/zsh' } }
    )
    expect(spawn).toEqual({ file: '/bin/zsh', args: ['-l'] })
  })

  it('auto-detects Git Bash on Windows and ignores inherited SHELL', () => {
    const spawn = resolveLocalTerminalSpawn(
      { ...DEFAULT_CONFIG, defaultShell: '', windowsTerminal: 'git-bash' },
      {
        ...win,
        env: { PATH: 'C:\\Windows\\System32', SHELL: '/usr/bin/bash' },
        existsSync: (candidate) => candidate.toLowerCase() === gitBin.toLowerCase()
      }
    )
    expect(spawn.file.toLowerCase()).toBe(gitBin.toLowerCase())
    expect(spawn.args).toEqual(['--login', '-i'])
  })

  it('uses an explicit Git Bash path over auto-detect', () => {
    const custom = 'D:\\Tools\\Git\\bin\\bash.exe'
    const spawn = resolveLocalTerminalSpawn(
      { ...DEFAULT_CONFIG, defaultShell: custom, windowsTerminal: 'git-bash' },
      {
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: (candidate) => candidate.toLowerCase() === custom.toLowerCase()
      }
    )
    expect(spawn.file).toBe(custom)
    expect(spawn.args).toEqual(['--login', '-i'])
  })

  it('throws a clear error when Git Bash is missing', () => {
    expect(() =>
      resolveLocalTerminalSpawn(
        { ...DEFAULT_CONFIG, windowsTerminal: 'git-bash' },
        { ...win, env: { PATH: 'C:\\Windows\\System32' }, existsSync: () => false }
      )
    ).toThrow(/Cannot find Git Bash/)
  })

  it('does not fall back to /bin/sh when Git Bash is missing', () => {
    expect(() =>
      resolveLocalTerminalSpawn(
        { ...DEFAULT_CONFIG, windowsTerminal: 'git-bash' },
        { ...win, env: { PATH: 'C:\\Windows\\System32', SHELL: '/bin/sh' }, existsSync: () => false }
      )
    ).toThrow(/Cannot find Git Bash/)
  })

  it('ignores a legacy PowerShell preset and still spawns Git Bash', () => {
    const spawn = resolveLocalTerminalSpawn(
      { ...DEFAULT_CONFIG, windowsTerminal: 'git-bash', defaultShell: '' },
      {
        ...win,
        env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
        existsSync: (candidate) => candidate.toLowerCase() === gitBin.toLowerCase()
      }
    )
    expect(spawn.file.toLowerCase()).toBe(gitBin.toLowerCase())
    expect(spawn.args).toEqual(['--login', '-i'])
  })
})

describe('isLocalInteractiveTerminal', () => {
  it('rejects shell-command tabs that pass -c', () => {
    expect(isLocalInteractiveTerminal('/bin/sh', ['-c', 'echo hi'])).toBe(false)
  })

  it('rejects SSH $SHELL placeholders', () => {
    expect(isLocalInteractiveTerminal('$SHELL', ['-l'])).toBe(false)
  })

  it('accepts empty local tab args', () => {
    expect(isLocalInteractiveTerminal('', undefined)).toBe(true)
  })
})
