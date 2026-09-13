import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  condaPathDirs,
  condaRootFromEnvPrefix,
  condaSpawnPathDirs,
  envNameFromPrefix,
  extraCondaCandidateFiles,
  findCondaExecutable,
  installRootFromCondaFile,
  listCondaEnvs,
  listCondaEnvsFromFilesystem,
  parseCondaEnvListJson,
  parseEnvironmentsTxt,
  posixSingleQuote,
  resetCondaEnvForTests,
  resolveCondaEnvPrefix,
  resolveProjectCondaEnv,
  setCachedCondaEnvsForTests,
  wrapInteractiveShellWithCondaActivate
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

describe('condaSpawnPathDirs', () => {
  it('puts Windows env dirs before install condabin so python wins and conda.exe remains', () => {
    const dirs = condaSpawnPathDirs(
      { name: 'ml', prefix: 'C:\\Users\\me\\miniforge3\\envs\\ml' },
      win
    )
    expect(dirs[0]).toBe('C:\\Users\\me\\miniforge3\\envs\\ml')
    expect(dirs).toContain('C:\\Users\\me\\miniforge3\\envs\\ml\\Scripts')
    const condabin = dirs.indexOf('C:\\Users\\me\\miniforge3\\condabin')
    const envScripts = dirs.indexOf('C:\\Users\\me\\miniforge3\\envs\\ml\\Scripts')
    const rootScripts = dirs.indexOf('C:\\Users\\me\\miniforge3\\Scripts')
    expect(condabin).toBeGreaterThan(envScripts)
    expect(rootScripts).toBeGreaterThan(condabin)
  })

  it('does not duplicate Scripts when the env is base', () => {
    const dirs = condaSpawnPathDirs({ name: 'base', prefix: 'C:\\Users\\me\\miniforge3' }, win)
    const scripts = dirs.filter((dir) => dir.toLowerCase() === 'c:\\users\\me\\miniforge3\\scripts')
    expect(scripts).toHaveLength(1)
    expect(dirs).toContain('C:\\Users\\me\\miniforge3\\condabin')
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

  it('uses a cached list only when the prefix still looks like a conda env', () => {
    setCachedCondaEnvsForTests([{ name: 'ml', prefix: 'D:\\envs\\ml' }])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: (candidate) => candidate.toLowerCase() === 'd:\\envs\\ml\\conda-meta',
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBe('D:\\envs\\ml')
  })

  it('ignores a dead cached prefix and falls through to the filesystem', () => {
    setCachedCondaEnvsForTests([{ name: 'ml', prefix: 'D:\\envs\\ml' }])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        env: { PATH: 'C:\\Windows\\System32' },
        existsSync: (candidate) => {
          const n = candidate.toLowerCase()
          return n === 'c:\\users\\me\\miniconda3\\envs\\ml\\conda-meta'
        },
        readFileSync: () => '',
        readdirSync: (dir) =>
          dir.toLowerCase() === 'c:\\users\\me\\miniconda3\\envs' ? ['ml'] : []
      })
    ).toBe('C:\\Users\\me\\miniconda3\\envs\\ml')
  })

  it('returns null when the cached prefix is dead and nothing is on disk', () => {
    setCachedCondaEnvsForTests([{ name: 'ml', prefix: 'D:\\envs\\ml' }])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: () => false,
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBeNull()
  })

  it('returns null when two live envs share the same name', () => {
    setCachedCondaEnvsForTests([
      { name: 'ml', prefix: 'C:\\miniconda3\\envs\\ml' },
      { name: 'ml', prefix: 'D:\\other\\envs\\ml' }
    ])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: (candidate) => candidate.toLowerCase().endsWith('\\conda-meta'),
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBeNull()
  })

  it('matches a Windows name case-insensitively only when a single env matches', () => {
    setCachedCondaEnvsForTests([{ name: 'ML', prefix: 'D:\\envs\\ML' }])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: (candidate) => candidate.toLowerCase() === 'd:\\envs\\ml\\conda-meta',
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBe('D:\\envs\\ML')
  })

  it('does not case-fold a Windows name when two envs would match', () => {
    setCachedCondaEnvsForTests([
      { name: 'ML', prefix: 'D:\\envs\\ML' },
      { name: 'Ml', prefix: 'E:\\envs\\Ml' }
    ])
    expect(
      resolveCondaEnvPrefix('ml', {
        ...win,
        existsSync: (candidate) => candidate.toLowerCase().endsWith('\\conda-meta'),
        readFileSync: () => '',
        readdirSync: () => []
      })
    ).toBeNull()
  })
})

