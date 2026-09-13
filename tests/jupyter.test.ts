import { EventEmitter } from 'events'
import path from 'path'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JUPYTER_ERRORS,
  buildJupyterlabArgs,
  canReuseJupyterServer,
  condaPythonExecutable,
  isPathInsideRoot,
  isSameJupyterOrigin,
  jupyterCwdRoots,
  jupyterLabUrl,
  jupyterOrigin,
  normalizeJupyterCwd,
  parseJupyterLabUrl,
  persistableBrowserUrl,
  redactJupyterTokens,
  resolveContainedJupyterCwd,
  sameJupyterKey
} from '../src/shared/jupyter'
import { JupyterLabManager, buildJupyterSpawnEnv } from '../src/main/jupyter-lab'
import { getShellEnv, resetShellEnvForTests, setPortableNodeDir } from '../src/main/shell-env'
import { resetCondaEnvForTests } from '../src/main/conda-env'

const win = { platform: 'win32' as const, path: path.win32 }

afterEach(() => {
  resetShellEnvForTests()
  resetCondaEnvForTests()
})

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    killed: boolean
    exitCode: number | null
    signalCode: string | null
    kill: (signal?: string) => boolean
  }
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0, null)
    return true
  }
  return child
}

describe('jupyter URL helpers', () => {
  it('builds a loopback lab URL with the token', () => {
    expect(jupyterLabUrl(8888, 'abc')).toBe('http://127.0.0.1:8888/lab?token=abc')
  })

  it('parses JupyterLab log lines including localhost and trailing punctuation', () => {
    const log = [
      '[I 12:00:00.000 ServerApp] Jupyter Server 2.14 is running at:',
      '[I 12:00:00.000 ServerApp]     http://localhost:9999/lab?token=deadbeef.',
      '[I 12:00:00.000 ServerApp]     http://127.0.0.1:9999/lab?token=deadbeef'
    ].join('\n')
    expect(parseJupyterLabUrl(log)).toBe('http://127.0.0.1:9999/lab?token=deadbeef')
  })

  it('ignores non-loopback URLs in mixed output', () => {
    expect(parseJupyterLabUrl('See https://jupyter.org/ and wait')).toBeNull()
  })

  it('matches tabs that navigated inside the same Jupyter origin', () => {
    const server = 'http://127.0.0.1:8888/lab?token=abc'
    expect(isSameJupyterOrigin('http://127.0.0.1:8888/lab/tree/foo.ipynb', server)).toBe(true)
    expect(isSameJupyterOrigin('http://localhost:8888/lab', server)).toBe(true)
    expect(isSameJupyterOrigin('http://127.0.0.1:9999/lab', server)).toBe(false)
    expect(isSameJupyterOrigin('https://example.com', server)).toBe(false)
    expect(jupyterOrigin('not a url')).toBeNull()
  })

  it('redacts tokens in log snippets shown to the user', () => {
    expect(redactJupyterTokens('http://127.0.0.1:8/lab?token=secret&foo=1')).toBe(
      'http://127.0.0.1:8/lab?token=***&foo=1'
    )
  })

  it('strips the token so projects.json never stores the secret', () => {
    expect(persistableBrowserUrl('http://127.0.0.1:8888/lab?token=secret')).toBe(
      'http://127.0.0.1:8888/lab'
    )
    expect(persistableBrowserUrl('https://example.com/path?token=keep')).toBe(
      'https://example.com/path?token=keep'
    )
  })
})

describe('jupyter reuse', () => {
  const wanted = {
    projectId: 'p1',
    cwd: 'C:\\Repos\\demo\\',
    condaPrefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
  }

  it('normalizes trailing slashes and Windows case', () => {
    expect(normalizeJupyterCwd('C:\\Repos\\Demo\\', 'win32')).toBe('c:\\repos\\demo')
    expect(
      sameJupyterKey(wanted, { ...wanted, cwd: 'c:\\repos\\demo' }, 'win32')
    ).toBe(true)
  })

  it('reuses only when the ChildProcess is still ours and the key matches', () => {
    const running = { ...wanted, pid: 4242 }
    expect(canReuseJupyterServer(running, wanted, 'win32', true)).toBe(true)
    expect(canReuseJupyterServer(running, wanted, 'win32', false)).toBe(false)
    expect(
      canReuseJupyterServer(
        running,
        { ...wanted, condaPrefix: 'D:\\other\\envs\\ml' },
        'win32',
        true
      )
    ).toBe(false)
    expect(
      canReuseJupyterServer(running, { ...wanted, cwd: 'C:\\Repos\\other' }, 'win32', true)
    ).toBe(false)
    expect(canReuseJupyterServer(null, wanted, 'win32', true)).toBe(false)
  })
})

