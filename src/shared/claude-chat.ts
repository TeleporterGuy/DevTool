import { summarizeTool } from './agent-activity'

/**
 * The Claude chat tab's model: what main streams to the windows and how both
 * sides fold it into a timeline.
 *
 * Main owns one `claude` process per chat tab (driven through the Agent SDK) and
 * keeps the folded {@link ChatState}. A window attaching gets that state as a
 * snapshot, then applies every later {@link ChatEvent} through the same
 * {@link reduceChat}, so all windows — and a window that attaches late — draw the
 * same thing. History restored from Claude's transcript goes through the same
 * reducer too, which is what keeps a resumed chat identical to a live one.
 *
 * SDK messages are treated as untyped JSON here on purpose: this file runs in the
 * renderer, the wire format belongs to whichever `claude` binary is installed, and
 * a field that is missing or renamed must degrade a row, not crash the tab.
 */

export type ChatToolStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'denied'

export interface ChatToolItem {
  kind: 'tool'
  id: string
  name: string
  label: string
  input: Record<string, unknown>
  status: ChatToolStatus
  result?: string
  /** Images the result carried (a Read of a screenshot, an MCP browser screenshot). */
  images?: ChatImage[]
  /** Subagent (Agent/Task tool) progress: how many tool calls it made, and the latest. */
  childCount?: number
  lastChild?: string
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: number; queued?: boolean; failed?: boolean }
  | { kind: 'text'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean }
  | ChatToolItem
  | { kind: 'notice'; id: string; text: string; tone: 'muted' | 'warning' | 'error' }

export type ChatPromptKind = 'permission' | 'question' | 'plan'

/** A `canUseTool` call main is holding open until someone in a window answers it. */
export interface ChatPrompt {
  id: string
  kind: ChatPromptKind
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** Claude's own "don't ask again" rules for this call (PermissionUpdate[]). */
  suggestions?: unknown[]
  blockedPath?: string
  /** Claude's own wording for the prompt, when it gives one. */
  title?: string
  description?: string
  reason?: string
  /** Set when a subagent, not the main thread, is asking. */
  agentId?: string
}

export type ChatProcessState = 'idle' | 'starting' | 'running' | 'exited'

export interface ChatModelOption {
  value: string
  /** The wire id an alias resolves to ('haiku' → 'claude-haiku-4-5'), to match `system:init`'s model. */
  resolvedModel?: string
  displayName: string
  description?: string
  supportedEffortLevels?: string[]
}

export interface ChatCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface ChatSessionInfo {
  sessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  cwd?: string
  claudeVersion?: string
}

/** One plan rate-limit window: percent used (0–100) and when it resets. */
export interface ChatLimitWindow {
  utilization: number
  resetsAt?: string
}

/** What the composer's meter shows; each part appears once main has read it. */
export interface ChatUsage {
  /** Tokens in context now, and the model's window (as `/context` counts them). */
  contextTokens?: number
  contextMax?: number
  /** Session cost at API list prices — an estimate, whatever the account pays. */
  costUsd?: number
  /** claude.ai plan windows; absent for API-key and cloud-provider sessions. */
  fiveHour?: ChatLimitWindow
  sevenDay?: ChatLimitWindow
}

export interface ChatState {
  items: ChatItem[]
  pending: ChatPrompt[]
  /** A turn is in flight (sent, or Claude is streaming, until `result`). */
  busy: boolean
  turnStartedAt?: number
  compacting: boolean
  process: ChatProcessState
  /** Why the process last ended, when it was not asked to. */
  processError?: string
  info: ChatSessionInfo
  models: ChatModelOption[]
  commands: ChatCommand[]
  usage: ChatUsage
  /** item index by tool_use id, for pairing results and subagent progress. */
  toolIndex: Record<string, number>
  /** Streaming blocks still open, keyed `${messageId}:${blockIndex}`. */
  openBlocks: Record<string, number>
  /** The message stream events belong to — `message_start` names it, deltas don't. */
  streamMessage?: string
  /** Stop was pressed: the turn's error result is the interrupt, not a failure. */
  interrupting?: boolean
}

