import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

export const NOTEBOOK_CODE_HIGHLIGHT_LANGUAGE = 'python'
export const NOTEBOOK_CODE_PREVIEW_CODE_CLASS = `hljs language-${NOTEBOOK_CODE_HIGHLIGHT_LANGUAGE}`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Syntax-highlight idle notebook code (no Monaco).
 * highlight.js escapes the source into span tokens; DOMPurify is a second pass
 * so we never drop raw user HTML into innerHTML.
 */
export function highlightNotebookCodeHtml(source: string): string {
  const text = source.length > 0 ? source : ' '
  let highlighted: string
  try {
    highlighted = hljs.getLanguage(NOTEBOOK_CODE_HIGHLIGHT_LANGUAGE)
      ? hljs.highlight(text, {
          language: NOTEBOOK_CODE_HIGHLIGHT_LANGUAGE,
          ignoreIllegals: true
        }).value
      : escapeHtml(text)
  } catch {
    highlighted = escapeHtml(text)
  }
  return DOMPurify.sanitize(highlighted, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class']
  })
}