describe('condaPythonExecutable', () => {
  it('uses prefix\\python.exe on Windows', () => {
    const prefix = 'C:\\Users\\me\\miniconda3\\envs\\ml'
    expect(
      condaPythonExecutable(prefix, {
        ...win,
        existsSync: (filePath) => filePath === path.win32.join(prefix, 'python.exe')
      })
    ).toBe(path.win32.join(prefix, 'python.exe'))
  })

  it('prefers prefix/bin/python on Unix', () => {
    expect(
      condaPythonExecutable('/home/me/miniconda3/envs/ml', {
        platform: 'linux',
        path: path.posix,
        existsSync: (filePath) => filePath === '/home/me/miniconda3/envs/ml/bin/python'
      })
    ).toBe('/home/me/miniconda3/envs/ml/bin/python')
  })

  it('returns null when python is missing', () => {
    expect(
      condaPythonExecutable('C:\\gone', { ...win, existsSync: () => false })
    ).toBeNull()
  })
})

describe('buildJupyterlabArgs', () => {
  it('binds loopback, disables the extra browser, and pins token + port', () => {
    expect(buildJupyterlabArgs(8888, 'tok', 'C:\\Repos\\demo')).toEqual([
      '-m',
      'jupyterlab',
      '--no-browser',
      '--ip=127.0.0.1',
      '--port=8888',
      '--port-retries=0',
      '--ServerApp.token=tok',
      '--ServerApp.password=',
      '--ServerApp.root_dir=C:\\Repos\\demo'
    ])
  })
})

describe('jupyter cwd containment', () => {
  it('treats the project folder and nested paths as inside', () => {
    expect(isPathInsideRoot('C:\\Repos\\demo', 'C:\\Repos\\demo', 'win32', path.win32)).toBe(true)
    expect(isPathInsideRoot('C:\\Repos\\demo', 'C:\\Repos\\demo\\src', 'win32', path.win32)).toBe(true)
    expect(isPathInsideRoot('C:\\Repos\\demo', 'C:\\Repos\\other', 'win32', path.win32)).toBe(false)
    expect(isPathInsideRoot('C:\\Repos\\demo', 'C:\\Repos\\demo\\..\\secret', 'win32', path.win32)).toBe(false)
  })

  it('defaults to the project directory when cwd is omitted', () => {
    const result = resolveContainedJupyterCwd(
      undefined,
      ['C:\\Repos\\demo'],
      'C:\\Repos\\demo',
      'win32',
      path.win32
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.cwd.toLowerCase()).toBe('c:\\repos\\demo')
  })

  it('accepts a worktree root outside the project folder', () => {
    const result = resolveContainedJupyterCwd(
      'D:\\wt\\task-a',
      jupyterCwdRoots({
        directory: 'C:\\Repos\\demo',
        tasks: [{ workspace: { worktreePath: 'D:\\wt\\task-a', relativeProjectPath: '' } }]
      }),
      'C:\\Repos\\demo',
      'win32',
      path.win32
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.cwd.toLowerCase()).toBe('d:\\wt\\task-a')
  })

  it('rejects a folder that is not the project or a worktree', () => {
    const result = resolveContainedJupyterCwd(
      'C:\\Windows\\Temp',
      ['C:\\Repos\\demo'],
      'C:\\Repos\\demo',
      'win32',
      path.win32
    )
    expect(result).toEqual({ ok: false, error: JUPYTER_ERRORS.cwdNotAllowed })
  })
})

