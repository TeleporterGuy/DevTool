import { randomUUID } from 'crypto'
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import { loadClaudeSdk } from './sdk'
import {
  promptKindFor,
  type ChatEvent,
  type ChatImage,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatUsage
} from '../../shared/claude-chat'

/**
 * Hook events forwarded to DevTool's status pipeline, in-process (no curl, no
 * tunnel). PermissionRequest is not among them: its callback can land after the
 * prompt was already answered, which would re-raise attention for a dialog that is
 * gone. The session reports prompts itself, from `canUseTool`, which is exact.
 */
export const FORWARDED_HOOK_EVENTS: HookEvent[] = [
  'SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'
]

/** Mid-turn context refreshes are at most this often; a turn's end always refreshes. */
const CONTEXT_REFRESH_MS = 20_000

/** A plan window from `/usage`'s answer, when it has a number. */
function limitWindow(raw: { utilization: number | null; resets_at: string | null } | null | undefined): ChatUsage['fiveHour'] {
  if (!raw || typeof raw.utilization !== 'number') return undefined
  return { utilization: raw.utilization, ...(raw.resets_at ? { resetsAt: raw.resets_at } : {}) }
}

/** SDK messages no window draws; dropped before they cost an IPC hop. */
export function isDisplayRelevant(message: unknown): boolean {
  const m = message as { type?: string; subtype?: string; event?: { type?: string; delta?: { type?: string } } } | null
  if (!m || typeof m !== 'object') return false
  switch (m.type) {
    case 'stream_event': {
      const type = m.event?.type
      if (type === 'message_start' || type === 'content_block_start') return true
      if (type === 'content_block_delta') {
        const delta = m.event?.delta?.type
        return delta === 'text_delta' || delta === 'thinking_delta'
      }
      return false
    }
    case 'system':
      return m.subtype !== 'hook_started' && m.subtype !== 'hook_progress' && m.subtype !== 'hook_response'
        && m.subtype !== 'thinking_tokens' && m.subtype !== 'notification' && m.subtype !== 'files_persisted'
    case 'assistant':
    case 'user':
    case 'result':
    case 'conversation_reset':
      return true
    default:
      return false
  }
}

/** `--flag value` / `--flag` pairs from the project's extra Claude args, for `extraArgs`. */
export function extraArgsRecord(args: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      out[arg.slice(2)] = next
      i++
    } else {
      out[arg.slice(2)] = null
    }
  }
  return out
}

/** Flags the SDK already owns; letting a project override them would break the protocol. */
const RESERVED_FLAGS = new Set([
  'print', 'p', 'output-format', 'input-format', 'verbose', 'resume', 'r', 'continue', 'c',
  'session-id', 'permission-prompt-tool', 'include-partial-messages', 'replay-user-messages',
  'setting-sources', 'fork-session'
])

export interface ChatSessionOptions {
  cwd: string
  sessionId: string
  /** The transcript exists: continue it with `resume` rather than creating it. */
  resume: boolean
  /** `claude` to run — resolved locally, or the bare name for a remote login shell. */
  executable: string
  env: Record<string, string | undefined>
  extraArgs?: string[]
  model?: string
  permissionMode?: string
  effort?: string
  /** Remote projects spawn through ssh; local ones let the SDK spawn. */
  spawn?: (options: SpawnOptions) => SpawnedProcess
  onEvent: (event: ChatEvent) => void
  onHook: (body: Record<string, unknown>) => void
  onPromptResolved: (prompt: ChatPrompt, allowed: boolean) => void
  onExit: (error?: string) => void
  log: (message: string) => void
}

interface HeldPrompt {
  prompt: ChatPrompt
  suggestions?: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
}

/** A minimal async queue: the streaming-input `prompt` of a long-lived `query()`. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private done = false

  push(message: SDKUserMessage): void {
    if (this.done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
    } else {
      this.items.push(message)
    }
  }

  end(): void {
    this.done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      }
    }
  }
}

/**
 * One long-lived `claude` process for one chat tab, driven through the Agent SDK's
 * streaming input: messages are pushed into the input stream as they are sent —
 * mid-turn too, where Claude picks them up at its next step, as when typing into
 * the terminal UI. Permission prompts arrive as `canUseTool` calls and are held
 * open until a window answers them.
 */
export class ChatSession {
  private readonly input = new MessageQueue()
  private query: Query | null = null
  private readonly held = new Map<string, HeldPrompt>()
  private closedByUs = false
  private stderrTail = ''
  private ended = false
  private running = false
  /** Usage refresh in flight, and whether another was asked for meanwhile (and with limits). */
  private usageBusy = false
  private usageAgain: boolean | null = null
  private lastContextRefresh = 0
  /** A turn reported its cost; that running total (it includes a resumed session's past turns) wins over `/usage`'s. */
  private sawResultCost = false

  constructor(private readonly options: ChatSessionOptions) {}

  async start(): Promise<void> {
    const sdk = await loadClaudeSdk()
    const o = this.options
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const event of FORWARDED_HOOK_EVENTS) {
      hooks[event] = [{
        hooks: [async (input) => {
          try { o.onHook(input as unknown as Record<string, unknown>) } catch { /* status is best-effort */ }
          return {}
        }]
      }]
    }

