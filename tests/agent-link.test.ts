import { describe, expect, it } from 'vitest'
import { agentLinkPath, formatAgentLink, pickAgentTarget, selectionLines } from '../src/shared/agent-link'
import type { Tab } from '../src/shared/types'

describe('formatAgentLink', () => {
  it('links a whole file as a bare @path', () => {
    expect(formatAgentLink({ path: 'src/foo.ts' })).toBe('@src/foo.ts ')
  })

  it('puts a line range after the path, in words', () => {
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 10, endLine: 24 })).toBe('@src/foo.ts (lines 10-24) ')
  })

  it('says "line" for a single line', () => {
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 7, endLine: 7 })).toBe('@src/foo.ts (line 7) ')
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 7 })).toBe('@src/foo.ts (line 7) ')
  })

  it('names the notebook cell, with and without lines', () => {
    expect(formatAgentLink({ path: 'analysis.ipynb', cellId: '3f9a1c' })).toBe('@analysis.ipynb (cell 3f9a1c) ')
    expect(formatAgentLink({ path: 'analysis.ipynb', cellId: '3f9a1c', startLine: 3, endLine: 5 }))
      .toBe('@analysis.ipynb (cell 3f9a1c, lines 3-5) ')
  })

  it('quotes paths with whitespace so the mention stays one token', () => {
    expect(formatAgentLink({ path: 'my dir/foo.ts', startLine: 3 })).toBe('@"my dir/foo.ts" (line 3) ')
  })

  it('uses forward slashes for Windows-style input', () => {
    expect(formatAgentLink({ path: 'src\\sub\\foo.ts' })).toBe('@src/sub/foo.ts ')
  })

  it('ends a directory link with a slash', () => {
    expect(formatAgentLink({ path: 'src/lib', isDirectory: true })).toBe('@src/lib/ ')
    expect(formatAgentLink({ path: 'src/lib/', isDirectory: true })).toBe('@src/lib/ ')
  })
})

describe('selectionLines', () => {
  it('treats an empty selection as the cursor line', () => {
    expect(selectionLines({ startLineNumber: 4, startColumn: 3, endLineNumber: 4, endColumn: 3 }))
      .toEqual({ startLine: 4, endLine: 4 })
  })

  it('covers every line the selection touches', () => {
    expect(selectionLines({ startLineNumber: 2, startColumn: 5, endLineNumber: 6, endColumn: 2 }))
      .toEqual({ startLine: 2, endLine: 6 })
  })

  it('drops a last line the selection only reaches at column 1', () => {
    expect(selectionLines({ startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 1 }))
      .toEqual({ startLine: 2, endLine: 4 })
  })

  it('handles a selection made upwards', () => {
    expect(selectionLines({ startLineNumber: 9, startColumn: 4, endLineNumber: 3, endColumn: 2 }))
      .toEqual({ startLine: 3, endLine: 9 })
  })
})

describe('agentLinkPath', () => {
  it('keeps the workspace-relative path when the agent runs in the workspace', () => {
    expect(agentLinkPath('/repo', 'src/foo.ts')).toBe('src/foo.ts')
    expect(agentLinkPath('/repo', 'src/foo.ts', '/repo/')).toBe('src/foo.ts')
  })

  it('normalizes Windows separators', () => {
    expect(agentLinkPath('C:\\repo', 'src\\foo.ts', 'C:\\repo')).toBe('src/foo.ts')
  })

  it('matches Windows drive paths case-insensitively', () => {
    expect(agentLinkPath('C:\\Repo', 'src/foo.ts', 'c:\\repo')).toBe('src/foo.ts')
  })

  it('strips the folder an agent runs in', () => {
    expect(agentLinkPath('/repo', 'apps/web/src/foo.ts', '/repo/apps/web')).toBe('src/foo.ts')
  })

  it('uses an absolute path for a file outside the agent folder', () => {
    expect(agentLinkPath('/repo', 'lib/foo.ts', '/repo/apps/web')).toBe('/repo/lib/foo.ts')
    expect(agentLinkPath('C:\\repo', 'lib\\foo.ts', 'D:\\other')).toBe('C:/repo/lib/foo.ts')
  })
})

describe('pickAgentTarget', () => {
  const tab = (id: string, type: Tab['type']): Tab => ({ id, type, title: id })
  const task = {
    tabs: {
      left: [tab('ed', 'editor'), tab('pi', 'pi'), tab('term', 'terminal')],
      right: [tab('chat', 'claude-chat'), tab('codex', 'codex')]
    },
    activeTab: { left: 'ed', right: 'codex' }
  }

  it('prefers the most recently used agent tab', () => {
    expect(pickAgentTarget(task, ['chat', 'pi'])?.id).toBe('chat')
  })

  it('skips recency entries that are gone or not agents', () => {
    expect(pickAgentTarget(task, ['closed', 'term', 'pi'])?.id).toBe('pi')
  })

  it('falls back to an agent tab active in a pane', () => {
    expect(pickAgentTarget(task)?.id).toBe('codex')
  })

  it('falls back to the first agent tab, left pane first', () => {
    expect(pickAgentTarget({ ...task, activeTab: { left: 'ed', right: null } })?.id).toBe('pi')
  })

  it('returns null when the task has no agent tab', () => {
    expect(pickAgentTarget({ tabs: { left: [tab('ed', 'editor')], right: [tab('t', 'terminal')] } })).toBeNull()
  })
})
