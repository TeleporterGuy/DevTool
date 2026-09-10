import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  agentCommandOverride,
  conptySpawnArgv,
  extraWindowsSearchDirs,
  findCurlExe,
  isAiAgentCommand,
  quotePosixHookBin,
  resolveAgentCommand,
  resolveSshCommand
} from '../src/main/resolve-agent-command'
import { DEFAULT_CONFIG } from '../src/shared/types'

describe('resolveAgentCommand', () => {
  const win = {
    platform: 'win32' as const,
    path: path.win32
  }

  it('uses an adjacent .cmd when an absolute path has no extension', () => {
    const resolved = resolveAgentCommand('C:\\npm-global\\pi', {
      ...win,
      existsSync: (candidate) => candidate.toLowerCase() === 'c:\\npm-global\\pi.cmd'
    })
    expect(resolved.toLowerCase()).toBe('c:\\npm-global\\pi.cmd')
  })

  it('throws a settings-oriented error when an absolute path is missing', () => {
    expect(() =>
      resolveAgentCommand('C:\\missing\\pi.cmd', {
        ...win,
        existsSync: () => false
      })
    ).toThrow(/Settings → AI Tools/)
  })

  it('finds pi.cmd via PATHEXT on PATH', () => {
    const resolved = resolveAgentCommand('pi', {
      ...win,
      env: { PATH: 'C:\\npm-global', PATHEXT: '.EXE;.CMD' },
      existsSync: (candidate) => candidate.toLowerCase() === 'c:\\npm-global\\pi.cmd'
    })
    expect(resolved.toLowerCase()).toBe('c:\\npm-global\\pi.cmd')
  })

  it('searches %AppData%\\npm when Electron PATH omits it', () => {
    const resolved = resolveAgentCommand('pi', {
      ...win,
      env: { PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\appdata\\roaming\\npm\\pi.cmd'
    })
    expect(resolved.toLowerCase()).toBe('c:\\users\\me\\appdata\\roaming\\npm\\pi.cmd')
  })

  it('throws when the command is not on PATH or extra dirs', () => {
    expect(() =>
      resolveAgentCommand('pi', {
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: () => false
      })
    ).toThrow(/Cannot find "pi"/)
  })

  it('does not pick an extensionless shebang shim when pi.cmd exists', () => {
    const resolved = resolveAgentCommand('pi', {
      ...win,
      env: { PATH: 'C:\\npm-global', PATHEXT: '.EXE;.CMD' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\npm-global\\pi' ||
        candidate.toLowerCase() === 'c:\\npm-global\\pi.cmd'
    })
    expect(resolved.toLowerCase()).toBe('c:\\npm-global\\pi.cmd')
  })

  it('leaves a bare name unchanged on non-Windows so the OS can search PATH', () => {
    expect(
      resolveAgentCommand('pi', {
        platform: 'linux',
        path: path.posix,
        existsSync: () => false
      })
    ).toBe('pi')
  })
})

describe('agentCommandOverride', () => {
  it('reads the matching settings field', () => {
    const config = {
      ...DEFAULT_CONFIG,
      piCommand: 'C:\\npm\\pi.cmd',
      claudeCommand: '/usr/local/bin/claude'
    }
    expect(agentCommandOverride('pi', config)).toBe('C:\\npm\\pi.cmd')
    expect(agentCommandOverride('claude', config)).toBe('/usr/local/bin/claude')
    expect(agentCommandOverride('codex', config)).toBe('')
    expect(agentCommandOverride('/bin/bash', config)).toBe('')
  })

  it('treats pi/claude/codex as agent commands', () => {
    expect(isAiAgentCommand('pi')).toBe(true)
    expect(isAiAgentCommand('bash')).toBe(false)
  })
})

describe('conptySpawnArgv', () => {
  it('runs .cmd shims through cmd.exe so CreateProcess is not given a batch file', () => {
    expect(
      conptySpawnArgv('C:\\npm\\pi.cmd', ['--session-id', 'abc'], {
        platform: 'win32',
        path: path.win32,
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      })
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\npm\\pi.cmd', '--session-id', 'abc']
    })
  })

  it('spawns .exe files directly', () => {
    expect(
      conptySpawnArgv('C:\\Tools\\pi.exe', ['-e', 'ext.mjs'], {
        platform: 'win32',
        path: path.win32
      })
    ).toEqual({
      file: 'C:\\Tools\\pi.exe',
      args: ['-e', 'ext.mjs']
    })
  })

  it('does not wrap on non-Windows', () => {
    expect(conptySpawnArgv('/usr/bin/pi', ['-e', 'x'], { platform: 'linux' })).toEqual({
      file: '/usr/bin/pi',
      args: ['-e', 'x']
    })
  })
})

describe('extraWindowsSearchDirs', () => {
  it('includes npm global and Git usr\\bin', () => {
    const dirs = extraWindowsSearchDirs(
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      path.win32
    )
    expect(dirs).toContain('C:\\Users\\me\\AppData\\Roaming\\npm')
    expect(dirs).toContain('C:\\Program Files\\Git\\usr\\bin')
    expect(dirs).toContain('C:\\Windows\\System32\\OpenSSH')
  })
})

describe('findCurlExe', () => {
  const win = { platform: 'win32' as const, path: path.win32 }

  it('finds curl.exe in Git usr\\bin when PATH is thin', () => {
    const found = findCurlExe({
      ...win,
      env: { PATH: 'C:\\Windows\\System32' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\program files\\git\\usr\\bin\\curl.exe'
    })
    expect(found?.toLowerCase()).toBe('c:\\program files\\git\\usr\\bin\\curl.exe')
  })

  it('returns null when curl is missing', () => {
    expect(
      findCurlExe({
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: () => false
      })
    ).toBeNull()
  })
})

describe('resolveSshCommand', () => {
  const win = { platform: 'win32' as const, path: path.win32 }

  it('returns a bare ssh name on non-Windows', () => {
    expect(resolveSshCommand({ platform: 'linux', path: path.posix, existsSync: () => false })).toBe('ssh')
  })

  it('finds ssh.exe on PATH', () => {
    const resolved = resolveSshCommand({
      ...win,
      env: { PATH: 'C:\\Windows\\System32\\OpenSSH', PATHEXT: '.EXE' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\windows\\system32\\openssh\\ssh.exe'
    })
    expect(resolved.toLowerCase()).toBe('c:\\windows\\system32\\openssh\\ssh.exe')
  })

  it('finds Git usr\\bin\\ssh.exe when PATH is thin', () => {
    const resolved = resolveSshCommand({
      ...win,
      env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\program files\\git\\usr\\bin\\ssh.exe'
    })
    expect(resolved.toLowerCase()).toBe('c:\\program files\\git\\usr\\bin\\ssh.exe')
  })

  it('throws a clear error when ssh.exe is missing', () => {
    expect(() =>
      resolveSshCommand({
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: () => false
      })
    ).toThrow(/Cannot find ssh\.exe/)
  })
})

describe('quotePosixHookBin', () => {
  it('leaves a simple curl name unquoted', () => {
    expect(quotePosixHookBin('curl')).toBe('curl')
  })

  it('quotes a Windows path with spaces using forward slashes', () => {
    expect(quotePosixHookBin('C:\\Program Files\\Git\\usr\\bin\\curl.exe')).toBe(
      "'C:/Program Files/Git/usr/bin/curl.exe'"
    )
  })
})
