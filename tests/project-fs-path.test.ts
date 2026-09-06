import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveSafeProjectPath } from '../src/main/project-fs-path'

describe('resolveSafeProjectPath', () => {
  it('resolves a nested relative path on Windows', () => {
    const resolved = resolveSafeProjectPath('C:\\proj', 'src/file.ts', path.win32)
    expect(resolved.toLowerCase()).toBe('c:\\proj\\src\\file.ts')
  })

  it('allows reading the project root', () => {
    expect(resolveSafeProjectPath('C:\\proj', '', path.win32).toLowerCase()).toBe('c:\\proj')
  })

  it('rejects .. escape', () => {
    expect(() => resolveSafeProjectPath('C:\\proj', '..\\secret', path.win32)).toThrow(
      /Path traversal not allowed/
    )
  })

  it('rejects another drive on Windows', () => {
    expect(() => resolveSafeProjectPath('C:\\proj', 'D:\\other', path.win32)).toThrow(
      /Path traversal not allowed/
    )
  })
})
