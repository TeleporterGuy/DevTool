import React, { memo, useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, CircleSlash, X } from 'lucide-react'
import type { ChatImage, ChatItem, ChatToolItem } from '../../../shared/claude-chat'
import { buildTimeline, summarizeGroup, type TimelineRow } from './timelineRows'
import { renderChatMarkdown } from './markdown'
import { diffLines, diffStats, editPairs } from './diff'
import DiffView from './DiffView'

interface Props {
  items: ChatItem[]
  busy: boolean
  compacting: boolean
  /** A prompt is open: the turn is waiting on you, not working. */
  waiting: boolean
  turnStartedAt?: number
  /** Links in messages open as DevTool browser tabs. */
  onOpenLink: (url: string) => void
}

export default function Timeline({ items, busy, compacting, waiting, turnStartedAt, onOpenLink }: Props): React.ReactElement {
  const rows = useMemo(() => buildTimeline(items, busy), [items, busy])
  const activeTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')) return item
      if (item.kind === 'user') break
    }
    return null
  }, [items])

  return (
    <div
      className="flex flex-col gap-1.5"
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a')
        const href = anchor?.getAttribute('href')
        if (!anchor || !href) return
        e.preventDefault()
        if (/^https?:\/\//i.test(href)) onOpenLink(href)
      }}
    >
      {rows.map((row) => <Row key={row.key} row={row} />)}
      {busy && <WorkingLine compacting={compacting} waiting={waiting} since={turnStartedAt} tool={activeTool} />}
    </div>
  )
}

const Row = memo(function Row({ row }: { row: TimelineRow }): React.ReactElement | null {
  if (row.type === 'group') return <ToolGroup tools={row.tools} />
  const { item } = row
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'text':
      return <AssistantText text={item.text} streaming={item.streaming} />
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />
    case 'tool':
      return <ToolRow tool={item} />
    case 'notice':
      return <Notice text={item.text} tone={item.tone} />
  }
})

function UserMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }): React.ReactElement {
  return (
    <div className={`mt-3 first:mt-0 flex gap-2 ${item.queued ? 'opacity-60' : ''}`}>
      <div className="flex-1 min-w-0 rounded-lg bg-surface-2 border-[0.5px] border-border px-3 py-2 text-base text-text whitespace-pre-wrap break-words">
        {item.text || (item.images > 0 ? '' : ' ')}
        {item.images > 0 && (
          <span className="inline-block mt-0.5 mr-1 text-xs text-text-muted">
            {item.images === 1 ? '1 image' : `${item.images} images`}
          </span>
        )}
        {(item.queued || item.failed) && (
          <div className={`mt-1 text-xs ${item.failed ? 'text-danger' : 'text-text-muted'}`}>
            {item.failed ? 'Not delivered — Claude stopped before reading it' : 'Queued — Claude reads it at its next step'}
          </div>
        )}
      </div>
    </div>
  )
}