    const extra: Record<string, string | null> = { 'replay-user-messages': null }
    for (const [key, value] of Object.entries(extraArgsRecord(o.extraArgs ?? []))) {
      if (!RESERVED_FLAGS.has(key)) extra[key] = value
    }

    const queryOptions: Options = {
      cwd: o.cwd,
      pathToClaudeCodeExecutable: o.executable,
      env: o.env,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      hooks,
      extraArgs: extra,
      allowDangerouslySkipPermissions: true,
      ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
      ...(o.model ? { model: o.model } : {}),
      ...(o.permissionMode ? { permissionMode: o.permissionMode as PermissionMode } : {}),
      ...(o.effort ? { effort: o.effort as Options['effort'] } : {}),
      ...(o.spawn ? { spawnClaudeCodeProcess: o.spawn } : {}),
      stderr: (data: string) => { this.captureStderr(data) }
    }

    // The SDK always passes `--permission-mode`, which would override the user's own
    // `permissions.defaultMode`. Resolve it the way the CLI does (repo-committed
    // escalations filtered out) so a chat starts in the mode a terminal would.
    // Remote settings live on the host, where the CLI's default applies.
    if (!o.permissionMode && !o.spawn) {
      try {
        const resolved = await sdk.resolveSettings({ cwd: o.cwd, settingSources: ['user', 'project', 'local'] })
        const mode = sdk.filterEscalatingDefaultMode(resolved).permissions?.defaultMode
        if (mode) queryOptions.permissionMode = mode as PermissionMode
      } catch {
        // Fall back to the CLI default.
      }
    }

