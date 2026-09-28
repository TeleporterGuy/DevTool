import { ChatLimits, capText } from '../ts/index.ts'
import type {
  ChatAnswer,
  ChatDetailResult,
  ChatEarlierResult,
  ChatView,
  ChatViewItem,
  ChatViewPrompt,
  ChatViewStatus
} from '../ts/index.ts'

/**
 * The fake desktop's canned Claude chat (SPEC.md §6), for building the phone side
 * without Claude. Deterministic: the same sends and answers at the same times always
 * give the same transcript.
 *
 * Every message you send runs the same short turn:
 *   1. a thinking row, then a reply streamed over ~3 s;
 *   2. a Bash permission prompt (Allow / Always allow / Deny);
 *   3. allowed: the tool runs and finishes, then a question (one single-select and one
 *      multi-select); the answers are echoed back;
 *   4. a plan (ExitPlanMode) to approve or keep planning; the turn ends with the outcome.
 * Denying at any step ends the turn with a line saying so. Stop ends it with "Interrupted".
 *
 * Two words are commands: `reset` restores the starting transcript, and `long` adds a
 * reply of about 120 KB plus a tool whose detail is about 150 KB, so both an event and
 * a `chat.detail` result have to be fragmented (§6.1).
 */

export interface ChatPatch {
  upserts: ChatViewItem[]
  removes: string[]
}

export interface FakeChatOptions {
  tabId: string
  title: string
  now: () => number
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void
  /** Something changed: these items, and possibly the prompts or status. */
  onChange: (patch: ChatPatch) => void
}

interface Entry {
  item: ChatViewItem
  /** Full text for text/user items whose view text is capped; tool input/result for tools. */
  full?: string
  input?: string
  result?: string
}

interface HeldPrompt {
  prompt: ChatViewPrompt
  resolve: (answer: ChatAnswer) => void
}

/** One chunk of streamed text every this many ms. */
export const STREAM_STEP_MS = 250

const REPLY = [
  'Sure. I looked at `src/auth.ts` and the session check ',
  'compares the token expiry in **seconds** against ',
  '`Date.now()` in milliseconds, so every token ',
  'looks expired.\n\n',
  'The fix is one line:\n\n',
  '```ts\n',
  'if (token.exp * 1000 < Date.now()) return null\n',
  '```\n\n',
  "Let me run the tests to make sure nothing else ",
  'depends on the old behaviour.'
]

const PLAN = [
  '## Plan',
  '',
  '1. Multiply `exp` by 1000 in `verifySession`.',
  '2. Add a regression test for a token that expires in one minute.',
  '3. Note the fix in `CHANGELOG.md`.'
].join('\n')

const QUESTIONS = [
  {
    question: 'Which database should the regression test use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'SQLite', description: 'In memory, fast' },
      { label: 'Postgres', description: 'Same as production' }
    ]
  },
  {
    question: 'Which extras should I add?',
    header: 'Extras',
    multiSelect: true,
    options: [{ label: 'Changelog entry' }, { label: 'Docs update' }, { label: 'Metrics' }]
  }
]

function seedHistory(): Entry[] {
  const entries: Entry[] = []
  for (let n = 1; n <= 24; n++) {
    entries.push({ item: { kind: 'user', id: `h-u${n}`, text: `Earlier question #${n}: what does module ${n} do?` } })
    const input = JSON.stringify({ file_path: `src/module-${n}.ts` }, null, 2)
    entries.push({
      item: { kind: 'tool', id: `h-t${n}`, name: 'Read', summary: `Read · src/module-${n}.ts`, status: 'done', hasDetail: true },
      input,
      result: `export function module${n}() {\n  return ${n}\n}\n`
    })
    entries.push({ item: { kind: 'text', id: `h-a${n}`, markdown: `Module ${n} returns **${n}**. Nothing else in it.` } })
  }
  entries.push({ item: { kind: 'notice', id: 'h-n1', text: 'Conversation resumed', tone: 'muted' } })
  return entries
}

