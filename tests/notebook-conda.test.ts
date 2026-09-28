import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { condaPythonExecutable, resetCondaEnvForTests } from '../src/main/conda-env'
import {
  prepareNotebookKernelSpawn
} from '../src/main/notebook-kernel'
import {
  condaEnvInfoForNotebookSpawn,
  notebookCondaOverridePayload,
  notebookKernelCondaSelection,
  NOTEBOOK_ERROR_NO_CONDA,
  NOTEBOOK_ERROR_NO_PYTHON,
  NOTEBOOK_ERROR_STALE_CONDA,
  resolveNotebookKernelCondaEnv
} from '../src/shared/notebook'
import { resetShellEnvForTests } from '../src/main/shell-env'

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
  resetShellEnvForTests()
})

describe('condaPythonExecutable', () => {
  it('finds python.exe at the Windows env prefix', () => {
    const exists = new Set(['C:\\Users\\me\\miniconda3\\envs\\ml\\python.exe'])
    expect(
      condaPythonExecutable('C:\\Users\\me\\miniconda3\\envs\\ml', {
        ...win,
        existsSync: (file) => exists.has(file)
      })
    ).toBe('C:\\Users\\me\\miniconda3\\envs\\ml\\python.exe')
  })

  it('finds prefix/bin/python on Unix', () => {
    const exists = new Set(['/home/me/miniconda3/envs/ml/bin/python'])
    expect(
      condaPythonExecutable('/home/me/miniconda3/envs/ml', {
        ...posix,
        existsSync: (file) => exists.has(file)
      })
    ).toBe('/home/me/miniconda3/envs/ml/bin/python')
  })

  it('returns null when the env has no interpreter', () => {
    expect(
      condaPythonExecutable('C:\\Users\\me\\miniconda3\\envs\\ml', {
        ...win,
        existsSync: () => false
      })
    ).toBeNull()
  })
})

