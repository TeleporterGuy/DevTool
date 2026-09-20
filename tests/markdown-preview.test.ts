import { describe, expect, it } from 'vitest'
import { markdownPreviewClassName } from '../src/renderer/components/MarkdownPreview'

describe('markdownPreviewClassName', () => {
  it('keeps note/editor absolute preview padded as before', () => {
    const cls = markdownPreviewClassName('absolute')
    expect(cls).toContain('note-preview')
    expect(cls).toContain('px-8')
    expect(cls).toContain('py-6')
    expect(cls).not.toContain('notebook-preview')
  })

  it('adds notebook cell padding without the notes-pane padding', () => {
    const cls = markdownPreviewClassName('notebook')
    expect(cls).toContain('note-preview')
    expect(cls).toContain('notebook-preview')
    expect(cls).toContain('px-3')
    expect(cls).toContain('py-2')
    expect(cls).not.toContain('px-8')
    expect(cls).not.toContain('py-6')
  })

  it('leaves flow without extra padding', () => {
    const cls = markdownPreviewClassName('flow')
    expect(cls).toContain('note-preview')
    expect(cls).not.toContain('notebook-preview')
    expect(cls).not.toContain('px-3')
    expect(cls).not.toContain('px-8')
  })
})
