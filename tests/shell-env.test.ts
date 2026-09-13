import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCondaEnv,
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
import { resetCondaEnvForTests } from '../src/main/conda-env'

const win = {
  platform: 'win32' as const,
  path: path.win32
}

afterEach(() => {
  resetShellEnvForTests()
  resetCondaEnvForTests()
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

  it('prefers Git\\bin over Git\\usr\\bin when both exist', () => {
    const found = findGitBashExe({
      ...win,
      env: { PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32' },
      existsSync: (candidate) => {
        const n = candidate.toLowerCase()
        return (
          n === 'c:\\program files\\git\\usr\\bin\\bash.exe' ||
          n === 'c:\\program files\\git\\bin\\bash.exe'
        )
      }
    })
    expect(found?.toLowerCase()).toBe('c:\\program files\\git\\bin\\bash.exe')
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

describe('applyCondaEnv', () => {
  const ml = {
    name: 'ml',
    prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
  }
  const existsWin = (candidate: string) => {
    const n = candidate.toLowerCase()
    return (
      n === 'c:\\users\\me\\miniconda3\\envs\\ml' ||
      n === 'c:\\users\\me\\miniconda3\\envs\\ml\\conda-meta' ||
      n === 'c:\\users\\me\\miniconda3\\envs\\ml\\scripts' ||
      n === 'c:\\users\\me\\miniconda3\\envs\\ml\\library\\bin'
    )
  }

  it('does nothing when no env is selected', () => {
    const env = { PATH: 'C:\\Windows\\System32', PYTHONHOME: 'C:\\Python' }
    expect(applyCondaEnv(env, null, { ...win, existsSync: () => true })).toEqual(env)
    expect(applyCondaEnv(env, { name: '', prefix: ml.prefix }, { ...win, existsSync: () => true })).toEqual(env)
  })

  it('prepends conda activate dirs that exist and sets CONDA_*', () => {
    const next = applyCondaEnv(
      { PATH: 'C:\\Windows\\System32', PYTHONHOME: 'C:\\Python' },
      ml,
      { ...win, existsSync: existsWin }
    )
    expect(next.PATH).toBe(
      'C:\\Users\\me\\miniconda3\\envs\\ml;C:\\Users\\me\\miniconda3\\envs\\ml\\Library\\bin;C:\\Users\\me\\miniconda3\\envs\\ml\\Scripts;C:\\Windows\\System32'
    )
    expect(next.CONDA_PREFIX).toBe(ml.prefix)
    expect(next.CONDA_DEFAULT_ENV).toBe('ml')
    expect(next.CONDA_SHLVL).toBe('1')
    expect(next.CONDA_PROMPT_MODIFIER).toBe('(ml) ')
    expect(next.CONDA_AUTO_ACTIVATE_BASE).toBe('false')
    expect(next.PYTHONHOME).toBeUndefined()
  })

  it('prepends install condabin after env dirs when those folders exist', () => {
    const next = applyCondaEnv(
      { PATH: 'C:\\Windows\\System32' },
      ml,
      {
        ...win,
        existsSync: (candidate) => {
          const n = candidate.toLowerCase()
          return existsWin(candidate) || n === 'c:\\users\\me\\miniconda3\\condabin'
        }
      }
    )
    const parts = next.PATH.split(';')
    expect(parts[0]).toBe(ml.prefix)
    expect(parts.indexOf('C:\\Users\\me\\miniconda3\\condabin')).toBeGreaterThan(
      parts.indexOf('C:\\Users\\me\\miniconda3\\envs\\ml\\Scripts')
    )
    expect(parts.at(-1)).toBe('C:\\Windows\\System32')
  })

  it('mirrors Path on Windows', () => {
    const next = applyCondaEnv(
      { PATH: 'C:\\Windows', Path: 'C:\\Windows' },
      ml,
      { ...win, existsSync: existsWin }
    )
    expect(next.Path).toBe(next.PATH)
  })

  it('does not set CONDA_* when the prefix is not a conda env', () => {
    const env = { PATH: 'C:\\Windows\\System32', PYTHONHOME: 'C:\\Python' }
    const next = applyCondaEnv(env, ml, { ...win, existsSync: () => false })
    expect(next).toEqual(env)
    expect(next.CONDA_PREFIX).toBeUndefined()
    expect(next.CONDA_DEFAULT_ENV).toBeUndefined()
    expect(next.CONDA_PROMPT_MODIFIER).toBeUndefined()
  })

  it('does not set CONDA_* when no PATH dirs remain after filtering', () => {
    const env = { PATH: 'C:\\Windows\\System32' }
    const next = applyCondaEnv(env, ml, {
      ...win,
      existsSync: (candidate) => candidate.toLowerCase() === 'c:\\users\\me\\miniconda3\\envs\\ml\\conda-meta'
    })
    expect(next).toEqual(env)
    expect(next.CONDA_PREFIX).toBeUndefined()
    expect(next.CONDA_DEFAULT_ENV).toBeUndefined()
  })
})

describe('getShellEnv with conda', () => {
  it('keeps portable Node first, then the conda env, and does not write process.env.PATH', () => {
    const live: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' }
    setPortableNodeDir('C:\\Tools\\node-v22')
    const env = getShellEnv(
      {
        ...win,
        env: live,
        existsSync: () => true
      },
      { condaEnv: { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' } }
    )
    expect(live.PATH).toBe('C:\\Windows\\System32')
    const parts = env.PATH.split(';')
    expect(parts[0]).toBe('C:\\Tools\\node-v22')
    expect(parts[1]).toBe('C:\\Users\\me\\miniconda3\\envs\\ml')
    expect(parts).toContain('C:\\Users\\me\\miniconda3\\envs\\ml\\Scripts')
    expect(parts).toContain('C:\\Users\\me\\miniconda3\\condabin')
    expect(parts.indexOf('C:\\Users\\me\\miniconda3\\condabin')).toBeGreaterThan(
      parts.indexOf('C:\\Users\\me\\miniconda3\\envs\\ml')
    )
    expect(env.CONDA_DEFAULT_ENV).toBe('ml')
    expect(env.CONDA_AUTO_ACTIVATE_BASE).toBe('false')
  })

  it('prepends Unix conda bin under portable Node', () => {
    setPortableNodeDir('/opt/node/bin')
    const env = getShellEnv(
      {
        platform: 'linux',
        path: path.posix,
        env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
        existsSync: () => true
      },
      { condaEnv: { name: 'ml', prefix: '/home/me/miniconda3/envs/ml' } }
    )
    expect(env.PATH).toBe(
      '/opt/node/bin:/home/me/miniconda3/envs/ml/bin:/home/me/miniconda3/condabin:/home/me/miniconda3/bin:/usr/bin'
    )
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
        cb(null, 'PATH=/c/Program Files/Git/usr/bin:/c/Windows\0HOME=/c/Users/me\0PWD=/c/Users/me\0', '')
      }
    })
    expect(env.PATH).toBe('C:\\Windows\\System32')
    const merged = getShellEnv({ ...win, env })
    expect(merged.HOME).toBe('/c/Users/me')
    expect(merged.PWD).toBeUndefined()
    expect(merged.CHERE_INVOKING).toBe('1')
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
