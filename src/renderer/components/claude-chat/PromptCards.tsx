import React, { useMemo, useState } from 'react'
import type { ChatPrompt, ChatPromptResponse } from '../../../shared/claude-chat'
import { summarizeTool } from '../../../shared/agent-activity'
import { renderChatMarkdown } from './markdown'
import DiffView from './DiffView'
import { diffLines, editPairs } from './diff'

interface Props {
  prompt: ChatPrompt
  onRespond: (response: ChatPromptResponse) => void
}

const btn = 'inline-flex items-center h-(--ctl-h-sm) px-2.5 rounded-md border-[0.5px] text-sm cursor-pointer transition-colors duration-(--motion-fast) disabled:opacity-50 disabled:cursor-not-allowed'
export const primaryBtn = `${btn} border-transparent bg-accent text-accent-ink hover:brightness-105`
export const secondaryBtn = `${btn} border-border bg-surface-2 text-text hover:bg-surface-3`
export const quietBtn = `${btn} border-transparent bg-transparent text-text-muted hover:text-text hover:bg-surface-2`

function Card({ title, children }: { title: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-status-attention)_45%,var(--color-border))] bg-surface shadow-pop overflow-hidden">
      <div className="px-3 pt-2 pb-1 text-sm font-medium text-text flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-status-attention shrink-0" />
        {title}
      </div>
      <div className="px-3 pb-2.5 flex flex-col gap-2">{children}</div>
    </div>
  )
}

export default function PromptCard({ prompt, onRespond }: Props): React.ReactElement {
  if (prompt.kind === 'question') return <QuestionCard prompt={prompt} onRespond={onRespond} />
  if (prompt.kind === 'plan') return <PlanCard prompt={prompt} onRespond={onRespond} />
  return <PermissionCard prompt={prompt} onRespond={onRespond} />
}

function PermissionCard({ prompt, onRespond }: Props): React.ReactElement {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const input = prompt.input
  const pairs = editPairs(prompt.toolName, input)
  const canAlways = (prompt.suggestions?.length ?? 0) > 0
  const label = summarizeTool(prompt.toolName, input)
  let detail: React.ReactNode = null
  if ((prompt.toolName === 'Bash' || prompt.toolName === 'PowerShell') && typeof input.command === 'string') {
    detail = <pre className="chat-pre text-text">{input.command}</pre>
  } else if (pairs) {
    detail = (
      <>
        {typeof input.file_path === 'string' && <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>}
        {pairs.map((pair, index) => <DiffView key={index} lines={diffLines(pair.before, pair.after)} />)}
      </>
    )
  } else if (Object.keys(input).length > 0) {
    detail = <pre className="chat-pre text-text-muted">{JSON.stringify(input, null, 2)}</pre>
  }
  return (
    <Card title={<span className="truncate">{prompt.title ?? `Allow ${prompt.toolName}?`}</span>}>
      {!pairs && <div className="text-sm text-text">{label}</div>}
      {prompt.description && !pairs && prompt.description !== label && <div className="text-sm text-text-muted">{prompt.description}</div>}
      {prompt.reason && <div className="text-xs text-text-subtle">{prompt.reason}</div>}
      {prompt.blockedPath && <div className="text-xs text-text-subtle">Outside the project: <span className="font-mono">{prompt.blockedPath}</span></div>}
      {detail && <div className="max-h-56 overflow-auto">{detail}</div>}
      {denying ? (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            onRespond({ behavior: 'deny', message: reason })
          }}
        >
          <input
            autoFocus
            className="flex-1 min-w-0 h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
            placeholder="Tell Claude what to do instead (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDenying(false) } }}
          />
          <button type="submit" className={secondaryBtn}>Deny</button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={primaryBtn} onClick={() => onRespond({ behavior: 'allow' })}>Allow</button>
          {canAlways && (
            <button type="button" className={secondaryBtn} onClick={() => onRespond({ behavior: 'allow', always: true })} title={describeSuggestions(prompt.suggestions)}>
              Always allow
            </button>
          )}
          <button type="button" className={quietBtn} onClick={() => setDenying(true)}>Deny…</button>
        </div>
      )}
    </Card>
  )
}

/** What "Always allow" would change, from Claude's own suggestions. */
function describeSuggestions(suggestions: unknown[] | undefined): string {
  const parts: string[] = []
  for (const raw of suggestions ?? []) {
    const s = raw as { type?: string; mode?: string; rules?: { toolName?: string; ruleContent?: string }[]; destination?: string }
    if (s.type === 'setMode' && s.mode) parts.push(`Switch to ${s.mode} for this session`)
    if (s.type === 'addRules' && s.rules) {
      for (const rule of s.rules) parts.push(`Allow ${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}${s.destination ? ` in ${s.destination}` : ''}`)
    }
  }
  return parts.join('\n')
}

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