export type ChatEvent =
  | { t: 'sdk'; m: unknown; at?: number }
  | { t: 'history'; messages: unknown[] }
  | { t: 'sent'; uuid: string; text: string; images: number; at?: number }
  | { t: 'prompt'; prompt: ChatPrompt }
  | { t: 'prompt-done'; id: string; allowed: boolean }
  | { t: 'process'; state: ChatProcessState; error?: string }
  | { t: 'notice'; text: string; tone: 'muted' | 'warning' | 'error' }
  | { t: 'meta'; models?: ChatModelOption[]; commands?: ChatCommand[]; info?: Partial<ChatSessionInfo>; usage?: ChatUsage }
  | { t: 'interrupting' }
  | { t: 'reset' }

/** What `chat-attach` returns: the state so far and the seq it corresponds to. */
export interface ChatSnapshot {
  seq: number
  state: ChatState
}

/** How a window answers a {@link ChatPrompt}. */
export type ChatPromptResponse =
  | { behavior: 'allow'; always?: boolean; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

export interface ChatImage {
  mediaType: string
  /** base64, no data: prefix */
  data: string
}

export const RESULT_TEXT_LIMIT = 20_000
/** Images kept per tool result, and the largest one kept (base64 chars, ~7.5 MB decoded). */
export const RESULT_IMAGE_LIMIT = 4
export const RESULT_IMAGE_CHARS = 10_000_000
const SHOWN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const INPUT_STRING_LIMIT = 50_000

export function emptyChatState(): ChatState {
  return {
    items: [],
    pending: [],
    busy: false,
    compacting: false,
    process: 'idle',
    info: {},
    models: [],
    commands: [],
    usage: {},
    toolIndex: {},
    openBlocks: {}
  }
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text
}

function clampInput(input: unknown): Record<string, unknown> {
  const source = obj(input) ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = typeof value === 'string' ? truncate(value, INPUT_STRING_LIMIT) : value
  }
  return out
}

/** A base64 image block we can draw, or undefined (URL sources, unknown or oversized data). */
function imageBlock(block: Json): ChatImage | undefined {
  const source = obj(block.source)
  const data = str(source?.data)
  if (!source || source.type !== 'base64' || !data || data.length > RESULT_IMAGE_CHARS) return undefined
  const mediaType = str(source.media_type) ?? 'image/png'
  return SHOWN_IMAGE_TYPES.has(mediaType) ? { mediaType, data } : undefined
}

/**
 * A tool_result's content as display text plus the images it carried. Images
 * past the limit, or ones we can't draw, are counted in the text instead.
 */
export function toolResultContent(content: unknown): { text: string; images: ChatImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const parts: string[] = []
  const images: ChatImage[] = []
  let dropped = 0
  for (const block of content) {
    const b = obj(block)
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') {
      const image = images.length < RESULT_IMAGE_LIMIT ? imageBlock(b) : undefined
      if (image) images.push(image)
      else dropped++
    }
  }
  if (dropped > 0) parts.push(dropped === 1 ? '[image not shown]' : `[${dropped} images not shown]`)
  return { text: parts.join('\n'), images }
}

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/
const META_TAG_RE = /^<(local-command-caveat|system-reminder|command-message|task-notification|bash-input|bash-stdout|bash-stderr)>/

/**
 * How a user text block should show, or null to hide it. Claude records slash
 * commands and their output as tagged pseudo-messages in the transcript.
 */
function classifyUserText(text: string): { kind: 'user' | 'notice'; text: string } | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (INTERRUPT_RE.test(trimmed)) return { kind: 'notice', text: 'Interrupted' }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim()
    const name = command[1].trim()
    return { kind: 'user', text: args ? `${name} ${args}` : name }
  }
  const stdout = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/.exec(trimmed)
  if (stdout) {
    const body = stdout[1].trim()
    return body ? { kind: 'notice', text: body } : null
  }
  if (META_TAG_RE.test(trimmed)) return null
  return { kind: 'user', text }
}

class Draft {
  items: ChatItem[]
  toolIndex: Record<string, number>
  openBlocks: Record<string, number>
  private copiedItems = false
  private copiedIndex = false
  private copiedBlocks = false

  constructor(private readonly state: ChatState, private readonly idPrefix: string) {
    this.items = state.items
    this.toolIndex = state.toolIndex
    this.openBlocks = state.openBlocks
  }

  private itemsMut(): ChatItem[] {
    if (!this.copiedItems) {
      this.items = this.items.slice()
      this.copiedItems = true
    }
    return this.items
  }

  private indexMut(): Record<string, number> {
    if (!this.copiedIndex) {
      this.toolIndex = { ...this.toolIndex }
      this.copiedIndex = true
    }
    return this.toolIndex
  }

