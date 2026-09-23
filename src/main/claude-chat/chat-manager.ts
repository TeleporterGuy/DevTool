import type { SshConfig } from '../../shared/types'
import {
  emptyChatState,
  reduceChat,
  type ChatEvent,
  type ChatImage,
  type ChatPrompt,
  type ChatPromptResponse,
  type ChatSnapshot,
  type ChatState
} from '../../shared/claude-chat'
import { ChatSession } from './chat-session'
import { createRemoteSpawner, type RemoteCommand } from './remote-spawn'
import { readLocalTranscript, readRemoteTranscript, SESSION_ID_RE } from './transcript'

/** What a window tells main about the chat tab it mounts. */
export interface ChatTabConfig {
  /** Local dir, or the remote dir for an ssh project. */
  cwd: string
  sessionId: string
  projectId?: string
  sshConfig?: SshConfig
  /** The project's extra Claude CLI args, already split. */
  extraArgs?: string[]
}

export interface ChatManagerDeps {
  sendToWindow: (windowId: number, channel: string, ...args: unknown[]) => void
  /** The local `claude` to run (Settings override, else PATH). */
  resolveLocalClaude: () => string
  /** Env for a local `claude`: the login shell's, as terminal tabs get. */
  localEnv: () => Record<string, string | undefined>
  /** Make sure the project's ssh master is up. */
  ensureSsh: (projectId: string, sshConfig: SshConfig) => Promise<void>
  /** argv for a non-tty `claude` on the project's host, through the master socket. */
  remoteCommand: (projectId: string, sshConfig: SshConfig, cwd: string, claudeArgs: string[], env: Record<string, string>) => RemoteCommand
  /** Run a script on the project's host and return stdout. */
  remoteExec: (projectId: string, sshConfig: SshConfig, script: string) => Promise<string>
  /** A hook payload from the session, for the status/activity pipeline. */
  onHook: (tabId: string, body: Record<string, unknown>) => void
  onPromptResolved: (tabId: string, prompt: ChatPrompt, allowed: boolean) => void
  /** The process started or ended (liveness for idle cleanup, status). */
  onProcessChange: (tabId: string, running: boolean, error?: string) => void
  log: (message: string) => void
}

interface ChatRuntime {
  tabId: string
  config: ChatTabConfig
  state: ChatState
  seq: number
  attached: Set<number>
  session: ChatSession | null
  /** History loaded (or being loaded); later attaches wait on it. */
  ready: Promise<void>
  /** The transcript exists on disk, so a (re)start resumes rather than creates. */
  hasTranscript: boolean
  model?: string
  permissionMode?: string
  effort?: string
}

/**
 * Chat tabs' processes, owned by main like PTYs: one per tab, shared by every
 * window that mounts it, kept running while the tab is hidden or its window is
 * gone, and ended only when the tab is closed, converted or the app quits.
 *
 * Main keeps each tab's folded {@link ChatState}; `attach` returns it as a
 * snapshot tagged with a sequence number, and every later event goes out with
 * the next one, so a window can apply events without ever double-counting.
 */
export class ClaudeChatManager {
  private readonly runtimes = new Map<string, ChatRuntime>()

  constructor(private readonly deps: ChatManagerDeps) {}

  async attach(windowId: number, tabId: string, config: ChatTabConfig): Promise<ChatSnapshot> {
    let runtime = this.runtimes.get(tabId)
    if (!runtime) {
      runtime = this.createRuntime(tabId, config)
    } else if (runtime.session === null || runtime.session.isEnded()) {
      // A dead process is restarted on the next send; keep config fresh for it.
      runtime.config = config
    }
    runtime.attached.add(windowId)
    await runtime.ready
    if (!runtime.session || runtime.session.isEnded()) {
      if (runtime.state.process === 'idle') void this.startSession(runtime)
    }
    return { seq: runtime.seq, state: runtime.state }
  }

  detach(windowId: number, tabId: string): void {
    this.runtimes.get(tabId)?.attached.delete(windowId)
  }

  detachWindow(windowId: number): void {
    for (const runtime of this.runtimes.values()) runtime.attached.delete(windowId)
  }

  attachedWindows(tabId: string): Set<number> | undefined {
    return this.runtimes.get(tabId)?.attached
  }

  has(tabId: string): boolean {
    return this.runtimes.has(tabId)
  }

  liveTabIds(): string[] {
    const ids: string[] = []
    for (const runtime of this.runtimes.values()) {
      if (runtime.session && !runtime.session.isEnded()) ids.push(runtime.tabId)
    }
    return ids
  }

