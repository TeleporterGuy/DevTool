import { summarizeTool } from '../../shared/agent-activity'
import { editPairs, diffLines } from '../../shared/chat-diff'
import { canAlwaysAllow, planText, promptQuestions } from '../../shared/chat-prompts'
import type { ChatItem, ChatPrompt, ChatState } from '../../shared/claude-chat'
import { ChatLimits, capText } from '../../../protocol/ts/index.ts'
import type {
  ChatDetailResult,
  ChatEarlierResult,
  ChatView,
  ChatViewItem,
  ChatViewPrompt,
  ChatViewQuestion,
  ChatViewStatus
} from '../../../protocol/ts/index.ts'

/**
 * `ChatState` → the phone's chat view model (protocol/SPEC.md §6.2), and the diff
 * between two of them (§6.4). Pure: the bridge (chat-bridge.ts) owns subscriptions,
 * throttling and sending.
 */

export interface ChatViewTab {
  tabId: string
  title: string
}

export function mapItem(item: ChatItem): ChatViewItem {
  switch (item.kind) {
    case 'user': {
      const out: ChatViewItem = { kind: 'user', id: item.id, text: capText(item.text, ChatLimits.text).text }
      if (item.images > 0) out.images = item.images
      if (item.queued) out.queued = true
      if (item.failed) out.failed = true
      return out
    }
    case 'text': {
      const out: ChatViewItem = { kind: 'text', id: item.id, markdown: capText(item.text, ChatLimits.text).text }
      if (item.streaming) out.streaming = true
      return out
    }
    case 'thinking': {
      const out: ChatViewItem = { kind: 'thinking', id: item.id, preview: capText(item.text, ChatLimits.thinkingPreview).text }
      if (item.streaming) out.streaming = true
      return out
    }
    case 'tool': {
      const out: ChatViewItem = {
        kind: 'tool',
        id: item.id,
        name: item.name,
        summary: item.label,
        status: item.status,
        hasDetail: Object.keys(item.input).length > 0 || item.result !== undefined
      }
      if (item.childCount !== undefined) out.childCount = item.childCount
      if (item.lastChild !== undefined) out.lastChild = item.lastChild
      return out
    }
    case 'notice':
      return { kind: 'notice', id: item.id, text: item.text, tone: item.tone }
  }
}