  blocksMut(): Record<string, number> {
    if (!this.copiedBlocks) {
      this.openBlocks = { ...this.openBlocks }
      this.copiedBlocks = true
    }
    return this.openBlocks
  }

  nextId(hint?: string): string {
    return hint ?? `${this.idPrefix}${this.items.length}`
  }

  push(item: ChatItem): number {
    const items = this.itemsMut()
    items.push(item)
    const index = items.length - 1
    if (item.kind === 'tool') this.indexMut()[item.id] = index
    return index
  }

  update(index: number, patch: (item: ChatItem) => ChatItem): void {
    const current = this.items[index]
    if (!current) return
    const next = patch(current)
    if (next === current) return
    this.itemsMut()[index] = next
  }

  tool(id: string | undefined): number | undefined {
    return id === undefined ? undefined : this.toolIndex[id]
  }

  result(patch: Partial<ChatState>): ChatState {
    return {
      ...this.state,
      ...patch,
      items: this.items,
      toolIndex: this.toolIndex,
      openBlocks: this.openBlocks
    }
  }
}

function toolItem(block: Json, status: ChatToolStatus): ChatToolItem {
  const name = str(block.name) ?? 'tool'
  const input = clampInput(block.input)
  return {
    kind: 'tool',
    id: str(block.id) ?? '',
    name,
    label: summarizeTool(name, input),
    input,
    status
  }
}

function applyAssistantBlocks(draft: Draft, message: Json, parentToolUseId: string | null): void {
  const content = Array.isArray(message.content) ? message.content : []
  const messageId = str(message.id) ?? ''

  if (parentToolUseId) {
    // A subagent's own turn: only its tool calls surface, as progress on its Agent row.
    const parent = draft.tool(parentToolUseId)
    if (parent === undefined) return
    for (const raw of content) {
      const block = obj(raw)
      if (!block || block.type !== 'tool_use') continue
      const label = summarizeTool(str(block.name) ?? 'tool', block.input)
      draft.update(parent, (item) => item.kind === 'tool'
        ? { ...item, childCount: (item.childCount ?? 0) + 1, lastChild: label }
        : item)
    }
    return
  }

  for (const raw of content) {
    const block = obj(raw)
    if (!block) continue
    const type = str(block.type)
    if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
      const id = str(block.id)
      const existing = draft.tool(id)
      const fresh = toolItem(block, 'running')
      if (existing !== undefined) {
        draft.update(existing, (item) => item.kind === 'tool'
          ? { ...item, name: fresh.name, label: fresh.label, input: fresh.input, status: item.status === 'pending' ? 'running' : item.status }
          : item)
      } else {
        draft.push(fresh)
      }
      continue
    }
    if (type === 'text' || type === 'thinking') {
      const text = type === 'text' ? str(block.text) ?? '' : str(block.thinking) ?? ''
      // Match the block streamed for this message, if any: the final message is authoritative.
      const openKey = Object.keys(draft.openBlocks).find((key) => {
        if (!key.startsWith(`${messageId}:`)) return false
        const item = draft.items[draft.openBlocks[key]]
        return item?.kind === type
      })
      if (openKey !== undefined) {
        const index = draft.openBlocks[openKey]
        delete draft.blocksMut()[openKey]
        draft.update(index, (item) => (item.kind === 'text' || item.kind === 'thinking')
          ? { ...item, text: text || item.text, streaming: false }
          : item)
        continue
      }
      if (!text.trim()) continue
      draft.push(type === 'text'
        ? { kind: 'text', id: draft.nextId(), text }
        : { kind: 'thinking', id: draft.nextId(), text })
    }
  }
}

function applyStreamEvent(draft: Draft, event: Json, current: string): Partial<ChatState> {
  const type = str(event.type)
  if (type === 'message_start') {
    const messageId = str(obj(event.message)?.id)
    return messageId ? { streamMessage: messageId } : {}
  }
  if (type === 'content_block_start') {
    const block = obj(event.content_block)
    const index = typeof event.index === 'number' ? event.index : -1
    if (!block || index < 0) return {}
    const blockType = str(block.type)
    if (blockType === 'text' || blockType === 'thinking') {
      const at = draft.push(blockType === 'text'
        ? { kind: 'text', id: draft.nextId(), text: '', streaming: true }
        : { kind: 'thinking', id: draft.nextId(), text: '', streaming: true })
      draft.blocksMut()[`${current}:${index}`] = at
    } else if (blockType === 'tool_use' || blockType === 'server_tool_use') {
      const id = str(block.id)
      if (id && draft.tool(id) === undefined) draft.push(toolItem(block, 'pending'))
    }
    return {}
  }
  if (type === 'content_block_delta') {
    const delta = obj(event.delta)
    const index = typeof event.index === 'number' ? event.index : -1
    const at = draft.openBlocks[`${current}:${index}`]
    if (!delta || at === undefined) return {}
    const piece = delta.type === 'text_delta' ? str(delta.text)
      : delta.type === 'thinking_delta' ? str(delta.thinking)
        : undefined
    if (!piece) return {}
    draft.update(at, (item) => (item.kind === 'text' || item.kind === 'thinking')
      ? { ...item, text: item.text + piece }
      : item)
  }
  return {}
}

