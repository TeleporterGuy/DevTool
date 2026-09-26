// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, createHomeTask, type Project, type ProjectsData } from '../src/shared/types'
import { AppProvider } from '../src/renderer/context/AppContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import Sidebar from '../src/renderer/components/Sidebar'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * Smoke test for the sidebar after its context menu, row parts and drag logic
 * moved out into `components/sidebar/`: the full tree renders against the real
 * app state, and the extracted menu still drives app actions.
 */

function buildProjects(): Project[] {
  const { task: home } = createHomeTask('p1')
  const work = {
    id: 't1',
    name: 'Fix the thing',
    tabs: { left: [], right: [] },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5
  }
  return [{ id: 'p1', name: 'Alpha Project', directory: '/tmp/alpha', tasks: [home, work] }]
}

let saved: ProjectsData[]

beforeEach(() => {
  saved = []
  const known: Record<string, unknown> = {
    loadProjects: vi.fn().mockResolvedValue({
      revision: 0,
      data: { projects: buildProjects(), tags: [], projectOrder: ['p1'], pinnedItems: [] }
    }),
    loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
    loadWindowState: vi.fn().mockResolvedValue({ expandedProjectIds: ['p1'], sidebarTab: 'projects' }),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    saveProjects: vi.fn().mockImplementation((payload: { data: ProjectsData }) => {
      saved.push(payload.data)
      return Promise.resolve({ ok: true, revision: saved.length })
    }),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    sshStatus: vi.fn().mockResolvedValue('disconnected')
  }
  // Everything else the tree touches is a listener (returns a cleanup) or a
  // fire-and-forget call.
  ;(window as any).api = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      const fn = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(() => Promise.resolve(undefined))
      target[prop] = fn
      return fn
    }
  })
  // dashboard icon metadata fetch
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderSidebar() {
  return render(
    <TabStatusProvider>
      <AppProvider>
        <Sidebar />
      </AppProvider>
    </TabStatusProvider>
  )
}

describe('Sidebar context menu', () => {
  it('opens on a task row and settles the task', async () => {
    renderSidebar()
    const row = await screen.findByText('Fix the thing')

    fireEvent.contextMenu(row)
    // By text: the row's own hover action is also a button titled 'Settle'.
    const settle = await screen.findByText('Settle', { selector: 'button' })
    act(() => { fireEvent.click(settle) })

    await waitFor(() => {
      const task = saved[saved.length - 1]?.projects[0].tasks.find(t => t.id === 't1')
      expect(task?.inbox?.settledAt).toBeTypeOf('number')
    })
    expect(screen.queryByText('Settle', { selector: 'button' })).toBeNull()
  })

  it('pages to the snooze presets and back out on dismiss', async () => {
    renderSidebar()
    fireEvent.contextMenu(await screen.findByText('Fix the thing'))
    fireEvent.click(await screen.findByRole('button', { name: /Snooze/ }))

    // The presets replace the menu body.
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)

    act(() => { window.dispatchEvent(new MouseEvent('mousedown')) })
    expect(screen.queryByRole('button', { name: /Snooze/ })).toBeNull()
  })

  it('shows project details and pins a project', async () => {
    renderSidebar()
    await screen.findByText('Alpha Project')
    fireEvent.contextMenu(document.querySelector('[data-drag-type="project"][data-drag-id="p1"]')!)

    expect((await screen.findByTitle('/tmp/alpha')).textContent).toBe('Dir: /tmp/alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Pin project' }))

    await waitFor(() => {
      expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'project', projectId: 'p1' }])
    })
  })
})
