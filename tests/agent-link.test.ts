import { describe, expect, it } from 'vitest'
import { MAX_SNIPPET_CHARS, agentLinkPath, formatAgentLink, formatAgentSnippet, pickAgentTarget, selectionLines, sliceLines } from '../src/shared/agent-link'
import type { Tab } from '../src/shared/types'

describe('formatAgentLink', () => {
  it('links a whole file as an @ mention', () => {
    expect(formatAgentLink({ path: 'src/foo.ts' })).toBe('@src/foo.ts ')
  })

  it('writes a selection as a bare path + range, so Claude does not attach the whole file', () => {
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 10, endLine: 24 })).toBe('src/foo.ts (lines 10-24) ')
  })

  it('says "line" for a single line', () => {
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 7, endLine: 7 })).toBe('src/foo.ts (line 7) ')
    expect(formatAgentLink({ path: 'src/foo.ts', startLine: 7 })).toBe('src/foo.ts (line 7) ')
  })

  it('names a notebook cell by position, plus its id when known', () => {
    expect(formatAgentLink({ path: 'nb.ipynb', cellNumber: 4 })).toBe('nb.ipynb (cell 4) ')
    expect(formatAgentLink({ path: 'nb.ipynb', cellNumber: 4, cellId: '3c8d9b5c' })).toBe('nb.ipynb (cell 4, id 3c8d9b5c) ')
    expect(formatAgentLink({ path: 'nb.ipynb', cellNumber: 4, cellId: '3c8d9b5c', startLine: 9, endLine: 21 }))
      .toBe('nb.ipynb (cell 4, id 3c8d9b5c, lines 9-21) ')
    expect(formatAgentLink({ path: 'nb.ipynb', cellId: 'abc' })).toBe('nb.ipynb (cell id abc) ')
  })

  it('quotes paths with whitespace so the path stays one token', () => {
    expect(formatAgentLink({ path: 'my dir/foo.ts', startLine: 3 })).toBe('"my dir/foo.ts" (line 3) ')
    expect(formatAgentLink({ path: 'my dir/foo.ts' })).toBe('@"my dir/foo.ts" ')
  })

  it('uses forward slashes for Windows-style input', () => {
    expect(formatAgentLink({ path: 'src\\sub\\foo.ts' })).toBe('@src/sub/foo.ts ')
  })

  it('ends a directory link with a slash', () => {
    expect(formatAgentLink({ path: 'src/lib', isDirectory: true })).toBe('@src/lib/ ')
    expect(formatAgentLink({ path: 'src/lib/', isDirectory: true })).toBe('@src/lib/ ')
  })
})

describe('formatAgentSnippet', () => {
  it('sends the selected lines under a header naming them', () => {
    expect(formatAgentSnippet({ path: 'src/foo.ts', startLine: 2, endLine: 3, text: 'a()\nb()\n', language: 'typescript' }))
      .toBe('src/foo.ts (lines 2-3):\n```typescript\na()\nb()\n```\n')
  })

  it('names a notebook cell as a 1-based position of the total, plus its id', () => {
    expect(formatAgentSnippet({ path: 'nb.ipynb', cellNumber: 1, cellCount: 5, cellId: '6cf3d1c6', text: 'import panel', language: 'python' }))
      .toBe('nb.ipynb (cell 1 of 5, id 6cf3d1c6):\n```python\nimport panel\n```\n')
  })

  it('uses a fence longer than any backtick run inside the text', () => {
    const snippet = formatAgentSnippet({ path: 'README.md', startLine: 1, text: 'see:\n```js\nx\n```', language: 'markdown' })!
    expect(snippet.startsWith('README.md (line 1):\n````markdown\n')).toBe(true)
    expect(snippet.endsWith('\n````\n')).toBe(true)
  })

  it('normalizes CRLF', () => {
    expect(formatAgentSnippet({ path: 'a.txt', startLine: 1, endLine: 2, text: 'x\r\ny' }))
      .toBe('a.txt (lines 1-2):\n```\nx\ny\n```\n')
  })

  it('gives up on very large selections so a pointer is sent instead', () => {
    expect(formatAgentSnippet({ path: 'big.txt', startLine: 1, text: 'x'.repeat(MAX_SNIPPET_CHARS + 1) })).toBeNull()
  })
})

describe('sliceLines', () => {
  it('returns an inclusive 1-based range', () => {
    expect(sliceLines('a\nb\nc\nd', 2, 3)).toBe('b\nc')
    expect(sliceLines('a\r\nb', 2, 2)).toBe('b')
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
