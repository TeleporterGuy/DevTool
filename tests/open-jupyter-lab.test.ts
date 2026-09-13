// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { commandRegistry } from '../src/renderer/palette/CommandRegistry'
import '../src/renderer/palette/sources/commands'
import { findJupyterBrowserTab, pickJupyterTask, openJupyterLabForProject } from '../src/renderer/openJupyterLab'
import { JUPYTER_ERRORS, JUPYTER_LAB_TITLE } from '../src/shared/jupyter'
import { createHomeTask, DEFAULT_CONFIG, type Project, type Task } from '../src/shared/types'
import type { AppActions } from '../src/renderer/hooks/useAppState'

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Main',
    tabs: { left: [], right: [] },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    ...patch
  }
}

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    directory: 'C:\\Repos\\demo',
    tasks: [task()],
    ...patch
  }
}

describe('pickJupyterTask', () => {
  it('uses the selected non-home task', () => {
    const home = createHomeTask('p1').task
    const main = task()
    const other = task({ id: 't2', name: 'Other', lastInteractedAt: 9 })
    expect(pickJupyterTask(project({ tasks: [home, main, other] }), 't1')?.id).toBe('t1')
  })

  it('skips Home and falls back to the most recently touched task', () => {
    const home = createHomeTask('p1').task
    const older = task({ id: 'old', lastInteractedAt: 1 })
    const newer = task({ id: 'new', lastInteractedAt: 50 })
    expect(pickJupyterTask(project({ tasks: [home, older, newer] }), home.id)?.id).toBe('new')
  })
})

describe('findJupyterBrowserTab', () => {
  it('finds a browser tab already on that Jupyter origin', () => {
    const found = findJupyterBrowserTab(
      task({
        tabs: {
          left: [{ id: 'b1', type: 'browser', title: 'Browser', url: 'http://127.0.0.1:8888/lab/tree' }],
          right: []
        }
      }),
      'http://127.0.0.1:8888/lab?token=abc'
    )
    expect(found?.tab.id).toBe('b1')
    expect(found?.pane).toBe('left')
  })

  it('ignores unrelated browser tabs', () => {
    expect(
      findJupyterBrowserTab(
        task({
          tabs: {
            left: [{ id: 'b1', type: 'browser', title: 'Browser', url: 'https://example.com' }],
            right: []
          }
        }),
        'http://127.0.0.1:8888/lab?token=abc'
      )
    ).toBeNull()
  })
})

describe('openJupyterLabForProject', () => {
  it('opens a titled browser tab at the server URL', async () => {
    const addTab = vi.fn()
    const switchToTask = vi.fn()
    const demo = project()
    const actions = {
      projects: [demo],
      selectedProjectId: 'p1',
      selectedTaskId: 't1',
      addTab,
      switchToTask,
      setActiveTab: vi.fn(),
      updateTabUrl: vi.fn()
    } as unknown as AppActions

    const jupyterOpen = vi.fn().mockResolvedValue({
      ok: true,
      url: 'http://127.0.0.1:8888/lab?token=abc',
      reused: false,
      port: 8888
    })
    ;(window as unknown as { api: { jupyterOpen: typeof jupyterOpen } }).api = { jupyterOpen }

    expect(await openJupyterLabForProject(actions)).toBeNull()
    expect(jupyterOpen).toHaveBeenCalledWith('p1', 'C:\\Repos\\demo')
    expect(switchToTask).toHaveBeenCalledWith('p1', 't1')
    expect(addTab).toHaveBeenCalledWith('p1', 't1', 'left', 'browser', {
      url: 'http://127.0.0.1:8888/lab?token=abc',
      title: JUPYTER_LAB_TITLE
    })
  })

  it('reuses a browser tab already on that server', async () => {
    const addTab = vi.fn()
    const setActiveTab = vi.fn()
    const demo = project({
      tasks: [
        task({
          tabs: {
            left: [{
              id: 'b1',
              type: 'browser',
              title: 'JupyterLab',
              url: 'http://127.0.0.1:8888/lab?token=old'
            }],
            right: []
          }
        })
      ]
    })
    const actions = {
      projects: [demo],
      selectedProjectId: 'p1',
      selectedTaskId: 't1',
      addTab,
      switchToTask: vi.fn(),
      setActiveTab,
      updateTabUrl: vi.fn()
    } as unknown as AppActions
    ;(window as unknown as { api: { jupyterOpen: () => Promise<unknown> } }).api = {
      jupyterOpen: vi.fn().mockResolvedValue({
        ok: true,
        url: 'http://127.0.0.1:8888/lab?token=new',
        reused: true,
        port: 8888
      })
    }

    expect(await openJupyterLabForProject(actions)).toBeNull()
    expect(addTab).not.toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith('p1', 't1', 'left', 'b1')
  })

  it('returns a clear error for remote projects', async () => {
    const actions = {
      projects: [project({ ssh: { host: 'box', username: 'me', port: 22, remoteDir: '/home/me' } })],
      selectedProjectId: 'p1',
      selectedTaskId: 't1'
    } as unknown as AppActions
    expect(await openJupyterLabForProject(actions)).toBe(JUPYTER_ERRORS.notLocal)
  })
})

describe('palette Open JupyterLab command', () => {
  it('is available on a local project and hidden for SSH / shell-command projects', () => {
    const cmd = commandRegistry.getById('cmd.openJupyterLab')
    expect(cmd?.title).toBe('Open JupyterLab for this project')

    const local = {
      actions: {
        selectedProjectId: 'p1',
        projects: [project()],
        config: DEFAULT_CONFIG
      }
    }
    expect(cmd?.when?.(local as never)).toBe(true)

    const remote = {
      actions: {
        selectedProjectId: 'p1',
        projects: [project({ ssh: { host: 'box', username: 'me', port: 22, remoteDir: '/x' } })]
      }
    }
    expect(cmd?.when?.(remote as never)).toBe(false)

    const shell = {
      actions: {
        selectedProjectId: 'p1',
        projects: [project({ shellCommand: { command: 'echo' } })]
      }
    }
    expect(cmd?.when?.(shell as never)).toBe(false)
  })
})
