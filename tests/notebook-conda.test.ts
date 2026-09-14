import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { condaPythonExecutable, resetCondaEnvForTests } from '../src/main/conda-env'
import {
  prepareNotebookKernelSpawn
} from '../src/main/notebook-kernel'
import { NOTEBOOK_ERROR_NO_CONDA, NOTEBOOK_ERROR_NO_PYTHON } from '../src/shared/notebook'
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
