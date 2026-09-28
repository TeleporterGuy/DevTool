// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  highlightNotebookCodeHtml,
  NOTEBOOK_CODE_PREVIEW_CODE_CLASS
} from '../src/renderer/components/notebookCodePreview'

describe('highlightNotebookCodeHtml', () => {
  it('highlights python tokens and wraps callers can attach hljs classes', () => {
    const html = highlightNotebookCodeHtml('def greet():\n    print("hi")')
    expect(NOTEBOOK_CODE_PREVIEW_CODE_CLASS).toBe('hljs language-python')
    expect(html).toContain('hljs-')
    expect(html).toContain('def')
    expect(html).toContain('print')
    expect(html).toMatch(/<span class="hljs-[^"]+">/)
  })

  it('escapes HTML in source instead of passing it through', () => {
    const html = highlightNotebookCodeHtml('print("<script>alert(1)</script>")')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;/script&gt;')
  })

  it('strips tags if a highlight pass ever emitted them', () => {
    const html = highlightNotebookCodeHtml('<img src=x onerror=alert(1)>')
    expect(html).not.toMatch(/<img/i)
    expect(html).toContain('&lt;img')
  })
})