function applyToolResults(draft: Draft, content: unknown[]): void {
  for (const raw of content) {
    const block = obj(raw)
    if (!block || block.type !== 'tool_result') continue
    const index = draft.tool(str(block.tool_use_id))
    if (index === undefined) continue
    const isError = block.is_error === true
    const { text, images } = toolResultContent(block.content)
    draft.update(index, (item) => item.kind === 'tool'
      ? {
          ...item,
          status: item.status === 'denied' ? 'denied' : (isError ? 'error' : 'done'),
          result: truncate(text, RESULT_TEXT_LIMIT),
          ...(images.length > 0 ? { images } : {})
        }
      : item)
  }
}

function applyUserMessage(draft: Draft, m: Json, history: boolean): Partial<ChatState> {
  if (m.isMeta === true || m.isSynthetic === true) return {}
  const message = obj(m.message)
  if (!message) return {}
  if (m.parent_tool_use_id) return {}
  const content = message.content
  const uuid = str(m.uuid)

  // Our own send, echoed back once Claude takes it (--replay-user-messages).
  if (!history && m.isReplay === true && uuid) {
    const queued = draft.items.findIndex((item) => item.kind === 'user' && item.id === uuid)
    if (queued >= 0) {
      draft.update(queued, (item) => item.kind === 'user' ? { ...item, queued: false } : item)
      return { busy: true }
    }
  }

  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  applyToolResults(draft, blocks)

  const texts: string[] = []
  let images = 0
  for (const raw of blocks) {
    const block = obj(raw)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') images++
  }
  if (texts.length === 0 && images === 0) return {}

  const shown = texts.map(classifyUserText).filter((entry): entry is { kind: 'user' | 'notice'; text: string } => entry !== null)
  const userText = shown.filter((entry) => entry.kind === 'user').map((entry) => entry.text).join('\n')
  if (userText || images > 0) {
    if (uuid && draft.items.some((item) => item.kind === 'user' && item.id === uuid)) return {}
    draft.push({ kind: 'user', id: uuid ?? draft.nextId(), text: userText, images })
  }
  for (const entry of shown) {
    if (entry.kind === 'notice') draft.push({ kind: 'notice', id: draft.nextId(), text: entry.text, tone: 'muted' })
  }
  return {}
}

function applySystemMessage(draft: Draft, state: ChatState, m: Json): Partial<ChatState> {
  const subtype = str(m.subtype)
  switch (subtype) {
    case 'init':
      return {
        info: {
          ...state.info,
          sessionId: str(m.session_id) ?? state.info.sessionId,
          model: str(m.model) ?? state.info.model,
          permissionMode: str(m.permissionMode) ?? state.info.permissionMode,
          cwd: str(m.cwd) ?? state.info.cwd,
          claudeVersion: str(m.claude_code_version) ?? state.info.claudeVersion
        }
      }
    case 'status': {
      const mode = str(m.permissionMode)
      return {
        compacting: m.status === 'compacting',
        ...(mode ? { info: { ...state.info, permissionMode: mode } } : {})
      }
    }
    case 'compact_boundary':
      draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text: 'Context compacted', tone: 'muted' })
      return { compacting: false }
    case 'api_retry': {
      const attempt = typeof m.attempt === 'number' ? m.attempt : 0
      const max = typeof m.max_retries === 'number' ? m.max_retries : 0
      const status = typeof m.error_status === 'number' ? ` (${m.error_status})` : ''
      const text = `API error${status}, retrying ${attempt}/${max}…`
      const last = draft.items[draft.items.length - 1]
      if (last?.kind === 'notice' && last.text.startsWith('API error')) {
        draft.update(draft.items.length - 1, (item) => item.kind === 'notice' ? { ...item, text } : item)
      } else {
        draft.push({ kind: 'notice', id: draft.nextId(), text, tone: 'warning' })
      }
      return {}
    }
    case 'local_command_output': {
      const text = str(m.content)?.trim()
      if (text) draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text, tone: 'muted' })
      return {}
    }
    case 'informational': {
      const text = str(m.content)?.trim()
      if (text) {
        const tone = m.level === 'warning' ? 'warning' : 'muted'
        draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text, tone })
      }
      return {}
    }
    case 'permission_denied': {
      const index = draft.tool(str(m.tool_use_id))
      if (index !== undefined) {
        const reason = str(m.message)
        draft.update(index, (item) => item.kind === 'tool' ? { ...item, status: 'denied', result: reason ?? item.result } : item)
      }
      return {}
    }
    case 'task_notification': {
      const summary = str(m.summary)?.trim()
      if (summary && m.skip_transcript !== true) {
        const tone = m.status === 'failed' ? 'warning' : 'muted'
        draft.push({ kind: 'notice', id: draft.nextId(str(m.uuid)), text: summary, tone })
      }
      return {}
    }
    default:
      return {}
  }
}