describe('resolveProjectCondaEnv', () => {
  const liveMeta = (prefix: string) => (candidate: string) =>
    candidate.toLowerCase() === `${prefix.toLowerCase()}\\conda-meta`

  it('prefers a still-valid saved prefix over name lookup', () => {
    setCachedCondaEnvsForTests([
      { name: 'ml', prefix: 'C:\\miniconda3\\envs\\ml' },
      { name: 'ml', prefix: 'D:\\other\\envs\\ml' }
    ])
    expect(
      resolveProjectCondaEnv(
        { condaEnvName: 'ml', condaEnvPrefix: 'D:\\other\\envs\\ml' },
        {
          ...win,
          existsSync: liveMeta('D:\\other\\envs\\ml'),
          readFileSync: () => '',
          readdirSync: () => []
        }
      )
    ).toEqual({ name: 'ml', prefix: 'D:\\other\\envs\\ml' })
  })

  it('falls through to name lookup when the saved prefix is dead', () => {
    setCachedCondaEnvsForTests([{ name: 'ml', prefix: 'C:\\miniconda3\\envs\\ml' }])
    expect(
      resolveProjectCondaEnv(
        { condaEnvName: 'ml', condaEnvPrefix: 'D:\\gone\\envs\\ml' },
        {
          ...win,
          existsSync: liveMeta('C:\\miniconda3\\envs\\ml'),
          readFileSync: () => '',
          readdirSync: () => []
        }
      )
    ).toEqual({ name: 'ml', prefix: 'C:\\miniconda3\\envs\\ml' })
  })

  it('returns null when prefix and name are both missing or dead', () => {
    expect(
      resolveProjectCondaEnv(
        { condaEnvName: 'ml', condaEnvPrefix: 'D:\\gone\\envs\\ml' },
        { ...win, existsSync: () => false, readFileSync: () => '', readdirSync: () => [] }
      )
    ).toBeNull()
  })
})

