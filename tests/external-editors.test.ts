import { describe, expect, it } from 'vitest'
import { localProjectFolder, paletteAliasesForEditor, resolveDefaultExternalEditor } from '../src/shared/external-editors'
import type { Project, Task } from '../src/shared/types'

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    directory: 'C:\\Repos\\demo',
    tasks: [],
    ...patch
  }
}

describe('external editor helpers', () => {
  it('falls back to the first editor when defaultId is missing', () => {
    const editors = [
      { id: 'a', name: 'VS Code', command: 'Code.exe', extraArgs: '' },
      { id: 'b', name: 'Cursor', command: 'Cursor.exe', extraArgs: '' }
    ]
    expect(resolveDefaultExternalEditor({ editors, defaultId: null })?.id).toBe('a')
    expect(resolveDefaultExternalEditor({ editors, defaultId: 'b' })?.id).toBe('b')
  })

  it('adds vscode aliases for Visual Studio Code', () => {
    expect(paletteAliasesForEditor('Visual Studio Code')).toEqual(
      expect.arrayContaining(['vscode', 'code'])
    )
  })

  it('uses the worktree folder for workspace tasks', () => {
    const task: Task = {
      id: 't1',
      name: 'branch',
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5,
      workspace: {
        worktreePath: 'C:\\Repos\\demo-wt',
        branchName: 'feat',
        baseBranch: 'master',
        relativeProjectPath: 'apps\\web'
      }
    }
    expect(localProjectFolder(project(), task)).toBe('C:\\Repos\\demo-wt\\apps\\web')
  })

  it('returns null for remote projects', () => {
    expect(localProjectFolder(project({ ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/x' } }), null)).toBeNull()
  })
})