function applyResult(draft: Draft, state: ChatState, m: Json): Partial<ChatState> {
  for (const key of Object.keys(draft.openBlocks)) {
    const index = draft.openBlocks[key]
    draft.update(index, (item) => (item.kind === 'text' || item.kind === 'thinking') ? { ...item, streaming: false } : item)
  }
  draft.openBlocks = {}
  // Tool rows still spinning belong to a turn that is over (interrupt, error).
  draft.items.forEach((item, index) => {
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'waiting')) {
      draft.update(index, (current) => current.kind === 'tool' ? { ...current, status: 'done' } : current)
    }
  })
  const subtype = str(m.subtype)
  if (subtype && subtype !== 'success') {
    const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : []
    const last = draft.items[draft.items.length - 1]
    const interrupted = state.interrupting === true || errors.length === 0
      || errors.some((e) => /interrupt|abort/i.test(e))
      || (last?.kind === 'notice' && last.text === 'Interrupted')
    if (!interrupted) {
      draft.push({ kind: 'notice', id: draft.nextId(), text: errors.join('\n') || subtype.replace(/_/g, ' '), tone: 'error' })
    }
  } else if (m.is_error === true) {
    const text = str(m.result)?.trim()
    if (text) draft.push({ kind: 'notice', id: draft.nextId(), text, tone: 'error' })
  }
  return { busy: false, turnStartedAt: undefined, compacting: false, interrupting: false }
}

function applySdkMessage(state: ChatState, raw: unknown, at: number | undefined, history: boolean, draft: Draft): Partial<ChatState> {
  const m = obj(raw)
  if (!m) return {}
  switch (m.type) {
    case 'stream_event': {
      if (history || m.parent_tool_use_id) return {}
      const event = obj(m.event)
      const patch = event ? applyStreamEvent(draft, event, state.streamMessage ?? '') : {}
      return state.busy ? patch : { ...patch, busy: true, turnStartedAt: at ?? state.turnStartedAt }
    }
    case 'assistant': {
      const message = obj(m.message)
      if (message) applyAssistantBlocks(draft, message, str(m.parent_tool_use_id) ?? null)
      return history || state.busy ? {} : { busy: true, turnStartedAt: at ?? state.turnStartedAt }
    }
    case 'user':
      return applyUserMessage(draft, m, history)
    case 'system':
      return applySystemMessage(draft, state, m)
    case 'result':
      return history ? {} : applyResult(draft, state, m)
    default:
      return {}
  }
}