function QuestionCard({ prompt, onRespond }: Props): React.ReactElement {
  const questions = useMemo<Question[]>(() => {
    const raw = Array.isArray(prompt.input.questions) ? prompt.input.questions : []
    return raw.map((q) => {
      const question = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>
      const options = Array.isArray(question.options) ? question.options : []
      return {
        question: String(question.question ?? ''),
        header: typeof question.header === 'string' ? question.header : undefined,
        multiSelect: question.multiSelect === true,
        options: options.map((o) => {
          const option = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
          return { label: String(option.label ?? ''), description: typeof option.description === 'string' ? option.description : undefined }
        })
      }
    })
  }, [prompt.input])
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const answerFor = (index: number): string => {
    const labels = [...(picked[index] ?? [])]
    const extra = other[index]?.trim()
    if (extra) labels.push(extra)
    return labels.join(', ')
  }
  const complete = questions.every((_, index) => answerFor(index).length > 0)

  const toggle = (index: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const current = prev[index] ?? []
      if (!multi) return { ...prev, [index]: current[0] === label ? [] : [label] }
      return { ...prev, [index]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] }
    })
    if (!multi) setOther((prev) => ({ ...prev, [index]: '' }))
  }

  const submit = (): void => {
    const answers: Record<string, string> = {}
    questions.forEach((q, index) => { answers[q.question] = answerFor(index) })
    onRespond({ behavior: 'allow', updatedInput: { ...prompt.input, answers } })
  }

  return (
    <Card title="Claude has a question">
      {questions.map((q, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <div className="text-base text-text">
            {q.header && <span className="text-xs uppercase tracking-wide text-text-subtle mr-2">{q.header}</span>}
            {q.question}
          </div>
          <div className="flex flex-col gap-1">
            {q.options.map((option) => {
              const selected = (picked[index] ?? []).includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(index, option.label, q.multiSelect === true)}
                  className={`text-left rounded-md border-[0.5px] px-2.5 py-1.5 cursor-pointer transition-colors duration-(--motion-fast) ${selected ? 'border-border-focus bg-sel' : 'border-border bg-surface-2 hover:bg-surface-3'}`}
                >
                  <div className="text-sm text-text">{q.multiSelect ? (selected ? '☑ ' : '☐ ') : ''}{option.label}</div>
                  {option.description && <div className="text-xs text-text-muted">{option.description}</div>}
                </button>
              )
            })}
            <input
              className="h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
              placeholder="Other…"
              value={other[index] ?? ''}
              onChange={(e) => {
                const value = e.target.value
                setOther((prev) => ({ ...prev, [index]: value }))
                if (!q.multiSelect && value) setPicked((prev) => ({ ...prev, [index]: [] }))
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && complete) submit() }}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-1.5">
        <button type="button" className={primaryBtn} disabled={!complete} onClick={submit}>Answer</button>
        <button type="button" className={quietBtn} onClick={() => onRespond({ behavior: 'deny', message: 'The user dismissed the question.' })}>Skip</button>
      </div>
    </Card>
  )
}

function PlanCard({ prompt, onRespond }: Props): React.ReactElement {
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const plan = typeof prompt.input.plan === 'string' ? prompt.input.plan : ''
  const html = useMemo(() => renderChatMarkdown(plan || '_No plan text._'), [plan])
  return (
    <Card title="Plan ready for review">
      <div
        className="note-preview chat-md max-h-[45vh] overflow-auto rounded-md bg-surface-2 border-[0.5px] border-border px-3 py-2 text-base"
        // Sanitized by DOMPurify in renderChatMarkdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {revising ? (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            onRespond({ behavior: 'deny', message: feedback.trim() || 'Keep planning.' })
          }}
        >
          <input
            autoFocus
            className="flex-1 min-w-0 h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
            placeholder="What should change?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRevising(false) } }}
          />
          <button type="submit" className={secondaryBtn}>Send feedback</button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={primaryBtn}
            onClick={() => onRespond({ behavior: 'allow', always: false, updatedInput: prompt.input })}
          >
            Approve
          </button>
          <button
            type="button"
            className={secondaryBtn}
            title="Approve, and accept file edits without asking for the rest of this session"
            onClick={() => onRespond({ behavior: 'allow', always: true, updatedInput: prompt.input })}
          >
            Approve, auto-accept edits
          </button>
          <button type="button" className={quietBtn} onClick={() => setRevising(true)}>Keep planning…</button>
        </div>
      )}
    </Card>
  )
}
