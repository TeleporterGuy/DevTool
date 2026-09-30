import { describe, expect, it } from 'vitest'
import { addChatTab } from '../src/main/mobile/new-chat'
import { createHomeTask, type ProjectsData } from '../src/shared/types'

function data(extra: Partial<ProjectsData['projects'][number]> = {}): ProjectsData {
  const home = createHomeTask('p1').task
  return {
    projects: [{
      id: 'p1', name: 'api', directory: '/src/api', ...extra,
      tasks: [home, {
        id: 't1', name: 'fix-auth',
        tabs: { left: [{ id: 'tab-term', type: 'terminal', title: 'zsh' }], right: [{ id: 'tab-r', type: 'browser', title: 'Browser' }] },
        activeTab: { left: 'tab-term', right: 'tab-r' }, splitOpen: true, splitRatio: 0.5
      }]
    }],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  } as ProjectsData
}

function counter(): () => string {
  let n = 0
  return () => `id-${++n}`
}

describe('addChatTab (SPEC.md §8.2)', () => {
  it('appends a claude-chat tab with fresh ids to the left pane and leaves the rest alone', () => {
    const before = data()
    const result = addChatTab(before, 't1', counter())
    expect(result).toMatchObject({ ok: true, tabId: 'id-1' })
    if (!result.ok) return
    const task = result.data.projects[0].tasks[1]
    expect(task.tabs.left).toEqual([
      { id: 'tab-term', type: 'terminal', title: 'zsh' },
      { id: 'id-1', type: 'claude-chat', title: 'Claude', sessionId: 'id-2' }
    ])
    expect(task.tabs.right).toBe(before.projects[0].tasks[1].tabs.right)
    // The desktop's own view isn't switched to the new tab.
    expect(task.activeTab).toEqual({ left: 'tab-term', right: 'tab-r' })
    // The input is not mutated.
    expect(before.projects[0].tasks[1].tabs.left).toHaveLength(1)
  })

  it('refuses unknown and home tasks, hidden projects and shell-command projects', () => {
    const home = data().projects[0].tasks[0].id
    expect(addChatTab(data(), 'nope')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addChatTab(data(), home)).toMatchObject({ ok: false, code: 'not-found' })
    expect(addChatTab(data({ hideFromMobile: true }), 't1')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addChatTab(data({ shellCommand: { command: 'npm run dev' } }), 't1')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
