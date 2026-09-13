import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  condaPathDirs,
  envNameFromPrefix,
  extraCondaCandidateFiles,
  findCondaExecutable,
  installRootFromCondaFile,
  listCondaEnvs,
  listCondaEnvsFromFilesystem,
  parseCondaEnvListJson,
  parseEnvironmentsTxt,
  resetCondaEnvForTests,
  resolveCondaEnvPrefix,
  setCachedCondaEnvsForTests
} from '../src/main/conda-env'

const win = {
  platform: 'win32' as const,
  path: path.win32,
  homedir: 'C:\\Users\\me'
}

const posix = {
  platform: 'linux' as const,
  path: path.posix,
  homedir: '/home/me'
}

afterEach(() => {
  resetCondaEnvForTests()
})

describe('installRootFromCondaFile', () => {
  it('treats Scripts\\conda.exe as inside the install root', () => {
    expect(installRootFromCondaFile('C:\\Users\\me\\miniconda3\\Scripts\\conda.exe', win)).toBe(
      'C:\\Users\\me\\miniconda3'
    )
  })

  it('treats condabin\\conda.exe as inside the install root', () => {
    expect(installRootFromCondaFile('C:\\Users\\me\\miniconda3\\condabin\\conda.exe', win)).toBe(
      'C:\\Users\\me\\miniconda3'
    )
  })

  it('treats micromamba.exe sitting in the prefix as the root', () => {
    expect(installRootFromCondaFile('C:\\Users\\me\\micromamba\\micromamba.exe', win)).toBe(
      'C:\\Users\\me\\micromamba'
    )
  })
})

describe('envNameFromPrefix', () => {
  it('names the install root base', () => {
    expect(envNameFromPrefix('C:\\Users\\me\\miniconda3', 'C:\\Users\\me\\miniconda3', win)).toBe('base')
  })

  it('uses the folder name under envs', () => {
    expect(
      envNameFromPrefix('C:\\Users\\me\\miniconda3\\envs\\ml', 'C:\\Users\\me\\miniconda3', win)
    ).toBe('ml')
  })
})

describe('condaPathDirs', () => {
  it('matches conda activate order on Windows', () => {
    expect(condaPathDirs('C:\\Users\\me\\miniconda3\\envs\\ml', win)).toEqual([
      'C:\\Users\\me\\miniconda3\\envs\\ml',
      'C:\\Users\\me\\miniconda3\\envs\\ml\\Library\\mingw-w64\\bin',
      'C:\\Users\\me\\miniconda3\\envs\\ml\\Library\\usr\\bin',
      'C:\\Users\\me\\miniconda3\\envs\\ml\\Library\\bin',
      'C:\\Users\\me\\miniconda3\\envs\\ml\\Scripts',
      'C:\\Users\\me\\miniconda3\\envs\\ml\\bin'
    ])
  })

  it('prepends only bin on Unix', () => {
    expect(condaPathDirs('/home/me/miniconda3/envs/ml', posix)).toEqual([
      '/home/me/miniconda3/envs/ml/bin'
    ])
  })
})

