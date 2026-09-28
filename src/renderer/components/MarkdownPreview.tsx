import React, { useMemo } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: false
})

const renderer = new marked.Renderer()
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
}

marked.use({ renderer })

interface Props {
  content: string
  effectiveTheme: 'dark' | 'light'
  /**
   * `absolute` fills the nearest positioned ancestor (notes / editor preview).
   * `flow` lays out in normal document flow with no extra padding.
   * `notebook` is the in-cell markdown preview: padding + denser headings.
   */
  variant?: 'absolute' | 'flow' | 'notebook'
  /** Base font size in px. Notebook preview tracks editorFontSize. */
  fontSize?: number
}

export function markdownPreviewClassName(variant: 'absolute' | 'flow' | 'notebook' = 'absolute'): string {
  if (variant === 'absolute') {
    return 'note-preview absolute inset-0 overflow-y-auto px-8 py-6 font-sans text-md leading-[1.6] text-text bg-bg'
  }
  if (variant === 'notebook') {
    return 'note-preview notebook-preview px-3 py-2 font-sans leading-[1.5] text-text'
  }
  return 'note-preview font-sans text-md leading-[1.6] text-text'
}

export default function MarkdownPreview({
  content,
  variant = 'absolute',
  fontSize
}: Props): React.ReactElement {
  const sanitizedHtml = useMemo(() => {
    const raw = marked.parse(content) as string
    return DOMPurify.sanitize(raw)
  }, [content])

  const style = variant === 'notebook' && fontSize && Number.isFinite(fontSize)
    ? { fontSize: `${fontSize}px` }
    : undefined

  // Content is sanitized via DOMPurify above before being inserted as innerHTML
  return (
    <div
      className={markdownPreviewClassName(variant)}
      data-preview-variant={variant}
      style={style}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}
