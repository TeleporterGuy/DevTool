// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import NotebookOutputs from '../src/renderer/components/NotebookOutputs'
import MarkdownPreview from '../src/renderer/components/MarkdownPreview'
import { applyKernelEventToOutputs, notebookOutputDisplay, parseKernelEventLine, resolveMarkdownAttachments, type NotebookOutput } from '../src/shared/notebook'

void React

afterEach(() => cleanup())

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('notebookOutputDisplay', () => {
  it('keeps PNG, then plain text, first', () => {
    expect(notebookOutputDisplay({ 'image/png': PNG, 'text/plain': 'x' })).toMatchObject({ kind: 'image' })
    expect(notebookOutputDisplay({ 'text/html': '<b>x</b>', 'text/plain': 'x' })).toEqual({ kind: 'text', text: 'x' })
  })

  it('shows JSON-only output (display(..., raw=True)) pretty-printed', () => {
    expect(notebookOutputDisplay({}, { 'application/json': { a: 1 } })).toEqual({ kind: 'json', text: '{\n  "a": 1\n}' })
  })

  it('uses JPEG, SVG, HTML and markdown when nothing simpler is there', () => {
    expect(notebookOutputDisplay({ 'image/jpeg': 'abc' })).toEqual({ kind: 'image', src: 'data:image/jpeg;base64,abc' })
    expect(notebookOutputDisplay({ 'image/svg+xml': '<svg/>' })?.kind).toBe('image')
    expect(notebookOutputDisplay({ 'text/html': '<b>x</b>' })).toEqual({ kind: 'html', html: '<b>x</b>' })
    expect(notebookOutputDisplay({ 'text/markdown': '# x' })).toEqual({ kind: 'markdown', markdown: '# x' })
  })

  it('prefers rich forms over an IPython display object placeholder', () => {
    const repr = (name: string): string => `<IPython.core.display.${name} object>`
    expect(notebookOutputDisplay({ 'text/html': '<b>x</b>', 'text/plain': repr('HTML') })).toEqual({ kind: 'html', html: '<b>x</b>' })
    expect(notebookOutputDisplay({ 'text/markdown': '# x', 'text/plain': repr('Markdown') })).toEqual({ kind: 'markdown', markdown: '# x' })
    expect(notebookOutputDisplay({ 'text/plain': repr('JSON') }, { 'application/json': { a: 1 } })).toMatchObject({ kind: 'json' })
    expect(notebookOutputDisplay({ 'text/plain': '<Foo object at 0x10a2b>' })).toEqual({ kind: 'text', text: '<Foo object at 0x10a2b>' })
  })

  it('names what it cannot show instead of showing nothing', () => {
    expect(notebookOutputDisplay({ 'application/vnd.custom': 'z' })).toEqual({ kind: 'unsupported', mimeTypes: ['application/vnd.custom'] })
    expect(notebookOutputDisplay({})).toBeNull()
  })
})

describe('live kernel output path', () => {
  it('keeps a JSON-only display_data object through parsing and into the cell outputs', () => {
    const line = JSON.stringify({
      event: 'display_data',
      id: 'req-1',
      data: { 'application/json': { a: 1, message: 'This rich output should survive save/reopen.' } }
    })
    const event = parseKernelEventLine(line)
    expect(event).toMatchObject({ event: 'display_data', data: { 'application/json': { a: 1 } } })
    const outputs = applyKernelEventToOutputs([], event!)!
    const out = outputs[0] as Extract<NotebookOutput, { type: 'display_data' }>
    expect(notebookOutputDisplay(out.data, out.jsonData)).toMatchObject({ kind: 'json' })
    expect((notebookOutputDisplay(out.data, out.jsonData) as { text: string }).text).toContain('"message"')
  })
})

describe('NotebookOutputs rendering', () => {
  it('renders a JSON-only display_data output', () => {
    const outputs: NotebookOutput[] = [{
      type: 'display_data',
      data: {},
      jsonData: { 'application/json': { a: 1, message: 'survives' } }
    }]
    const { container } = render(<NotebookOutputs outputs={outputs} effectiveTheme="dark" />)
    expect(container.textContent).toContain('"message": "survives"')
  })

  it('sanitizes HTML output', () => {
    const outputs: NotebookOutput[] = [{
      type: 'display_data',
      data: { 'text/html': '<table><tr><td>cell</td></tr></table><script>window.__bad = 1</script><img src=x onerror="window.__bad=1">' }
    }]
    const { container } = render(<NotebookOutputs outputs={outputs} effectiveTheme="dark" />)
    expect(container.querySelector('td')?.textContent).toBe('cell')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it('strips CSS from HTML output so it cannot restyle the app', () => {
    const outputs: NotebookOutput[] = [{
      type: 'display_data',
      data: { 'text/html': '<p>a</p><style>body { display: none }</style><div style="position:fixed;inset:0">cover</div>' }
    }]
    const { container } = render(<NotebookOutputs outputs={outputs} effectiveTheme="dark" />)
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('[style]')).toBeNull()
    expect(container.textContent).toContain('cover')
  })
})

describe('markdown attachments', () => {
  const attachments = { 'checker.png': { 'image/png': PNG } }

  it('rewrites attachment: references to data URLs', () => {
    expect(resolveMarkdownAttachments('![alt](attachment:checker.png)', attachments))
      .toBe(`![alt](data:image/png;base64,${PNG})`)
  })

  it('leaves unknown attachments and plain text alone', () => {
    expect(resolveMarkdownAttachments('![a](attachment:missing.png) attachment', attachments))
      .toBe('![a](attachment:missing.png) attachment')
    expect(resolveMarkdownAttachments('![a](attachment:x.png)', undefined)).toBe('![a](attachment:x.png)')
  })

  it('leaves attachment: references inside code alone', () => {
    const source = 'see `attachment:checker.png`\n\n```\n![x](attachment:checker.png)\n```\n\n![y](attachment:checker.png)'
    const out = resolveMarkdownAttachments(source, attachments)
    expect(out).toContain('`attachment:checker.png`')
    expect(out).toContain('```\n![x](attachment:checker.png)\n```')
    expect(out).toContain(`![y](data:image/png;base64,${PNG})`)
  })

  it('handles URL-encoded names', () => {
    const named = { 'my image.png': { 'image/png': PNG } }
    expect(resolveMarkdownAttachments('![a](attachment:my%20image.png)', named)).toContain('data:image/png;base64,')
  })

  it('survives the markdown preview sanitizer as a data: image', () => {
    const content = resolveMarkdownAttachments('![Checkerboard](attachment:checker.png)', attachments)
    const { container } = render(<MarkdownPreview content={content} effectiveTheme="dark" variant="notebook" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
  })
})
