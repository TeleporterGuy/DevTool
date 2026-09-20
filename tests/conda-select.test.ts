import { describe, expect, it } from 'vitest'
import {
  CONDA_SAVED_NAME_PREFIX,
  condaEnvFromSelection,
  condaEnvsMatchingName,
  condaSavedOptionLabel,
  condaSavedOptionVisible,
  condaSelectValue,
  lastPathSegment,
  listedCondaEnvForSelection
} from '../src/shared/conda'

const envs = [
  { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
  { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' },
  { name: 'ml', prefix: 'D:\\other\\envs\\ml' }
]

describe('conda select helpers', () => {
  it('uses prefix as the unique dropdown value', () => {
    expect(
      condaSelectValue({ condaEnvName: 'ml', condaEnvPrefix: 'D:\\other\\envs\\ml' }, envs, 'win32')
    ).toBe('D:\\other\\envs\\ml')
  })

  it('maps a unique name-only save onto that env prefix', () => {
    const unique = [envs[0], envs[1]]
    expect(condaSelectValue({ condaEnvName: 'ml' }, unique, 'win32')).toBe(
      'C:\\Users\\me\\miniconda3\\envs\\ml'
    )
  })

  it('keeps a (saved) name value when the name is missing or duplicated', () => {
    expect(condaSelectValue({ condaEnvName: 'gone' }, envs, 'win32')).toBe(
      `${CONDA_SAVED_NAME_PREFIX}gone`
    )
    expect(condaSelectValue({ condaEnvName: 'ml' }, envs, 'win32')).toBe(
      `${CONDA_SAVED_NAME_PREFIX}ml`
    )
  })

  it('persists both name and prefix from a listed option', () => {
    expect(condaEnvFromSelection('D:\\other\\envs\\ml', envs)).toEqual({
      condaEnvName: 'ml',
      condaEnvPrefix: 'D:\\other\\envs\\ml'
    })
    expect(condaEnvFromSelection('', envs)).toEqual({
      condaEnvName: undefined,
      condaEnvPrefix: undefined
    })
  })

  it('shows a saved option for unmatched prefix or name', () => {
    expect(condaSavedOptionVisible('D:\\gone\\envs\\ml', envs)).toBe(true)
    expect(condaSavedOptionVisible('C:\\Users\\me\\miniconda3\\envs\\ml', envs)).toBe(false)
    expect(condaSavedOptionLabel('D:\\gone\\envs\\ml', 'ml')).toBe('ml (saved)')
    expect(condaSavedOptionLabel(`${CONDA_SAVED_NAME_PREFIX}gone`)).toBe('gone (saved)')
    expect(lastPathSegment('C:\\Users\\me\\miniconda3\\envs\\ml')).toBe('ml')
  })

  it('case-folds a Windows name only when a single env matches', () => {
    const listed = [{ name: 'ML', prefix: 'D:\\envs\\ML' }]
    expect(condaEnvsMatchingName(listed, 'ml', 'win32')).toEqual(listed)
    expect(condaEnvsMatchingName(listed, 'ml', 'linux')).toEqual([])
    expect(
      condaEnvsMatchingName(
        [
          { name: 'ML', prefix: 'D:\\envs\\ML' },
          { name: 'Ml', prefix: 'E:\\envs\\Ml' }
        ],
        'ml',
        'win32'
      )
    ).toEqual([])
  })
})

describe('listedCondaEnvForSelection', () => {
  it('matches a live prefix, including Windows case-insensitive unique prefix', () => {
    expect(
      listedCondaEnvForSelection(envs, { condaEnvName: 'ml', condaEnvPrefix: 'D:\\other\\envs\\ml' }, 'win32')
    ).toEqual(envs[2])
    expect(
      listedCondaEnvForSelection(
        [{ name: 'ml', prefix: 'D:\\envs\\ML' }],
        { condaEnvPrefix: 'd:\\envs\\ml' },
        'win32'
      )
    ).toEqual({ name: 'ml', prefix: 'D:\\envs\\ML' })
  })

  it('matches a unique name only when no prefix is saved', () => {
    const unique = [envs[0], envs[1]]
    expect(listedCondaEnvForSelection(unique, { condaEnvName: 'ml' }, 'win32')).toEqual(envs[1])
  })

  it('returns null for an unlisted prefix even if the name exists in the list', () => {
    expect(
      listedCondaEnvForSelection(
        envs,
        { condaEnvName: 'base', condaEnvPrefix: 'D:\\not-listed\\python-folder' },
        'win32'
      )
    ).toBeNull()
  })
})