describe('wrapInteractiveShellWithCondaActivate', () => {
  const pec = {
    name: 'pec_simulator_env',
    prefix: '/Users/me/miniconda3/envs/pec_simulator_env'
  }

  function winWrapDeps(over: Record<string, unknown> = {}) {
    return {
      ...win,
      tmpdir: () => '/tmp',
      mkdtempSync: () => '/tmp/devtool-conda-test',
      writeFileSync: () => {},
      ...over
    }
  }

  it('leaves spawn args alone when no project env is set', () => {
    const spawn = { file: '/bin/zsh', args: ['-l'] }
    expect(wrapInteractiveShellWithCondaActivate(spawn, null, posix)).toEqual(spawn)
    expect(wrapInteractiveShellWithCondaActivate(spawn, undefined, posix)).toEqual(spawn)
  })

  it('runs conda activate after login rc so init activating base cannot win', () => {
    const wrapped = wrapInteractiveShellWithCondaActivate(
      { file: '/bin/zsh', args: ['-l'] },
      pec,
      posix
    )
    expect(wrapped.file).toBe('/bin/zsh')
    // -l -i source zprofile/zshrc (conda initialize → often `conda activate base`)
    // then -c runs, so the project env is activated after that hook.
    expect(wrapped.args.slice(0, 3)).toEqual(['-l', '-i', '-c'])
    const script = wrapped.args[3]
    expect(script).toContain("export CONDA_AUTO_ACTIVATE_BASE=false")
    expect(script).toContain("conda activate '/Users/me/miniconda3/envs/pec_simulator_env'")
    expect(script).toContain("conda activate 'pec_simulator_env'")
    expect(script).toContain("exec '/bin/zsh' -i")
    expect(script).not.toContain('--rcfile')
    expect(script).toContain('/Users/me/miniconda3/etc/profile.d/conda.sh')
    expect(wrapped.args.indexOf('-l')).toBeLessThan(wrapped.args.indexOf('-c'))
    expect(wrapped.args.indexOf('-i')).toBeLessThan(wrapped.args.indexOf('-c'))
  })

  it('uses Git Bash login flags on Windows', () => {
    const wrapped = wrapInteractiveShellWithCondaActivate(
      { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
      { name: 'ml', prefix: 'C:\\Users\\me\\miniforge3\\envs\\ml' },
      winWrapDeps()
    )
    expect(wrapped.args.slice(0, 3)).toEqual(['--login', '-i', '-c'])
    const script = wrapped.args[3]
    expect(script).toContain("conda activate 'C:/Users/me/miniforge3/envs/ml'")
    expect(script).toContain("conda activate 'ml'")
    expect(script).toContain("C:/Users/me/miniforge3/etc/profile.d/conda.sh")
    expect(script).toContain('--rcfile')
    expect(script).toContain("exec 'C:/Program Files/Git/bin/bash.exe' --rcfile '/tmp/devtool-conda-test/bashrc' -i")
    // Non-login `exec bash -i` would drop the conda function from .bash_profile.
    expect(script).not.toMatch(/exec 'C:\/Program Files\/Git\/bin\/bash\.exe' -i/)
    expect(script).toContain('2>/dev/null || micromamba activate')
  })

  it('never embeds a $$ -only temp name in the Windows wrap script', () => {
    const written: string[] = []
    const wrapped = wrapInteractiveShellWithCondaActivate(
      { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
      { name: 'ml', prefix: 'C:\\Users\\me\\miniforge3\\envs\\ml' },
      winWrapDeps({
        writeFileSync: (_path: string, data: string) => {
          written.push(data)
        }
      })
    )
    const script = wrapped.args[3]
    expect(script).not.toContain('$$')
    expect(script).not.toContain('mktemp')
    expect(script).not.toMatch(/devtool-conda-\$\$/)
    expect(written.join('\n')).not.toContain('$$')
    expect(written.join('\n')).toContain('.bashrc')
  })

  it('skips the Windows wrap when the rcfile cannot be created', () => {
    const spawn = { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
    expect(
      wrapInteractiveShellWithCondaActivate(
        spawn,
        { name: 'ml', prefix: 'C:\\Users\\me\\miniforge3\\envs\\ml' },
        winWrapDeps({
          mkdtempSync: () => {
            throw new Error('no tmp')
          }
        })
      )
    ).toEqual(spawn)
  })

  it('quotes env names that contain spaces and quotes', () => {
    expect(posixSingleQuote("foo'bar")).toBe(`'foo'\\''bar'`)
    const wrapped = wrapInteractiveShellWithCondaActivate(
      { file: '/bin/zsh', args: ['-l'] },
      { name: "ml env", prefix: '/opt/conda/envs/ml env' },
      posix
    )
    expect(wrapped.args[3]).toContain("conda activate 'ml env'")
    expect(wrapped.args[3]).toContain("conda activate '/opt/conda/envs/ml env'")
  })

  it('treats envs/<name> as living under the conda install root', () => {
    expect(condaRootFromEnvPrefix(pec, posix)).toBe('/Users/me/miniconda3')
    expect(
      condaRootFromEnvPrefix({ name: 'base', prefix: '/Users/me/miniconda3' }, posix)
    ).toBe('/Users/me/miniconda3')
  })
})