describe('buildJupyterSpawnEnv', () => {
  it('uses getShellEnv so portable Node stays first and conda is on PATH', () => {
    setPortableNodeDir('C:\\Tools\\node-v22')
    const live: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' }
    const env = buildJupyterSpawnEnv(
      { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' },
      {
        ...win,
        env: live,
        existsSync: () => true,
        getShellEnv
      }
    )
    expect(live.PATH).toBe('C:\\Windows\\System32')
    const parts = env.PATH.split(';')
    expect(parts[0]).toBe('C:\\Tools\\node-v22')
    expect(parts[1]).toBe('C:\\Users\\me\\miniconda3\\envs\\ml')
    expect(env.CONDA_PREFIX).toBe('C:\\Users\\me\\miniconda3\\envs\\ml')
    expect(env.PYTHONUNBUFFERED).toBe('1')
  })
})

describe('JupyterLabManager', () => {
  const prefix = 'C:\\Users\\me\\miniconda3\\envs\\ml'
  const python = path.win32.join(prefix, 'python.exe')
  const cwd = 'C:\\Repos\\demo'
  const condaEnv = { name: 'ml', prefix }

  function managerWith(patch: ConstructorParameters<typeof JupyterLabManager>[0] = {}) {
    const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
    const children: ReturnType<typeof fakeChild>[] = []
    const manager = new JupyterLabManager({
      ...win,
      existsSync: (filePath) => filePath === cwd || filePath === python || filePath.startsWith(prefix),
      getShellEnv: () => ({ PATH: `${python};C:\\Windows` }),
      execFile: (_file, args, _opts, cb) => {
        if (args.includes('import jupyterlab')) cb(null, '', '')
        else cb(new Error('unexpected'), '', '')
      },
      pickFreePort: async () => 8888,
      randomToken: () => 'test-token',
      httpReady: async () => true,
      killWaitMs: 20,
      killTree: async (pid) => {
        const child = children.find((item) => item.pid === pid)
        child?.kill()
      },
      spawn: (file, args, options) => {
        spawned.push({ file, args, env: (options.env ?? {}) as Record<string, string> })
        const child = fakeChild(5000 + spawned.length)
        children.push(child)
        return child as unknown as ChildProcess
      },
      startTimeoutMs: 2000,
      ...patch
    })
    return { manager, spawned, children }
  }

  it('starts jupyterlab via python -m and returns the token URL', async () => {
    const { manager, spawned } = managerWith()
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8888/lab?token=test-token',
      reused: false,
      port: 8888
    })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe(python)
    expect(spawned[0].args[0]).toBe('-m')
    expect(spawned[0].args[1]).toBe('jupyterlab')
    expect(spawned[0].env.PATH).toContain('python.exe')
    await manager.stopAll()
  })

  it('reuses a live server for the same project, folder, and env', async () => {
    const { manager, spawned } = managerWith()
    const first = await manager.open({ projectId: 'p1', cwd, condaEnv })
    const second = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(first.ok && !first.reused).toBe(true)
    expect(second).toMatchObject({ ok: true, reused: true, port: 8888 })
    expect(spawned).toHaveLength(1)
    await manager.stopAll()
  })

  it('starts a new server when the conda prefix changes', async () => {
    let port = 8888
    const { manager, spawned } = managerWith({
      pickFreePort: async () => port++,
      existsSync: (filePath) =>
        filePath === cwd || filePath.toLowerCase().includes('python.exe') || filePath.includes('miniconda3')
    })
    await manager.open({ projectId: 'p1', cwd, condaEnv })
    const next = await manager.open({
      projectId: 'p1',
      cwd,
      condaEnv: { name: 'other', prefix: 'C:\\Users\\me\\miniconda3\\envs\\other' }
    })
    expect(next).toMatchObject({ ok: true, reused: false, port: 8889 })
    expect(spawned).toHaveLength(2)
    await manager.stopAll()
  })

  it('errors clearly when jupyterlab is not installed in the env', async () => {
    const { manager, spawned } = managerWith({
      execFile: (_file, _args, _opts, cb) => {
        cb(new Error('No module named jupyterlab'), '', 'ModuleNotFoundError: No module named jupyterlab')
      }
    })
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(JUPYTER_ERRORS.noJupyterlab('ml'))
    expect(spawned).toHaveLength(0)
  })

  it('errors when python is missing from the env prefix', async () => {
    const { manager } = managerWith({ existsSync: (filePath) => filePath === cwd })
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no python')
  })

  it('errors when the port cannot be bound', async () => {
    const { manager } = managerWith({
      pickFreePort: async () => {
        throw new Error('EADDRINUSE')
      }
    })
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/EADDRINUSE|bind/i)
  })

  it('surfaces a start failure when the process exits before it is ready', async () => {
    const { manager } = managerWith({
      httpReady: async () => false,
      spawn: () => {
        const child = fakeChild(9)
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('Address already in use'))
          child.emit('exit', 1, null)
        })
        return child as never
      }
    })
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result.ok).toBe(false)
    if (!result.ok)     expect(result.error).toMatch(/failed to start/i)
  })

  it('serializes concurrent opens so only one child is spawned', async () => {
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const { manager, spawned, children } = managerWith({
      execFile: (_file, args, _opts, cb) => {
        if (args.includes('import jupyterlab')) {
          void probeGate.then(() => cb(null, '', ''))
          return
        }
        cb(new Error('unexpected'), '', '')
      }
    })
    const first = manager.open({ projectId: 'p1', cwd, condaEnv })
    const second = manager.open({ projectId: 'p1', cwd, condaEnv })
    releaseProbe()
    const [a, b] = await Promise.all([first, second])
    expect(a.ok && b.ok).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(manager.snapshot()).toHaveLength(1)
    expect(manager.snapshot()[0].pid).toBe(children[0].pid)
    await manager.stopAll()
  })

  it('does not succeed until HTTP is ready, even if the log printed a URL', async () => {
    const { manager } = managerWith({
      httpReady: async () => false,
      startTimeoutMs: 400,
      spawn: () => {
        const child = fakeChild(11)
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('http://127.0.0.1:8888/lab?token=test-token\n'))
        })
        return child as unknown as ChildProcess
      }
    })
    const result = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(JUPYTER_ERRORS.startTimeout)
  })

  it('does not tree-kill a pid after the ChildProcess has already exited', async () => {
    const treeKills: number[] = []
    const { manager, children, spawned } = managerWith({
      killTree: async (pid) => {
        treeKills.push(pid)
      }
    })
    await manager.open({ projectId: 'p1', cwd, condaEnv })
    const oldPid = children[0].pid
    // Missed the exit event, but Node already recorded exitCode. The OS may
    // have reused that pid number — do not taskkill it.
    children[0].exitCode = 0
    const next = await manager.open({ projectId: 'p1', cwd, condaEnv })
    expect(next.ok).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(treeKills).not.toContain(oldPid)
    await manager.stopAll()
  })
})
