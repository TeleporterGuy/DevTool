import { Marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

/**
 * Markdown for chat messages. Its own `Marked` instance so the chat's options can
 * never drift the note preview's (and vice versa); the look comes from the
 * `.note-preview.chat-md` rules in styles.css.
 */
const chatMarked = new Marked({ gfm: true, breaks: false })

chatMarked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text)
      return `<div class="chat-code"><pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
        + `<button type="button" class="chat-code-copy" ${COPY_ATTR} title="Copy code">Copy</button></div>`
    }
  }
})

const COPY_ATTR = 'data-chat-copy'
const COPIED_MS = 1200

/**
 * A click on a code block's Copy button (the chat renders it as HTML, so one
 * delegated handler serves every message, plan and side answer). True when it
 * was one.
 */
export function handleCodeCopyClick(target: EventTarget | null): boolean {
  const button = target instanceof Element ? target.closest(`[${COPY_ATTR}]`) : null
  if (!(button instanceof HTMLElement)) return false
  const code = button.parentElement?.querySelector('pre')?.textContent ?? ''
  void window.api.clipboardWriteText(code).then(() => {
    button.textContent = 'Copied'
    window.setTimeout(() => { button.textContent = 'Copy' }, COPIED_MS)
  }).catch(() => {})
  return true
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderChatMarkdown(text: string): string {
  const raw = chatMarked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw)
}
