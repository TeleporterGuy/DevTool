import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findGitBashExe,
  getShellEnv,
  gitInstallRoot,
  msysPathListToWindows,
  normalizePortableNodeDir,
  parseNullDelimitedEnv,
  prependDirToPath,
  resetShellEnvForTests,
  resolveShellEnv,
  setPortableNodeDir
} from '../src/main/shell-env'

const win = {
  platform: 'win32' as const,
  path: path.win32
}

afterEach(() => {
  resetShellEnvForTests()
})

describe('normalizePortableNodeDir', () => {
  it('returns empty for blank input', () => {
    expect(normalizePortableNodeDir('  ', win)).toBe('')
  })

  it('keeps a folder that happens to be named node', () => {
    expect(normalizePortableNodeDir('D:\\node', win)).toBe('D:\\node')
  })

  it('uses the parent folder when the path is node.exe', () => {
    expect(normalizePortableNodeDir('C:\\Tools\\node-v22\\node.exe', win)).toBe('C:\\Tools\\node-v22')
  })

  it('uses the parent folder when the path is a Unix node binary', () => {
    expect(normalizePortableNodeDir('/opt/node/bin/node', { platform: 'linux', path: path.posix })).toBe(
      '/opt/node/bin'
    )
  })
})

describe('prependDirToPath', () => {
  it('does nothing when the Node dir is empty', () => {
    const env = { PATH: 'C:\\Windows\\System32' }
    expect(prependDirToPath(env, '', win)).toEqual(env)
  })

  it('puts the Node folder first on Windows PATH', () => {
    const next = prependDirToPath(
      { PATH: 'C:\\Windows\\System32;C:\\Windows' },
      'C:\\Tools\\node-v22',
      win
    )
    expect(next.PATH).toBe('C:\\Tools\\node-v22;C:\\Windows\\System32;C:\\Windows')
  })

  it('normalizes a pasted node.exe path before prepending', () => {
    const next = prependDirToPath({ PATH: 'C:\\Windows' }, 'C:\\Tools\\node-v22\\node.exe', win)
    expect(next.PATH).toBe('C:\\Tools\\node-v22;C:\\Windows')
  })

  it('does not duplicate a folder that is already on PATH', () => {
    const next = prependDirToPath(
      { PATH: 'C:\\Windows;C:\\Tools\\node-v22;C:\\Windows\\System32' },
      'C:\\Tools\\node-v22',
      win
    )
    expect(next.PATH).toBe('C:\\Tools\\node-v22;C:\\Windows;C:\\Windows\\System32')
  })

  it('mirrors Path when both PATH and Path are present', () => {
    const next = prependDirToPath(
      { PATH: 'C:\\Windows', Path: 'C:\\Windows' },
      'D:\\node',
      win
    )
    expect(next.PATH).toBe('D:\\node;C:\\Windows')
    expect(next.Path).toBe('D:\\node;C:\\Windows')
  })
})

describe('parseNullDelimitedEnv', () => {
  it('parses KEY=value entries', () => {
    expect(parseNullDelimitedEnv('PATH=/usr/bin\0HOME=/home/me\0')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me'
    })
  })
})

describe('findGitBashExe', () => {
  it('finds bash.exe in extra Git install dirs when PATH is thin', () => {
    const found = findGitBashExe({
      ...win,
      env: { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\appdata\\local\\programs\\git\\bin\\bash.exe'
    })
    expect(found?.toLowerCase()).toBe('c:\\users\\me\\appdata\\local\\programs\\git\\bin\\bash.exe')
  })

  it('returns null when bash.exe is missing', () => {
    expect(
      findGitBashExe({
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: () => false
      })
    ).toBeNull()
  })
})

describe('msysPathListToWindows', () => {
  const gitRoot = 'C:\\Program Files\\Git'

  it('maps /c/... entries and Git /usr/bin', () => {
    const converted = msysPathListToWindows(
      '/c/Program Files/Git/usr/bin:/usr/bin:/c/Windows/System32',
      gitRoot,
      win
    )
    expect(converted).toBe(
      'C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32'
    )
  })

  it('treats Git\\usr\\bin\\bash.exe as inside the Git root', () => {
    expect(gitInstallRoot('C:\\Program Files\\Git\\usr\\bin\\bash.exe', win)).toBe(
      'C:\\Program Files\\Git'
    )
    expect(gitInstallRoot('C:\\Program Files\\Git\\bin\\bash.exe', win)).toBe(
      'C:\\Program Files\\Git'
    )
  })
})

describe('getShellEnv', () => {
  it('prepends the live Node dir onto captured-or-process env', () => {
    setPortableNodeDir('C:\\Tools\\node-v22')
    const env = getShellEnv({
      ...win,
      env: { PATH: 'C:\\Windows\\System32' } as NodeJS.ProcessEnv
    })
    expect(env.PATH.startsWith('C:\\Tools\\node-v22;')).toBe(true)
  })
})

describe('resolveShellEnv', () => {
  it('does not put a Unix PATH onto process.env; PTY env uses converted Windows PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    await resolveShellEnv({
      ...win,
      env,
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\appdata\\local\\programs\\git\\bin\\bash.exe',
      execFile: (_file, _args, _opts, cb) => {
        cb(null, 'PATH=/c/Program Files/Git/usr/bin:/c/Windows\0HOME=/c/Users/me\0', '')
      }
    })
    expect(env.PATH).toBe('C:\\Windows\\System32')
    const merged = getShellEnv({ ...win, env })
    expect(merged.HOME).toBe('/c/Users/me')
    expect(merged.PATH).toBe(
      'C:\\Program Files\\Git\\usr\\bin;C:\\Windows'
    )
  })

  it('leaves process env alone when the dump fails', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' }
    await resolveShellEnv({
      ...win,
      env,
      existsSync: () => true,
      execFile: (_file, _args, _opts, cb) => {
        cb(new Error('timeout'), '', '')
      }
    })
    expect(env.PATH).toBe('C:\\Windows\\System32')
  })
})
