import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { renderChatMarkdown } from './markdown'

export interface SideQuestionState {
  id: number
  question: string
  status: 'asking' | 'done' | 'error'
  answer?: string
  error?: string
}

interface Props {
  side: SideQuestionState
  onDismiss: () => void
  onOpenLink: (url: string) => void
}

/**
 * A `/btw` answer, above the composer. It lives only in this window: like the
 * CLI's, it never joins the conversation or its transcript.
 */
export default function SideQuestion({ side, onDismiss, onOpenLink }: Props): React.ReactElement {
  const html = useMemo(() => (side.answer ? renderChatMarkdown(side.answer) : ''), [side.answer])
  return (
    <div
      className="rounded-lg border-[0.5px] border-border bg-surface-2 px-3 py-2 max-h-[40vh] overflow-y-auto"
      role="region"
      aria-label="Side question"
      onClick={(e) => {
        // Links open in a browser tab, as in the timeline; never in this window.
        const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
        if (!href) return
        e.preventDefault()
        if (/^https?:\/\//i.test(href)) onOpenLink(href)
      }}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 text-sm text-text-muted break-words">
          <span className="text-accent font-medium mr-1.5">/btw</span>
          {side.question}
        </div>
        <button
          type="button"
          title="Dismiss"
          onClick={onDismiss}
          className="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-text-subtle cursor-pointer hover:bg-surface-3 hover:text-text"
        >
          <X size={12} />
        </button>
      </div>
      <div className="mt-1.5">
        {side.status === 'asking' && <div className="text-sm text-text-subtle italic">Thinking…</div>}
        {side.status === 'error' && <div className="text-sm text-danger whitespace-pre-wrap break-words">{side.error}</div>}
        {side.status === 'done' && (
          <div className="note-preview chat-md text-base text-text break-words"
            // Sanitized by DOMPurify in renderChatMarkdown.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      <div className="mt-1.5 text-xs text-text-subtle">Not added to the conversation</div>
    </div>
  )
}