export class FakeChat {
  readonly tabId: string
  readonly title: string
  readonly #o: FakeChatOptions
  #entries: Entry[] = seedHistory()
  #held: HeldPrompt[] = []
  #status: ChatViewStatus = { busy: false, process: 'running', permissionMode: 'default', model: 'claude-fake-1' }
  #timers = new Set<() => void>()
  #next = 1
  #turn = 0

  constructor(options: FakeChatOptions) {
    this.#o = options
    this.tabId = options.tabId
    this.title = options.title
  }

  get status(): ChatViewStatus {
    return { ...this.#status }
  }

  get prompts(): ChatViewPrompt[] {
    return this.#held.map((h) => h.prompt)
  }

  /** All items, oldest first. */
  get items(): ChatViewItem[] {
    return this.#entries.map((e) => e.item)
  }

  view(): ChatView {
    const items = this.items
    const window = items.slice(-ChatLimits.window)
    return {
      tabId: this.tabId,
      title: this.title,
      ...this.status,
      items: window,
      hasEarlier: items.length > window.length,
      prompts: this.prompts
    }
  }

  /** null when `before` is unknown. */
  earlier(before: string, limit: number = ChatLimits.earlier): ChatEarlierResult | null {
    const index = this.#entries.findIndex((e) => e.item.id === before)
    if (index < 0) return null
    const start = Math.max(0, index - limit)
    return { items: this.#entries.slice(start, index).map((e) => e.item), hasEarlier: start > 0 }
  }

  /** null when the item is unknown. */
  detail(itemId: string): ChatDetailResult | null {
    const entry = this.#entries.find((e) => e.item.id === itemId)
    if (!entry) return null
    const item = entry.item
    if (item.kind === 'tool') {
      const input = capText(entry.input ?? '{}', ChatLimits.detail).text
      return entry.result !== undefined ? { kind: 'tool', input, result: capText(entry.result, ChatLimits.detail).text } : { kind: 'tool', input }
    }
    const text = entry.full ?? (item.kind === 'text' ? item.markdown : item.kind === 'thinking' ? item.preview : item.kind === 'user' || item.kind === 'notice' ? item.text : '')
    return { kind: 'text', markdown: text }
  }

  send(text: string): void {
    const command = text.trim().toLowerCase()
    if (command === 'reset') {
      this.#reset()
      return
    }
    const id = `u${this.#next++}`
    this.#add({ kind: 'user', id, text: capText(text, ChatLimits.text).text }, { full: text })
    if (this.#status.busy) {
      this.#add({ kind: 'notice', id: this.#id('n'), text: 'The fake desktop answers one message at a time.', tone: 'warning' })
      return
    }
    this.#setStatus({ busy: true, turnStartedAt: this.#o.now() })
    if (command === 'long') this.#longTurn()
    else void this.#scriptedTurn(++this.#turn)
  }

  /** 'gone' for an unknown or already-answered prompt, 'bad-request' when the answer doesn't fit it. */
  answer(promptId: string, answer: ChatAnswer): 'ok' | 'gone' | 'bad-request' {
    const index = this.#held.findIndex((h) => h.prompt.id === promptId)
    if (index < 0) return 'gone'
    const { prompt, resolve } = this.#held[index]
    const fits = prompt.kind === 'question'
      ? answer.behavior === 'answers' || answer.behavior === 'deny'
      : prompt.kind === 'plan'
        ? answer.behavior === 'approvePlan' || answer.behavior === 'deny'
        : answer.behavior === 'allow' || answer.behavior === 'deny'
    if (!fits) return 'bad-request'
    if (prompt.kind === 'question' && answer.behavior === 'answers') {
      const missing = prompt.questions.some((q) => !answer.answers[q.question]?.trim())
      if (missing) return 'bad-request'
    }
    this.#held.splice(index, 1)
    resolve(answer)
    return 'ok'
  }

  interrupt(): void {
    if (!this.#status.busy) return
    this.#cancelTimers()
    this.#turn++
    const touched: ChatViewItem[] = []
    for (const entry of this.#entries) {
      const item = entry.item
      if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
        const { streaming: _, ...rest } = item
        entry.item = rest
        touched.push(entry.item)
      } else if (item.kind === 'tool' && (item.status === 'running' || item.status === 'waiting' || item.status === 'pending')) {
        entry.item = { ...item, status: 'error' }
        touched.push(entry.item)
      }
    }
    this.#held = []
    const notice: ChatViewItem = { kind: 'notice', id: this.#id('n'), text: 'Interrupted', tone: 'muted' }
    this.#entries.push({ item: notice })
    this.#status = { ...this.#status, busy: false, turnStartedAt: undefined }
    this.#o.onChange({ upserts: [...touched, notice], removes: [] })
  }

  dispose(): void {
    this.#cancelTimers()
  }

  // ---- the script -------------------------------------------------------------

  async #scriptedTurn(turn: number): Promise<void> {
    const live = (): boolean => this.#turn === turn
    const thinkingId = this.#id('think')
    this.#add({ kind: 'thinking', id: thinkingId, preview: 'The user wants the auth bug fixed. The expiry check looks like a unit mismatch', streaming: true })
    await this.#wait(600)
    if (!live()) return
    this.#update(thinkingId, (item) => item.kind === 'thinking' ? { kind: 'thinking', id: item.id, preview: `${item.preview}.` } : item)

    const replyId = this.#id('reply')
    let reply = ''
    this.#add({ kind: 'text', id: replyId, markdown: '', streaming: true })
    for (const piece of REPLY) {
      await this.#wait(STREAM_STEP_MS)
      if (!live()) return
      reply += piece
      const markdown = reply
      this.#update(replyId, () => ({ kind: 'text', id: replyId, markdown, streaming: true }))
    }
    this.#update(replyId, () => ({ kind: 'text', id: replyId, markdown: reply }))

    // Permission
    const toolId = this.#id('toolu')
    const command = 'npm test -- auth'
    this.#add(
      { kind: 'tool', id: toolId, name: 'Bash', summary: `Bash · ${command}`, status: 'waiting', hasDetail: true },
      { input: JSON.stringify({ command, description: 'Run the auth tests' }, null, 2) }
    )
    const permission = await this.#ask({
      kind: 'permission',
      id: this.#id('perm'),
      toolName: 'Bash',
      title: 'Allow Bash?',
      summary: `Bash · ${command}`,
      detail: `${command}\n\nRun the auth tests`,
      canAlwaysAllow: true
    })
    if (!live()) return
    if (permission.behavior !== 'allow') {
      this.#update(toolId, (item) => item.kind === 'tool' ? { ...item, status: 'denied' } : item)
      const why = permission.behavior === 'deny' && permission.message ? ` You said: “${permission.message}”` : ''
      this.#finish(`OK, I won't run the tests.${why}`)
      return
    }
    this.#update(toolId, (item) => item.kind === 'tool' ? { ...item, status: 'running' } : item)
    await this.#wait(1000)
    if (!live()) return
    this.#setResult(toolId, ' PASS  src/auth.test.ts\n  ✓ accepts a fresh token\n  ✓ rejects an expired token\n\nTests: 2 passed, 2 total')
    this.#update(toolId, (item) => item.kind === 'tool' ? { ...item, status: 'done' } : item)
    this.#add({
      kind: 'text',
      id: this.#id('text'),
      markdown: permission.always ? 'Tests pass. (I will run `npm test` without asking from now on.)' : 'Tests pass. Two quick questions before I write the regression test.'
    })

    // Question
    const question = await this.#ask({ kind: 'question', id: this.#id('ask'), questions: QUESTIONS })
    if (!live()) return
    if (question.behavior !== 'answers') {
      this.#finish('Skipping the questions; I will use SQLite and no extras.')
      return
    }
    const picked = QUESTIONS.map((q) => `- **${q.header}:** ${question.answers[q.question]}`).join('\n')
    this.#add({ kind: 'text', id: this.#id('text'), markdown: `Got it:\n\n${picked}\n\nHere is the plan.` })

    // Plan
    const plan = await this.#ask({ kind: 'plan', id: this.#id('plan'), markdown: PLAN })
    if (!live()) return
    if (plan.behavior !== 'approvePlan') {
      const why = plan.behavior === 'deny' && plan.message ? `: “${plan.message}”` : ''
      this.#finish(`Keeping the plan open${why}. Tell me what to change.`)
      return
    }
    const editId = this.#id('toolu')
    this.#add(
      { kind: 'tool', id: editId, name: 'Edit', summary: 'Edit · src/auth.ts', status: 'running', hasDetail: true },
      { input: JSON.stringify({ file_path: 'src/auth.ts', old_string: 'token.exp < Date.now()', new_string: 'token.exp * 1000 < Date.now()' }, null, 2) }
    )
    await this.#wait(500)
    if (!live()) return
    this.#setResult(editId, 'The file src/auth.ts has been updated.')
    this.#update(editId, (item) => item.kind === 'tool' ? { ...item, status: 'done' } : item)
    this.#finish('Plan approved. The fix is in; the regression test and changelog are next.')
  }

  #longTurn(): void {
    const toolId = this.#id('toolu')
    const line = (n: number): string => `${String(n).padStart(5, '0')} INFO request handled in ${n % 97} ms path=/api/v1/items/${n}\n`
    let log = ''
    for (let n = 0; log.length < 150_000; n++) log += line(n)
    this.#add(
      { kind: 'tool', id: toolId, name: 'Bash', summary: 'Bash · cat server.log', status: 'done', hasDetail: true },
      { input: JSON.stringify({ command: 'cat server.log' }, null, 2), result: log }
    )
    const paragraph = 'This is a long reply that exists to exercise fragmentation on the phone. '.repeat(200)
    const upserts: ChatViewItem[] = []
    for (let n = 0; n < 8; n++) {
      const full = `### Part ${n + 1}\n\n${paragraph}`
      const item: ChatViewItem = { kind: 'text', id: this.#id('long'), markdown: capText(full, ChatLimits.text).text }
      this.#entries.push({ item, full })
      upserts.push(item)
    }
    this.#status = { ...this.#status, busy: false, turnStartedAt: undefined }
    this.#o.onChange({ upserts, removes: [] })
  }

  #finish(text: string): void {
    const item: ChatViewItem = { kind: 'text', id: this.#id('text'), markdown: text }
    this.#entries.push({ item })
    this.#status = { ...this.#status, busy: false, turnStartedAt: undefined }
    this.#o.onChange({ upserts: [item], removes: [] })
  }

  #ask(prompt: ChatViewPrompt): Promise<ChatAnswer> {
    return new Promise((resolve) => {
      this.#held.push({ prompt, resolve })
      this.#o.onChange({ upserts: [], removes: [] })
    })
  }

  // ---- plumbing ---------------------------------------------------------------

  #id(prefix: string): string {
    return `${prefix}-${this.#next++}`
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.#o.schedule(() => {
        this.#timers.delete(cancel)
        resolve()
      }, ms)
      this.#timers.add(cancel)
    })
  }

  #cancelTimers(): void {
    for (const cancel of this.#timers) cancel()
    this.#timers.clear()
  }

  #add(item: ChatViewItem, extra: Omit<Entry, 'item'> = {}): void {
    this.#entries.push({ item, ...extra })
    this.#o.onChange({ upserts: [item], removes: [] })
  }

  #update(id: string, change: (item: ChatViewItem) => ChatViewItem): void {
    const entry = this.#entries.find((e) => e.item.id === id)
    if (!entry) return
    entry.item = change(entry.item)
    this.#o.onChange({ upserts: [entry.item], removes: [] })
  }

  #setResult(id: string, result: string): void {
    const entry = this.#entries.find((e) => e.item.id === id)
    if (entry) entry.result = result
  }

  #setStatus(patch: Partial<ChatViewStatus>): void {
    this.#status = { ...this.#status, ...patch }
    this.#o.onChange({ upserts: [], removes: [] })
  }

  #reset(): void {
    this.#cancelTimers()
    this.#turn++
    const removes = this.#entries.map((e) => e.item.id)
    this.#entries = seedHistory()
    this.#held = []
    this.#next = 1
    this.#status = { busy: false, process: 'running', permissionMode: 'default', model: 'claude-fake-1' }
    this.#o.onChange({ removes, upserts: this.items.slice(-ChatLimits.window) })
  }
}