const AssistantText = memo(function AssistantText({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  return (
    <div className={`note-preview chat-md text-base text-text break-words${streaming ? ' chat-streaming' : ''}`}
      // Sanitized by DOMPurify in renderChatMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

function Thinking({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-sm text-text-subtle">
      <button type="button" className="chat-row-btn" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={`shrink-0 transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
        <span className="italic">{streaming ? 'Thinking…' : 'Thought'}</span>
      </button>
      {open && <div className="ml-5 mt-1 whitespace-pre-wrap text-text-muted">{text}</div>}
    </div>
  )
}

function Notice({ text, tone }: { text: string; tone: 'muted' | 'warning' | 'error' }): React.ReactElement {
  const color = tone === 'error'
    ? 'text-danger border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)]'
    : tone === 'warning'
      ? 'text-warn border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)]'
      : 'text-text-muted border-transparent'
  return (
    <div className={`text-sm whitespace-pre-wrap break-words rounded-md border px-2 py-1 ${color}`}>{text}</div>
  )
}

function StatusIcon({ status }: { status: ChatToolItem['status'] }): React.ReactElement {
  switch (status) {
    case 'pending':
    case 'running':
      return <span className="w-3 h-3 flex items-center justify-center shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" /></span>
    case 'waiting':
      return <span className="w-3 h-3 flex items-center justify-center shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-status-attention" /></span>
    case 'done':
      return <Check size={12} className="shrink-0 text-success opacity-80" />
    case 'error':
      return <X size={12} className="shrink-0 text-danger" />
    case 'denied':
      return <CircleSlash size={12} className="shrink-0 text-text-subtle" />
  }
}

function toolMeta(tool: ChatToolItem): string | undefined {
  const pairs = editPairs(tool.name, tool.input)
  if (pairs) {
    const stats = pairs.map((pair) => diffStats(diffLines(pair.before, pair.after)))
    const added = stats.reduce((sum, s) => sum + s.added, 0)
    const removed = stats.reduce((sum, s) => sum + s.removed, 0)
    return tool.name === 'Write' ? `${added} lines` : `+${added} −${removed}`
  }
  if ((tool.name === 'Agent' || tool.name === 'Task') && tool.childCount) {
    return tool.status === 'running' && tool.lastChild
      ? `${tool.lastChild} · ${tool.childCount} calls`
      : `${tool.childCount} calls`
  }
  if (tool.status === 'denied') return 'denied'
  return undefined
}

/** `inGroup`: the group row already shows the images. */
const ToolRow = memo(function ToolRow({ tool, inGroup }: { tool: ChatToolItem; inGroup?: boolean }): React.ReactElement {
  const isTodo = tool.name === 'TodoWrite'
  const [open, setOpen] = useState(false)
  const meta = useMemo(() => toolMeta(tool), [tool])
  if (isTodo) return <TodoList tool={tool} />
  return (
    <div className="text-sm">
      <button type="button" className="chat-row-btn w-full" onClick={() => setOpen(!open)}>
        <StatusIcon status={tool.status} />
        <span className={`truncate ${tool.status === 'denied' ? 'text-text-subtle line-through decoration-text-subtle/50' : 'text-text'}`}>{tool.label}</span>
        {meta && <span className="ml-auto pl-3 shrink-0 text-xs text-text-subtle tabular-nums">{meta}</span>}
      </button>
      {open && <ToolDetail tool={tool} />}
      {!inGroup && tool.images && tool.images.length > 0 && <ToolImages images={tool.images} />}
    </div>
  )
})

/** Result images in one row of thumbnails; click one to see it full width below. */
function ToolImages({ images }: { images: ChatImage[] }): React.ReactElement {
  const [expanded, setExpanded] = useState<number | null>(null)
  const urls = useMemo(() => images.map((image) => `data:${image.mediaType};base64,${image.data}`), [images])
  const shown = expanded !== null ? urls[expanded] : undefined
  return (
    <div className="ml-5 mt-1 mb-1.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {urls.map((url, index) => (
          <button
            key={index}
            type="button"
            className={`block rounded-md cursor-zoom-in ${index === expanded ? 'ring-1 ring-accent' : ''}`}
            title={index === expanded ? 'Hide' : 'Show full size'}
            onClick={() => setExpanded(index === expanded ? null : index)}
          >
            <img src={url} alt="" className="h-24 w-auto max-w-60 rounded-md border-[0.5px] border-border object-contain" />
          </button>
        ))}
      </div>
      {shown && (
        <button type="button" className="block max-w-full cursor-zoom-out" title="Hide" onClick={() => setExpanded(null)}>
          <img src={shown} alt="" className="max-w-full rounded-md border-[0.5px] border-border" />
        </button>
      )}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ChatToolItem[] }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const running = tools.some((tool) => tool.status === 'running' || tool.status === 'pending')
  const failed = tools.some((tool) => tool.status === 'error')
  const images = useMemo(() => tools.flatMap((tool) => tool.images ?? []), [tools])
  return (
    <div className="text-sm">
      <button type="button" className="chat-row-btn w-full" onClick={() => setOpen(!open)}>
        <StatusIcon status={running ? 'running' : failed ? 'error' : 'done'} />
        <span className="text-text truncate">{summarizeGroup(tools)}</span>
        <ChevronRight size={12} className={`ml-auto shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="ml-5 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
          {tools.map((tool) => <ToolRow key={tool.id} tool={tool} inGroup />)}
        </div>
      )}
      {images.length > 0 && <ToolImages images={images} />}
    </div>
  )
}

function TodoList({ tool }: { tool: ChatToolItem }): React.ReactElement {
  const todos = Array.isArray(tool.input.todos) ? tool.input.todos as Record<string, unknown>[] : []
  return (
    <div className="text-sm rounded-md border-[0.5px] border-border bg-surface px-2.5 py-1.5 my-0.5">
      {todos.map((todo, index) => {
        const status = todo.status
        const text = String((status === 'in_progress' ? todo.activeForm : null) ?? todo.content ?? '')
        return (
          <div key={index} className="flex items-baseline gap-2 py-px">
            <span className={`w-3 shrink-0 text-center ${status === 'completed' ? 'text-success' : status === 'in_progress' ? 'text-accent' : 'text-text-subtle'}`}>
              {status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○'}
            </span>
            <span className={status === 'completed' ? 'text-text-subtle line-through' : status === 'in_progress' ? 'text-text' : 'text-text-muted'}>{text}</span>
          </div>
        )
      })}
    </div>
  )
}

function Pre({ children, tone }: { children: React.ReactNode; tone?: 'error' }): React.ReactElement {
  return (
    <pre className={`chat-pre ${tone === 'error' ? 'text-danger' : 'text-text-muted'}`}>{children}</pre>
  )
}

function ToolDetail({ tool }: { tool: ChatToolItem }): React.ReactElement {
  const input = tool.input
  const pairs = editPairs(tool.name, input)
  const showResult = tool.result && !(pairs && tool.status === 'done')
  let body: React.ReactNode
  if (pairs) {
    body = (
      <>
        {typeof input.file_path === 'string' && <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>}
        {pairs.map((pair, index) => <DiffView key={index} lines={diffLines(pair.before, pair.after)} />)}
      </>
    )
  } else if ((tool.name === 'Bash' || tool.name === 'PowerShell') && typeof input.command === 'string') {
    body = <Pre>{`$ ${input.command}`}</Pre>
  } else if (typeof input.file_path === 'string' && Object.keys(input).length <= 3) {
    body = <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>
  } else if ((tool.name === 'Agent' || tool.name === 'Task') && typeof input.prompt === 'string') {
    body = <Pre>{input.prompt}</Pre>
  } else if (Object.keys(input).length > 0) {
    body = <Pre>{JSON.stringify(input, null, 2)}</Pre>
  }
  return (
    <div className="ml-5 mt-1 mb-1.5 flex flex-col gap-1">
      {body}
      {showResult && <Pre tone={tool.status === 'error' ? 'error' : undefined}>{tool.result}</Pre>}
    </div>
  )
}

function WorkingLine({ compacting, waiting, since, tool }: { compacting: boolean; waiting: boolean; since?: number; tool: ChatToolItem | null }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : null
  const elapsed = seconds === null ? '' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const label = waiting ? 'Waiting for you' : compacting ? 'Compacting context' : tool ? tool.label : 'Working'
  return (
    <div className="flex items-center gap-2 text-sm text-text-muted py-0.5">
      <span className="w-3 h-3 flex items-center justify-center shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${waiting ? 'bg-status-attention' : 'bg-accent status-pulse'}`} />
      </span>
      <span className="truncate">{label}</span>
      {elapsed && <span className="text-xs text-text-subtle tabular-nums">{elapsed}</span>}
      {!waiting && <span className="text-xs text-text-subtle">· esc to stop</span>}
    </div>
  )
}