  async send(tabId: string, text: string, images: ChatImage[] = []): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) throw new Error('chat tab not attached')
    await runtime.ready
    if (!runtime.session || runtime.session.isEnded()) await this.startSession(runtime)
    runtime.session?.send(text, images)
    runtime.hasTranscript = true
  }

  async interrupt(tabId: string): Promise<void> {
    await this.runtimes.get(tabId)?.session?.interrupt()
  }

  respond(tabId: string, promptId: string, response: ChatPromptResponse): boolean {
    return this.runtimes.get(tabId)?.session?.respond(promptId, response) ?? false
  }

  async setModel(tabId: string, model: string | undefined): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.model = model
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setModel(model)
    else this.emit(runtime, { t: 'meta', info: { model } })
  }

  async setPermissionMode(tabId: string, mode: string): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.permissionMode = mode
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setPermissionMode(mode)
    else this.emit(runtime, { t: 'meta', info: { permissionMode: mode } })
  }

  async setEffort(tabId: string, effort: string | undefined): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.effort = effort
    if (runtime.session && !runtime.session.isEnded()) await runtime.session.setEffort(effort)
    else this.emit(runtime, { t: 'meta', info: { effort } })
  }

  /** End the process but keep the timeline (e.g. before the tab turns into a terminal). */
  stop(tabId: string): void {
    this.runtimes.get(tabId)?.session?.close()
  }

  /** The tab is gone: end the process and forget everything. */
  close(tabId: string): void {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    runtime.session?.close()
    this.runtimes.delete(tabId)
  }

  closeAll(): void {
    for (const tabId of [...this.runtimes.keys()]) this.close(tabId)
  }

  private createRuntime(tabId: string, config: ChatTabConfig): ChatRuntime {
    const runtime: ChatRuntime = {
      tabId,
      config,
      state: emptyChatState(),
      seq: 0,
      attached: new Set(),
      session: null,
      ready: Promise.resolve(),
      hasTranscript: false
    }
    runtime.ready = this.loadHistory(runtime)
    this.runtimes.set(tabId, runtime)
    return runtime
  }

  private async loadHistory(runtime: ChatRuntime): Promise<void> {
    const { sessionId, cwd, projectId, sshConfig } = runtime.config
    if (!SESSION_ID_RE.test(sessionId)) return
    try {
      let messages: unknown[]
      if (sshConfig && projectId) {
        await this.deps.ensureSsh(projectId, sshConfig)
        messages = await readRemoteTranscript(sessionId, (script) => this.deps.remoteExec(projectId, sshConfig, script))
      } else {
        messages = await readLocalTranscript(sessionId, cwd)
      }
      runtime.hasTranscript = messages.length > 0
      if (messages.length > 0) this.emit(runtime, { t: 'history', messages })
      this.deps.log(`chatHistory tab=${runtime.tabId} messages=${messages.length}`)
    } catch (err) {
      this.deps.log(`chatHistory tab=${runtime.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      this.emit(runtime, { t: 'notice', text: `Couldn't load this conversation's history: ${err instanceof Error ? err.message : String(err)}`, tone: 'warning' })
    }
  }

  private async startSession(runtime: ChatRuntime): Promise<void> {
    if (runtime.session && !runtime.session.isEnded()) return
    const { tabId, config } = runtime
    const remote = config.sshConfig && config.projectId ? { projectId: config.projectId, sshConfig: config.sshConfig } : null
    let session: ChatSession | null = null
    const onEvent = (event: ChatEvent): void => {
      if (runtime.session !== session) return
      this.emit(runtime, event)
    }

    let spawn: ConstructorParameters<typeof ChatSession>[0]['spawn']
    let env: Record<string, string | undefined>
    let executable: string
    if (remote) {
      // The ssh master may be reconnecting; one attempt, then the send fails visibly.
      await this.deps.ensureSsh(remote.projectId, remote.sshConfig)
      env = { ...process.env }
      executable = 'claude'
      spawn = createRemoteSpawner(
        (claudeArgs, addedEnv) => this.deps.remoteCommand(remote.projectId, remote.sshConfig, config.cwd, claudeArgs, addedEnv),
        env,
        {
          onStderr: (text) => session?.captureStderr(text),
          onDropped: (line) => this.deps.log(`chatRemote dropped tab=${tabId} line=${JSON.stringify(line.slice(0, 200))}`),
          onSpawn: (command) => this.deps.log(`chatRemote spawn tab=${tabId} file=${command.file}`)
        }
      )
    } else {
      env = this.deps.localEnv()
      executable = this.deps.resolveLocalClaude()
    }

    session = new ChatSession({
      cwd: config.cwd,
      sessionId: config.sessionId,
      resume: runtime.hasTranscript,
      executable,
      env,
      extraArgs: config.extraArgs,
      model: runtime.model,
      permissionMode: runtime.permissionMode,
      effort: runtime.effort,
      spawn,
      onEvent,
      onHook: (body) => {
        if (runtime.session === session) this.deps.onHook(tabId, body)
      },
      onPromptResolved: (prompt, allowed) => {
        if (runtime.session === session) this.deps.onPromptResolved(tabId, prompt, allowed)
      },
      onExit: (error) => {
        if (runtime.session !== session) return
        this.deps.log(`chatExit tab=${tabId}${error ? ` error=${JSON.stringify(error.slice(0, 300))}` : ''}`)
        this.deps.onProcessChange(tabId, false, error)
      },
      log: this.deps.log
    })
    runtime.session = session
    this.deps.log(`chatStart tab=${tabId} resume=${runtime.hasTranscript} remote=${remote ? 'yes' : 'no'} exe=${executable}`)
    this.deps.onProcessChange(tabId, true)
    try {
      await session.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit(runtime, { t: 'process', state: 'exited', error: `Couldn't start Claude: ${message}` })
      runtime.session = null
      this.deps.onProcessChange(tabId, false, message)
    }
  }

  private emit(runtime: ChatRuntime, event: ChatEvent): void {
    runtime.state = reduceChat(runtime.state, event)
    runtime.seq += 1
    for (const windowId of runtime.attached) {
      this.deps.sendToWindow(windowId, 'chat-event', runtime.tabId, runtime.seq, event)
    }
  }
}
