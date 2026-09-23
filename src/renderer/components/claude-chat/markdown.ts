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
      return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
    }
  }
})

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderChatMarkdown(text: string): string {
  const raw = chatMarked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw)
}