describe('prepareNotebookKernelSpawn', () => {
  it('fails closed with no project conda env', () => {
    expect(prepareNotebookKernelSpawn(null, 'C:\\proj', { ...win, env: { PATH: 'C:\\Windows' } })).toEqual({
      ok: false,
      code: 'no-conda',
      error: NOTEBOOK_ERROR_NO_CONDA
    })
  })

  it('fails when the saved prefix has no python', () => {
    const result = prepareNotebookKernelSpawn(
      { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' },
      'C:\\proj',
      {
        ...win,
        env: { PATH: 'C:\\Windows' },
        existsSync: () => false,
        helperExistsSync: () => true
      }
    )
    expect(result).toEqual({
      ok: false,
      code: 'no-python',
      error: NOTEBOOK_ERROR_NO_PYTHON
    })
  })

  it('spawns the env python with getShellEnv PATH and the helper script', () => {
    const prefix = 'C:\\Users\\me\\miniconda3\\envs\\ml'
    const python = `${prefix}\\python.exe`
    const helper = 'C:\\app\\notebook-kernel.py'
    const result = prepareNotebookKernelSpawn(
      { name: 'ml', prefix },
      'C:\\proj\\work',
      {
        ...win,
        env: { PATH: 'C:\\Windows\\system32', Path: 'C:\\Windows\\system32' },
        existsSync: (file) =>
          file === python ||
          file === `${prefix}\\conda-meta` ||
          file === prefix ||
          file === `${prefix}\\Scripts` ||
          file === `${prefix}\\Library\\bin`,
        helperExistsSync: (file) => file === helper
      },
      helper
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.python).toBe(python)
    expect(result.args).toEqual(['-u', helper])
    expect(result.cwd).toBe('C:\\proj\\work')
    expect(result.env.PYTHONUNBUFFERED).toBe('1')
    expect(result.env.CONDA_PREFIX).toBe(prefix)
    expect(result.env.CONDA_DEFAULT_ENV).toBe('ml')
    const pathValue = result.env.PATH || result.env.Path || ''
    expect(pathValue.toLowerCase().startsWith(prefix.toLowerCase())).toBe(true)
  })

  it('prepends Unix conda bin onto PATH the same way terminals do', () => {
    const prefix = '/home/me/miniconda3/envs/ml'
    const python = `${prefix}/bin/python`
    const helper = '/app/notebook-kernel.py'
    const result = prepareNotebookKernelSpawn(
      { name: 'ml', prefix },
      '/proj',
      {
        ...posix,
        env: { PATH: '/usr/bin' },
        existsSync: (file) =>
          file === python ||
          file === `${prefix}/conda-meta` ||
          file === `${prefix}/bin`,
        helperExistsSync: (file) => file === helper
      },
      helper
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.python).toBe(python)
    expect(result.env.PATH.split(':')[0]).toBe(`${prefix}/bin`)
  })
})

describe('notebook conda override vs project default', () => {
  it('defaults to the project env when the notebook has no override', () => {
    const project = { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' }
    expect(notebookKernelCondaSelection(null, project)).toEqual(project)
    expect(notebookCondaOverridePayload(null)).toBeUndefined()
  })

  it('prefers the notebook override for spawn', () => {
    const project = { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' }
    const override = { condaEnvName: 'ml', condaEnvPrefix: 'C:\\ml' }
    const selection = notebookKernelCondaSelection(override, project)
    expect(selection).toEqual(override)
    expect(notebookCondaOverridePayload(override)).toEqual({ name: 'ml', prefix: 'C:\\ml' })

    const prefix = 'C:\\ml'
    const python = `${prefix}\\python.exe`
    const helper = 'C:\\app\\notebook-kernel.py'
    const spawnEnv = condaEnvInfoForNotebookSpawn(selection, {
      name: 'ml',
      prefix
    })
    const result = prepareNotebookKernelSpawn(
      spawnEnv,
      'C:\\proj',
      {
        ...win,
        env: { PATH: 'C:\\Windows\\system32', Path: 'C:\\Windows\\system32' },
        existsSync: (file) =>
          file === python ||
          file === `${prefix}\\conda-meta` ||
          file === prefix ||
          file === `${prefix}\\Scripts` ||
          file === `${prefix}\\Library\\bin`,
        helperExistsSync: (file) => file === helper
      },
      helper
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.python).toBe(python)
    expect(result.env.CONDA_DEFAULT_ENV).toBe('ml')
    expect(result.env.CONDA_PREFIX).toBe(prefix)
  })

  it('does not fall back to the project env when the override is stale', () => {
    const selection = notebookKernelCondaSelection(
      { condaEnvName: 'gone', condaEnvPrefix: 'D:\\gone\\envs\\gone' },
      { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' }
    )
    expect(condaEnvInfoForNotebookSpawn(selection, null)).toEqual({
      name: 'gone',
      prefix: 'D:\\gone\\envs\\gone'
    })
  })

  it('fails closed: unlisted override prefix does not spawn even if python.exe exists', () => {
    const prefix = 'D:\\not-listed\\python-folder'
    const python = `${prefix}\\python.exe`
    // Disk lookup would accept this folder (python.exe present).
    expect(
      condaPythonExecutable(prefix, {
        ...win,
        existsSync: (file) => file === python
      })
    ).toBe(python)

    const project = { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' }
    const override = { condaEnvName: 'evil', condaEnvPrefix: prefix }
    const listed = [{ name: 'proj', prefix: 'C:\\proj-env' }]
    const result = resolveNotebookKernelCondaEnv(
      override,
      project,
      listed,
      { name: 'proj', prefix: 'C:\\proj-env' },
      'win32'
    )
    expect(result).toEqual({
      ok: false,
      code: 'stale-conda',
      error: NOTEBOOK_ERROR_STALE_CONDA
    })
  })

  it('spawns a listed override env from the live conda list', () => {
    const listed = [
      { name: 'proj', prefix: 'C:\\proj-env' },
      { name: 'ml', prefix: 'C:\\ml' }
    ]
    const result = resolveNotebookKernelCondaEnv(
      { condaEnvName: 'ml', condaEnvPrefix: 'C:\\ml' },
      { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' },
      listed,
      { name: 'proj', prefix: 'C:\\proj-env' },
      'win32'
    )
    expect(result).toEqual({ ok: true, env: { name: 'ml', prefix: 'C:\\ml' } })
  })

  it('keeps the project-default resolve when there is no override', () => {
    const project = { condaEnvName: 'proj', condaEnvPrefix: 'C:\\proj-env' }
    const projectResolved = { name: 'proj', prefix: 'C:\\proj-env' }
    expect(
      resolveNotebookKernelCondaEnv(null, project, [], projectResolved, 'win32')
    ).toEqual({ ok: true, env: projectResolved })
    // Unlisted project prefix still reconstructs (project path unchanged).
    expect(
      resolveNotebookKernelCondaEnv(null, project, [], null, 'win32')
    ).toEqual({ ok: true, env: { name: 'proj', prefix: 'C:\\proj-env' } })
  })

  it('treats a picker change as a new start/restart payload', () => {
    const before = notebookCondaOverridePayload(null)
    const after = notebookCondaOverridePayload({
      condaEnvName: 'scipy',
      condaEnvPrefix: '/home/me/miniconda3/envs/scipy'
    })
    expect(before).toBeUndefined()
    expect(after).toEqual({ name: 'scipy', prefix: '/home/me/miniconda3/envs/scipy' })
    expect(after).not.toEqual(before)
  })
})