    o.onEvent({ t: 'process', state: 'starting' })
    if (queryOptions.permissionMode) o.onEvent({ t: 'meta', info: { permissionMode: queryOptions.permissionMode } })
    this.query = sdk.query({ prompt: this.input, options: queryOptions })
    void this.pump(this.query)
    void this.loadMeta(this.query)
  }

  captureStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-4000)
  }

  private async pump(query: Query): Promise<void> {
    let error: string | undefined
    try {
      for await (const message of query) {
        if ((message as { type?: string }).type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          this.markRunning()
        }
        if (isDisplayRelevant(message)) this.options.onEvent({ t: 'sdk', m: message, at: Date.now() })
        this.noteForUsage(message as { type?: string; subtype?: string; parent_tool_use_id?: unknown; total_cost_usd?: unknown })
      }
    } catch (err) {
      if (!this.closedByUs) {
        const message = err instanceof Error ? err.message : String(err)
        const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n')
        error = tail && !message.includes(tail) ? `${message}\n${tail}` : message
        this.options.log(`chatSession error=${JSON.stringify(error)}`)
      }
    } finally {
      this.finish(error)
    }
  }

  private markRunning(): void {
    if (this.running || this.ended) return
    this.running = true
    this.options.onEvent({ t: 'process', state: 'running' })
  }

  private finish(error?: string): void {
    if (this.ended) return
    this.ended = true
    for (const held of this.held.values()) {
      held.resolve({ behavior: 'deny', message: 'The session ended.' })
    }
    this.held.clear()
    this.input.end()
    this.options.onEvent({ t: 'process', state: 'exited', ...(error ? { error } : {}) })
    this.options.onExit(error)
  }

  /** Keep the composer's meter current: a turn's end, a compaction, a limit change, and now and then mid-turn. */
  private noteForUsage(m: { type?: string; subtype?: string; parent_tool_use_id?: unknown; total_cost_usd?: unknown }): void {
    if (m.type === 'result') {
      if (typeof m.total_cost_usd === 'number' && m.total_cost_usd > 0) {
        this.sawResultCost = true
        this.options.onEvent({ t: 'meta', usage: { costUsd: m.total_cost_usd } })
      }
      this.refreshUsage(true)
    } else if (m.type === 'rate_limit_event') {
      this.refreshUsage(true)
    } else if (m.type === 'conversation_reset' || (m.type === 'system' && m.subtype === 'compact_boundary')) {
      this.refreshUsage(false)
    } else if (m.type === 'assistant' && !m.parent_tool_use_id && Date.now() - this.lastContextRefresh > CONTEXT_REFRESH_MS) {
      this.refreshUsage(false)
    }
  }

  /** Read `/context` (and, with `limits`, `/usage`) from the CLI. Best-effort: a failure leaves the last numbers. */
  private refreshUsage(limits: boolean): void {
    const query = this.query
    if (!query || this.ended) return
    if (this.usageBusy) {
      this.usageAgain = (this.usageAgain ?? false) || limits
      return
    }
    this.usageBusy = true
    this.lastContextRefresh = Date.now()
    void (async () => {
      const usage: ChatUsage = {}
      const context = await query.getContextUsage({ detail: 'summary' }).catch(() => null)
      if (context) {
        usage.contextTokens = context.totalTokens
        usage.contextMax = context.maxTokens
      }
      if (limits) {
        const plan = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null)
        if (plan) {
          if (!this.sawResultCost && plan.session.total_cost_usd > 0) usage.costUsd = plan.session.total_cost_usd
          usage.fiveHour = limitWindow(plan.rate_limits?.five_hour)
          usage.sevenDay = limitWindow(plan.rate_limits?.seven_day)
        }
      }
      if (!this.ended && Object.keys(usage).length > 0) this.options.onEvent({ t: 'meta', usage })
    })().finally(() => {
      this.usageBusy = false
      const again = this.usageAgain
      this.usageAgain = null
      if (again !== null) this.refreshUsage(again)
    })
  }

  private async loadMeta(query: Query): Promise<void> {
    try {
      const [models, commands] = await Promise.all([
        query.supportedModels().catch(() => []),
        query.supportedCommands().catch(() => [])
      ])
      // The CLI answered its initialize handshake: it is up, even though `system:init`
      // only comes with the first turn.
      if (!this.ended) this.markRunning()
      this.refreshUsage(true)
      this.options.onEvent({
        t: 'meta',
        models: models.map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel,
          displayName: m.displayName,
          description: m.description,
          supportedEffortLevels: m.supportedEffortLevels
        })),
        // Names can repeat (a user skill and a plugin one); the first row is the one /name runs.
        commands: commands
          .filter((c, index) => commands.findIndex((other) => other.name === c.name) === index)
          .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      })
    } catch {
      // Pickers fall back to free text.
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const prompt: ChatPrompt = {
      id: options.requestId || randomUUID(),
      kind: promptKindFor(toolName),
      toolName,
      toolUseId: options.toolUseID,
      input,
      suggestions: options.suggestions,
      blockedPath: options.blockedPath,
      title: options.title,
      description: options.description,
      reason: options.decisionReason,
      agentId: options.agentID
    }
    return new Promise<PermissionResult>((resolve) => {
      this.held.set(prompt.id, { prompt, suggestions: options.suggestions, resolve })
      options.signal.addEventListener('abort', () => {
        if (!this.held.delete(prompt.id)) return
        resolve({ behavior: 'deny', message: 'Cancelled.' })
        this.options.onEvent({ t: 'prompt-done', id: prompt.id, allowed: false })
        this.options.onPromptResolved(prompt, false)
      }, { once: true })
      this.options.onEvent({ t: 'prompt', prompt })
      if (prompt.kind === 'permission') {
        this.options.onHook({ hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: input, tool_use_id: options.toolUseID })
      }
    })
  }

  /** Answer a held prompt. False when it is no longer open (another window answered). */
  respond(promptId: string, response: ChatPromptResponse): boolean {
    const held = this.held.get(promptId)
    if (!held) return false
    this.held.delete(promptId)
    const { prompt } = held
    let result: PermissionResult
    if (response.behavior === 'allow') {
      // "Always" on a plan means what the terminal's plan dialog offers: leave plan
      // mode straight into accepting edits. Otherwise it applies Claude's own rules.
      const updatedPermissions: PermissionUpdate[] | undefined = !response.always
        ? undefined
        : prompt.kind === 'plan'
          ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
          : held.suggestions?.length ? held.suggestions : undefined
      result = {
        behavior: 'allow',
        updatedInput: response.updatedInput ?? prompt.input,
        ...(updatedPermissions ? { updatedPermissions } : {})
      }
    } else {
      result = { behavior: 'deny', message: response.message?.trim() || 'The user declined this action.' }
    }
    held.resolve(result)
    const allowed = response.behavior === 'allow'
    this.options.onEvent({ t: 'prompt-done', id: promptId, allowed })
    this.options.onPromptResolved(prompt, allowed)
    return true
  }

  /** Queue a user message. Returns its uuid, which the replay echo carries back. */
  send(text: string, images: ChatImage[] = []): string {
    const uuid = randomUUID()
    const content = images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.data }
          })),
          ...(text ? [{ type: 'text' as const, text }] : [])
        ]
    this.options.onEvent({ t: 'sent', uuid, text, images: images.length, at: Date.now() })
    this.input.push({
      type: 'user',
      uuid: uuid as SDKUserMessage['uuid'],
      message: { role: 'user', content },
      parent_tool_use_id: null
    })
    return uuid
  }

  async interrupt(): Promise<void> {
    this.options.onEvent({ t: 'interrupting' })
    await this.query?.interrupt().catch((err) => this.options.log(`chatInterrupt error=${String(err)}`))
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query?.setModel(model)
    this.options.onEvent({ t: 'meta', info: { model } })
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.query?.setPermissionMode(mode as PermissionMode)
    this.options.onEvent({ t: 'meta', info: { permissionMode: mode } })
  }

  async setEffort(effort: string | undefined): Promise<void> {
    await this.query?.applyFlagSettings({ effortLevel: (effort ?? null) as never })
    this.options.onEvent({ t: 'meta', info: { effort } })
  }

  isEnded(): boolean {
    return this.ended
  }

  close(): void {
    if (this.ended) return
    this.closedByUs = true
    this.input.end()
    try { this.query?.close() } catch { /* already gone */ }
    // close() may not settle the pump if the process never started.
    this.finish()
  }
}