describe('parseCondaEnvListJson', () => {
  it('parses conda env list --json', () => {
    const raw = JSON.stringify({
      envs: [
        'C:\\Users\\me\\miniconda3',
        'C:\\Users\\me\\miniconda3\\envs\\ml'
      ]
    })
    expect(parseCondaEnvListJson(raw, 'C:\\Users\\me\\miniconda3', win)).toEqual([
      { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
      { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }
    ])
  })

  it('parses a micromamba array of objects', () => {
    const raw = JSON.stringify([
      { name: 'base', prefix: '/home/me/micromamba' },
      { name: 'dev', prefix: '/home/me/micromamba/envs/dev' }
    ])
    expect(parseCondaEnvListJson(raw, '/home/me/micromamba', posix)).toEqual([
      { name: 'base', prefix: '/home/me/micromamba' },
      { name: 'dev', prefix: '/home/me/micromamba/envs/dev' }
    ])
  })
})

describe('parseEnvironmentsTxt', () => {
  it('skips comments and blank lines', () => {
    const txt = '# conda\n\nC:\\Users\\me\\miniconda3\nC:\\Users\\me\\miniconda3\\envs\\ml\n'
    expect(parseEnvironmentsTxt(txt, 'C:\\Users\\me\\miniconda3', win)).toEqual([
      { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
      { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }
    ])
  })
})

describe('findCondaExecutable', () => {
  it('finds conda.exe on PATH', () => {
    const found = findCondaExecutable({
      ...win,
      env: { PATH: 'C:\\Users\\me\\miniconda3\\Scripts;C:\\Windows\\System32' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe'
    })
    expect(found).toEqual({
      kind: 'conda',
      file: 'C:\\Users\\me\\miniconda3\\Scripts\\conda.exe'
    })
  })

  it('finds conda.exe in a well-known install dir when PATH is thin', () => {
    const found = findCondaExecutable({
      ...win,
      env: { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe'
    })
    expect(found?.file.toLowerCase()).toBe('c:\\users\\me\\miniconda3\\scripts\\conda.exe')
    expect(found?.kind).toBe('conda')
  })

  it('prefers conda over micromamba when both exist', () => {
    const found = findCondaExecutable({
      ...win,
      env: { PATH: 'C:\\Windows\\System32' },
      existsSync: (candidate) => {
        const n = candidate.toLowerCase()
        return (
          n === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe' ||
          n === 'c:\\users\\me\\micromamba\\micromamba.exe'
        )
      }
    })
    expect(found?.kind).toBe('conda')
  })

  it('falls back to micromamba', () => {
    const found = findCondaExecutable({
      ...win,
      env: { PATH: 'C:\\Windows\\System32' },
      existsSync: (candidate) =>
        candidate.toLowerCase() === 'c:\\users\\me\\micromamba\\micromamba.exe'
    })
    expect(found).toEqual({
      kind: 'micromamba',
      file: 'C:\\Users\\me\\micromamba\\micromamba.exe'
    })
  })

  it('honors CONDA_EXE when the file exists', () => {
    const found = findCondaExecutable({
      ...win,
      env: { PATH: 'C:\\Windows\\System32', CONDA_EXE: 'D:\\conda\\Scripts\\conda.exe' },
      existsSync: (candidate) => candidate === 'D:\\conda\\Scripts\\conda.exe'
    })
    expect(found?.file).toBe('D:\\conda\\Scripts\\conda.exe')
  })

  it('returns null when nothing is installed', () => {
    expect(
      findCondaExecutable({
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: () => false
      })
    ).toBeNull()
  })

  it('lists well-known Windows conda.exe locations', () => {
    const files = extraCondaCandidateFiles({
      ...win,
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    }).map((file) => file.toLowerCase())
    expect(files).toContain('c:\\users\\me\\miniconda3\\scripts\\conda.exe')
    expect(files).toContain('c:\\programdata\\anaconda3\\scripts\\conda.exe')
    expect(files).toContain('c:\\users\\me\\appdata\\local\\miniconda3\\scripts\\conda.exe')
  })
})

describe('listCondaEnvsFromFilesystem', () => {
  it('reads environments.txt and named envs under the install', () => {
    const envs = listCondaEnvsFromFilesystem({
      ...win,
      env: { PATH: 'C:\\Windows\\System32' },
      existsSync: (candidate) => {
        const n = candidate.toLowerCase()
        return (
          n === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe' ||
          n === 'c:\\users\\me\\miniconda3\\conda-meta' ||
          n === 'c:\\users\\me\\miniconda3\\envs\\ml\\conda-meta'
        )
      },
      readFileSync: () => 'C:\\Users\\me\\miniconda3\nC:\\Users\\me\\miniconda3\\envs\\ml\n',
      readdirSync: (dir) => {
        if (dir.toLowerCase() === 'c:\\users\\me\\miniconda3\\envs') return ['ml']
        return []
      }
    })
    expect(envs).toEqual([
      { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
      { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }
    ])
  })
})

describe('listCondaEnvs', () => {
  it('parses conda env list --json and caches names for spawn lookup', async () => {
    const result = await listCondaEnvs(
      {
        ...win,
        env: { PATH: 'C:\\Users\\me\\miniconda3\\Scripts' },
        existsSync: (candidate) =>
          candidate.toLowerCase() === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe',
        readFileSync: () => '',
        readdirSync: () => [],
        execFile: (_file, _args, _opts, cb) => {
          cb(
            null,
            JSON.stringify({
              envs: ['C:\\Users\\me\\miniconda3', 'C:\\Users\\me\\miniconda3\\envs\\ml']
            }),
            ''
          )
        }
      },
      { force: true }
    )
    expect(result.executable?.kind).toBe('conda')
    expect(result.envs.map((env) => env.name)).toEqual(['base', 'ml'])
    expect(resolveCondaEnvPrefix('ml', { ...win, existsSync: () => false, readFileSync: () => '', readdirSync: () => [] })).toBe(
      'C:\\Users\\me\\miniconda3\\envs\\ml'
    )
  })

  it('falls back to folders on disk when conda env list fails', async () => {
    const result = await listCondaEnvs(
      {
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: (candidate) => {
          const n = candidate.toLowerCase()
          return (
            n === 'c:\\users\\me\\miniconda3\\scripts\\conda.exe' ||
            n === 'c:\\users\\me\\miniconda3\\envs\\ml\\conda-meta'
          )
        },
        readFileSync: () => '',
        readdirSync: (dir) =>
          dir.toLowerCase() === 'c:\\users\\me\\miniconda3\\envs' ? ['ml'] : [],
        execFile: (_file, _args, _opts, cb) => {
          cb(new Error('conda crashed'), '', '')
        }
      },
      { force: true }
    )
    expect(result.envs).toEqual([{ name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }])
  })
})

describe('resolveCondaEnvPrefix', () => {
  it('returns null for a blank name', () => {
    expect(resolveCondaEnvPrefix('  ', win)).toBeNull()
  })

  it('uses a cached list when the folder scan is empty', () => {
    setCachedCondaEnvsForTests([{ name: 'ml', prefix: 'D:\\envs\\ml' }])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: () => false,
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBe('D:\\envs\\ml')
  })
})