/** Fold one event into the state. Pure: returns a new state, sharing what didn't change. */
export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.t) {
    case 'sdk': {
      if (obj(event.m)?.type === 'conversation_reset') {
        return { ...emptyChatState(), process: state.process, info: state.info, models: state.models, commands: state.commands, usage: state.usage }
      }
      const draft = new Draft(state, `i${state.items.length}-`)
      return draft.result(applySdkMessage(state, event.m, event.at, false, draft))
    }
    case 'history': {
      let next = state
      for (const message of event.messages) {
        const draft = new Draft(next, `h${next.items.length}-`)
        const patch = applySdkMessage(next, message, undefined, true, draft)
        next = draft.result(patch)
      }
      // A history replay never leaves a turn open: whatever was running is over.
      const items = next.items.map((item) => item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')
        ? { ...item, status: 'done' as const }
        : item)
      return { ...next, items, busy: false, openBlocks: {} }
    }
    case 'sent': {
      const draft = new Draft(state, 's')
      draft.push({ kind: 'user', id: event.uuid, text: event.text, images: event.images, queued: true })
      return draft.result({ busy: true, turnStartedAt: state.busy ? state.turnStartedAt : (event.at ?? Date.now()) })
    }
    case 'prompt': {
      if (state.pending.some((prompt) => prompt.id === event.prompt.id)) return state
      const draft = new Draft(state, 'p')
      const index = draft.tool(event.prompt.toolUseId)
      if (index !== undefined) draft.update(index, (item) => item.kind === 'tool' ? { ...item, status: 'waiting' } : item)
      return draft.result({ pending: [...state.pending, event.prompt] })
    }
    case 'prompt-done': {
      const prompt = state.pending.find((p) => p.id === event.id)
      if (!prompt) return state
      const draft = new Draft(state, 'p')
      const index = draft.tool(prompt.toolUseId)
      if (index !== undefined) {
        draft.update(index, (item) => item.kind === 'tool'
          ? { ...item, status: event.allowed ? 'running' : 'denied' }
          : item)
      }
      return draft.result({ pending: state.pending.filter((p) => p.id !== event.id) })
    }
    case 'process': {
      if (event.state !== 'exited') {
        return { ...state, process: event.state, processError: event.state === 'starting' ? undefined : state.processError }
      }
      // The process took its open prompts and unconsumed messages with it.
      const draft = new Draft(state, 'x')
      draft.items.forEach((item, index) => {
        if (item.kind === 'user' && item.queued) {
          draft.update(index, (current) => current.kind === 'user' ? { ...current, queued: false, failed: true } : current)
        }
        if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'waiting')) {
          draft.update(index, (current) => current.kind === 'tool' ? { ...current, status: 'error' } : current)
        }
        if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
          draft.update(index, (current) => (current.kind === 'text' || current.kind === 'thinking') ? { ...current, streaming: false } : current)
        }
      })
      if (event.error) draft.push({ kind: 'notice', id: draft.nextId(), text: event.error, tone: 'error' })
      draft.openBlocks = {}
      return draft.result({
        process: 'exited',
        processError: event.error,
        busy: false,
        turnStartedAt: undefined,
        compacting: false,
        pending: []
      })
    }
    case 'notice': {
      const draft = new Draft(state, 'n')
      draft.push({ kind: 'notice', id: draft.nextId(), text: event.text, tone: event.tone })
      return draft.result({})
    }
    case 'meta':
      return {
        ...state,
        ...(event.models ? { models: event.models } : {}),
        ...(event.commands ? { commands: event.commands } : {}),
        ...(event.info ? { info: { ...state.info, ...event.info } } : {}),
        ...(event.usage ? { usage: { ...state.usage, ...event.usage } } : {})
      }
    case 'interrupting':
      return state.busy ? { ...state, interrupting: true } : state
    case 'reset':
      return { ...emptyChatState(), models: state.models, commands: state.commands, usage: state.usage }
  }
}

/** The picker row for the model a session reports (an alias, or a dated wire id). */
export function findModelOption(models: ChatModelOption[], model: string | undefined): ChatModelOption | undefined {
  if (!model) return undefined
  const base = model.replace(/\[.*\]$/, '')
  return models.find((m) => m.value === model)
    ?? models.find((m) => m.resolvedModel && (model === m.resolvedModel || model.startsWith(`${m.resolvedModel}-`) || base === m.resolvedModel.replace(/\[.*\]$/, '')))
    ?? models.find((m) => m.value !== 'default' && base.includes(`-${m.value.replace(/\[.*\]$/, '')}-`))
}

/** Which kind of prompt a `canUseTool` call is, from the tool it is about. */
export function promptKindFor(toolName: string): ChatPromptKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'permission'
}

export const CHAT_PERMISSION_MODES = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass' }
] as const

/** Built-in commands that only make sense in the terminal UI. */
export const TERMINAL_ONLY_COMMANDS = new Set([
  'login', 'logout', 'config', 'settings', 'theme', 'terminal-setup', 'vim', 'doctor', 'ide',
  'install-github-app', 'permissions', 'hooks', 'agents', 'mcp', 'plugin', 'resume', 'status',
  'statusline', 'upgrade', 'exit', 'quit', 'rewind', 'export', 'memory', 'privacy-settings'
])