/** Unified-diff-ish lines for an edit, as the desktop card draws them. */
function editDetail(toolName: string, input: Record<string, unknown>): string | null {
  const pairs = editPairs(toolName, input)
  if (!pairs) return null
  const lines: string[] = []
  if (typeof input.file_path === 'string') lines.push(input.file_path)
  for (const pair of pairs) {
    if (lines.length > 0) lines.push('')
    for (const line of diffLines(pair.before, pair.after)) {
      lines.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`)
    }
  }
  return lines.join('\n')
}

/** What the desktop's PermissionCard shows under its title, as one text block. */
function permissionDetail(prompt: ChatPrompt, summary: string): string | undefined {
  const input = prompt.input
  let main: string | null
  if ((prompt.toolName === 'Bash' || prompt.toolName === 'PowerShell') && typeof input.command === 'string') {
    main = input.command
  } else {
    main = editDetail(prompt.toolName, input)
    if (main === null && Object.keys(input).length > 0) main = JSON.stringify(input, null, 2)
  }
  const parts = [
    main,
    prompt.description && prompt.description !== summary ? prompt.description : null,
    prompt.reason ?? null,
    prompt.blockedPath ? `Outside the project: ${prompt.blockedPath}` : null
  ].filter((part): part is string => !!part)
  if (parts.length === 0) return undefined
  return capText(parts.join('\n\n'), ChatLimits.permissionDetail).text
}

export function mapPrompt(prompt: ChatPrompt): ChatViewPrompt {
  if (prompt.kind === 'question') {
    const questions: ChatViewQuestion[] = promptQuestions(prompt.input).map((q) => ({
      question: q.question,
      ...(q.header !== undefined ? { header: q.header } : {}),
      multiSelect: q.multiSelect,
      options: q.options.map((o) => (o.description !== undefined ? { label: o.label, description: o.description } : { label: o.label }))
    }))
    return { kind: 'question', id: prompt.id, questions }
  }
  if (prompt.kind === 'plan') return { kind: 'plan', id: prompt.id, markdown: planText(prompt.input) }
  const summary = summarizeTool(prompt.toolName, prompt.input)
  const out: ChatViewPrompt = {
    kind: 'permission',
    id: prompt.id,
    toolName: prompt.toolName,
    title: prompt.title ?? `Allow ${prompt.toolName}?`,
    summary,
    canAlwaysAllow: canAlwaysAllow(prompt)
  }
  const detail = permissionDetail(prompt, summary)
  if (detail !== undefined) out.detail = detail
  if (prompt.agentId) out.agent = true
  return out
}

export function viewStatus(state: ChatState): ChatViewStatus {
  const status: ChatViewStatus = { busy: state.busy, process: state.process }
  if (state.turnStartedAt !== undefined) status.turnStartedAt = state.turnStartedAt
  if (state.processError !== undefined) status.processError = state.processError
  if (state.info.permissionMode !== undefined) status.permissionMode = state.info.permissionMode
  if (state.info.model !== undefined) status.model = state.info.model
  return status
}

/** The whole view, windowed to the last `window` items (§6.4). */
export function toChatView(state: ChatState, tab: ChatViewTab, window: number = ChatLimits.window): ChatView {
  const start = Math.max(0, state.items.length - window)
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...viewStatus(state),
    items: state.items.slice(start).map(mapItem),
    hasEarlier: start > 0,
    prompts: state.pending.map(mapPrompt)
  }
}

/** Up to `limit` items right before `before`; null when `before` isn't in the chat. */
export function earlierItems(state: ChatState, before: string, limit: number = ChatLimits.earlier): ChatEarlierResult | null {
  const index = state.items.findIndex((item) => item.id === before)
  if (index < 0) return null
  const start = Math.max(0, index - limit)
  return { items: state.items.slice(start, index).map(mapItem), hasEarlier: start > 0 }
}

/** `chat.detail`: null when the item doesn't exist. */
export function chatDetail(state: ChatState, itemId: string): ChatDetailResult | null {
  const item = state.items.find((i) => i.id === itemId)
  if (!item) return null
  if (item.kind === 'tool') {
    const input = capText(JSON.stringify(item.input, null, 2), ChatLimits.detail).text
    return item.result !== undefined
      ? { kind: 'tool', input, result: capText(item.result, ChatLimits.detail).text }
      : { kind: 'tool', input }
  }
  return { kind: 'text', markdown: capText(item.text, ChatLimits.detail).text }
}

/** Equal keys mean the phone already has this exact item. */
export function itemKey(item: ChatViewItem): string {
  return JSON.stringify(item)
}

/** Equal keys mean the phone already has these prompts and status. */
export function headKey(prompts: ChatViewPrompt[], status: ChatViewStatus): string {
  return JSON.stringify([prompts, status])
}

/** What one subscription has sent: the ids in order (oldest first) and their content keys. */
export interface SentItems {
  order: string[]
  keys: Map<string, string>
}

export function emptySent(): SentItems {
  return { order: [], keys: new Map() }
}

export interface ItemDiff {
  upserts: ChatViewItem[]
  removes: string[]
  /** The ids and keys the phone has after applying this diff. */
  next: SentItems
}

/**
 * The upserts and removes that turn what the phone has (`sent`) into the current
 * items. Only items from the phone's oldest one onward are considered (§6.4: the
 * window only grows through `chat.earlier`), plus everything newer.
 *
 * When the items were extended in place — the usual case, new ones only appended —
 * only changed and new items are upserted. When the list was replaced instead
 * (`/clear`, a reset), every sent id is removed and the latest window upserted,
 * so the phone never ends up with items out of order.
 */
export function diffItems(sent: SentItems, items: ChatItem[], window: number = ChatLimits.window): ItemDiff {
  const oldest = sent.order[0]
  const from = oldest === undefined ? -1 : items.findIndex((item) => item.id === oldest)
  if (from < 0) {
    // Nothing sent yet, or the phone's oldest item is gone: start a fresh window.
    const fresh = items.slice(Math.max(0, items.length - window)).map(mapItem)
    const next = emptySent()
    for (const item of fresh) {
      next.order.push(item.id)
      next.keys.set(item.id, itemKey(item))
    }
    return { upserts: fresh, removes: [...sent.order], next }
  }
  const current = items.slice(from)
  // In place when the sent ids are still a prefix-in-order of the current list.
  let inPlace = current.length >= sent.order.length
  for (let i = 0; inPlace && i < sent.order.length; i++) {
    if (current[i].id !== sent.order[i]) inPlace = false
  }
  if (!inPlace) {
    const fresh = items.slice(Math.max(0, items.length - window)).map(mapItem)
    const next = emptySent()
    for (const item of fresh) {
      next.order.push(item.id)
      next.keys.set(item.id, itemKey(item))
    }
    return { upserts: fresh, removes: [...sent.order], next }
  }
  const upserts: ChatViewItem[] = []
  const next: SentItems = { order: [...sent.order], keys: new Map(sent.keys) }
  current.forEach((raw, index) => {
    const item = mapItem(raw)
    const key = itemKey(item)
    if (index >= sent.order.length) {
      next.order.push(item.id)
      next.keys.set(item.id, key)
      upserts.push(item)
    } else if (sent.keys.get(item.id) !== key) {
      next.keys.set(item.id, key)
      upserts.push(item)
    }
  })
  return { upserts, removes: [], next }
}

/** Record items the phone just received through `chat.open` or `chat.earlier`. */
export function recordSent(sent: SentItems, items: ChatViewItem[], position: 'replace' | 'prepend'): SentItems {
  const next: SentItems = position === 'replace' ? emptySent() : { order: [...sent.order], keys: new Map(sent.keys) }
  const ids = items.map((item) => item.id)
  next.order = position === 'replace' ? ids : [...ids.filter((id) => !next.keys.has(id)), ...next.order]
  for (const item of items) next.keys.set(item.id, itemKey(item))
  return next
}
