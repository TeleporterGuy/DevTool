import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  isWindowsAbsolutePath,
  joinWorkspaceDir,
  posixRelativeJoin,
  toPosixRelative
} from '../src/shared/workspace-path'

describe('joinWorkspaceDir', () => {
  it('joins a Windows worktree with a nested posix relative path', () => {
    expect(joinWorkspaceDir('C:\\repo\\.worktrees\\feat', 'apps/web')).toBe(
      path.win32.join('C:\\repo\\.worktrees\\feat', 'apps/web')
    )
  })

  it('joins POSIX remote worktrees with /', () => {
    expect(joinWorkspaceDir('/home/deploy/app/.worktrees/feat', 'apps/web')).toBe(
      '/home/deploy/app/.worktrees/feat/apps/web'
    )
  })

  it('returns the worktree when relative is empty', () => {
    expect(joinWorkspaceDir('C:\\repo\\.worktrees\\feat', '')).toBe('C:\\repo\\.worktrees\\feat')
  })
})

describe('posixRelativeJoin', () => {
  it('never emits backslashes', () => {
    expect(posixRelativeJoin('src\\nested', 'file.ts')).toBe('src/nested/file.ts')
    expect(posixRelativeJoin('', 'file.ts')).toBe('file.ts')
  })
})

describe('toPosixRelative', () => {
  it('converts win32 relative segments', () => {
    expect(toPosixRelative('apps\\web')).toBe('apps/web')
  })
})

describe('isWindowsAbsolutePath', () => {
  it('detects drive letters and UNC', () => {
    expect(isWindowsAbsolutePath('D:\\repos\\app')).toBe(true)
    expect(isWindowsAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isWindowsAbsolutePath('/home/me/app')).toBe(false)
  })
})
