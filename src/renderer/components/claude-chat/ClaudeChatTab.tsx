import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import type { SshConfig } from '../../../shared/types'
import { classifyNotification, nextAiStatus, type AiNotificationKind, type AiStatusDecision, type AiStatusEvent } from '../../../shared/ai-status'
import type { ChatImage, ChatPromptResponse } from '../../../shared/claude-chat'
import { parseExtraArgs } from '../aiToolTabUtils'
import { ensureHookListeners, hookStatusCallbacks } from '../hookStatusListeners'
import { normalizeBrowserUrl } from '../../browserUrl'
import { attachChat, forgetChat, getChatState, setChatEventHandler, useChatState } from './chatStore'
import Timeline from './Timeline'
import PromptCard from './PromptCards'
import Composer from './Composer'

interface Props {
  tabId: string
  visible: boolean
  sessionId?: string
  pane: 'left' | 'right'
  projectId: string
  taskId: string
  projectDir: string
  sshConfig?: SshConfig
  /** The project's extra Claude CLI args (shared with the terminal tab). */
  extraArgs?: string
}

/**
 * Claude Code as a chat: the same `claude` binary, login, settings and session
 * files as the terminal tab, driven from main through the Agent SDK. This
 * component only draws main's state and sends intents back; the process keeps
 * running while the tab is hidden, like a PTY.
 *
 * Status (the tab dot, the inbox) comes from the same hook events and the same
 * state machine as the terminal tab — main sends the SDK's in-process hooks on
 * the channels the curl hooks use.
 */
export default function ClaudeChatTab({ tabId, visible, sessionId, pane, projectId, taskId, projectDir, sshConfig, extraArgs }: Props): React.ReactElement {
  const { addTab, updateTabSessionId, markTaskInteracted, markTaskEvent, convertClaudeTab } = useApp()
  const statusStore = useTabStatusStore()
  const state = useChatState(tabId)
  const attachedRef = useRef(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [attachError, setAttachError] = useState<string | null>(null)

  const applyStatus = useCallback((event: AiStatusEvent, notificationKind?: AiNotificationKind): AiStatusDecision => {
    const current = statusStore.getStatus(tabId)
    const decision = nextAiStatus(current, event, {
      isHookTab: true,
      visible: visibleRef.current,
      windowFocused: document.hasFocus(),
      notificationKind
    })
    if (decision !== 'keep') statusStore.setStatus(tabId, decision, event)
    return decision
  }, [statusStore, tabId])

  // Status from hooks — identical to the terminal Claude tab.
  useEffect(() => {
    hookStatusCallbacks.set(tabId, {
      onWorking: () => { applyStatus('hook-working') },
      onStopped: () => {
        applyStatus('hook-stopped')
        markTaskEvent(projectId, taskId)
      },
      onNotification: (body) => {
        const decision = applyStatus('hook-notification', classifyNotification(body))
        if (decision === 'attention') markTaskEvent(projectId, taskId, 'attention')
        else if (decision === null) markTaskEvent(projectId, taskId)
      },
      onActivity: (statusEvent) => {
        if (!statusEvent) return
        const decision = applyStatus(statusEvent)
        if (decision === 'attention') markTaskEvent(projectId, taskId, 'attention')
      },
      onSessionStart: (body) => {
        const next = body.session_id
        if (typeof next === 'string' && next && next !== sessionId) updateTabSessionId(projectId, taskId, pane, tabId, next)
      }
    })
    ensureHookListeners()
    setChatEventHandler(tabId, (event) => {
      // A process that died on its own (crash, ssh drop) is the terminal tab's "exited".
      if (event.t === 'process' && event.state === 'exited' && event.error) {
        applyStatus('exit')
        markTaskEvent(projectId, taskId)
      }
      if (event.t === 'process' && event.state === 'starting' && statusStore.getStatus(tabId) === 'exited') {
        statusStore.setStatus(tabId, null, 'chat-restart')
      }
    })
  }, [tabId, projectId, taskId, pane, sessionId, applyStatus, markTaskEvent, updateTabSessionId, statusStore])

  // Attach once the tab is first shown; stay attached while hidden (the process runs on).
  useEffect(() => {
    if (!visible || attachedRef.current || !sessionId) return
    attachedRef.current = true
    setAttachError(null)
    attachChat(tabId, {
      cwd: projectDir,
      sessionId,
      projectId: sshConfig ? projectId : undefined,
      sshConfig,
      extraArgs: parseExtraArgs(extraArgs)
    }).then(() => {
      // A window attaching mid-turn (reload, a second window) learns the status from
      // the snapshot: the hook events that set it went by before it was listening.
      const snapshot = getChatState(tabId)
      if (snapshot.pending.length > 0) applyStatus('hook-needs-input')
      else if (snapshot.busy) applyStatus('hook-working')
    }).catch((err: unknown) => {
      attachedRef.current = false
      setAttachError(err instanceof Error ? err.message : String(err))
    })
  }, [visible, tabId, sessionId, projectDir, projectId, sshConfig, extraArgs, applyStatus])

  useEffect(() => {
    if (visible) applyStatus('visit')
  }, [visible, applyStatus])

  // Closing (or converting) the tab ends its process and forgets this window's copy.
  useEffect(() => {
    const handler = (e: Event): void => {
      if ((e as CustomEvent).detail?.tabId !== tabId) return
      window.api.chatClose(tabId)
      forgetChat(tabId)
      hookStatusCallbacks.delete(tabId)
      statusStore.removeTab(tabId)
      attachedRef.current = false
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId, statusStore])

  // Follow the conversation while you are at the bottom; leave it alone once you scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !visible) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [state.items, state.pending, state.busy, visible])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickRef.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const send = useCallback((text: string, images: ChatImage[]) => {
    markTaskInteracted(projectId, taskId)
    stickRef.current = true
    void window.api.chatSend(tabId, text, images).catch((err: unknown) => {
      setAttachError(err instanceof Error ? err.message : String(err))
    })
  }, [tabId, projectId, taskId, markTaskInteracted])

  const respond = useCallback((promptId: string, response: ChatPromptResponse) => {
    markTaskInteracted(projectId, taskId)
    void window.api.chatRespond(tabId, promptId, response)
  }, [tabId, projectId, taskId, markTaskInteracted])

  const openInTerminal = useCallback(() => {
    convertClaudeTab(projectId, taskId, pane, tabId, 'claude')
  }, [convertClaudeTab, projectId, taskId, pane, tabId])

  const loadFiles = useCallback(
    () => window.api.chatListFiles(projectDir, sshConfig ? projectId : undefined, sshConfig),
    [projectDir, projectId, sshConfig]
  )

  const empty = state.items.length === 0 && !state.busy
  const starting = state.process === 'starting' && state.items.length === 0

  return (
    <div className="absolute inset-0 flex-col bg-bg" style={{ display: visible ? 'flex' : 'none' }}>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto relative">
        <div className="max-w-[860px] mx-auto px-5 pt-4 pb-3">
          {empty ? (
            <div className="pt-[18vh] text-center select-none">
              <div className="text-2xl text-accent mb-2">&#10022;</div>
              <div className="text-md text-text">{starting ? 'Starting Claude…' : 'What should Claude work on?'}</div>
              <div className="text-sm text-text-subtle mt-1 font-mono truncate">{projectDir || sshConfig?.remoteDir || '~'}</div>
            </div>
          ) : (
            <Timeline
              items={state.items}
              busy={state.busy}
              compacting={state.compacting}
              waiting={state.pending.length > 0}
              turnStartedAt={state.turnStartedAt}
              onOpenLink={(url) => addTab(projectId, taskId, pane, 'browser', { url: normalizeBrowserUrl(url) })}
            />
          )}
        </div>
      </div>
      <div className="max-w-[860px] w-full mx-auto px-5 pb-3 flex flex-col gap-2 relative">
        {!atBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute -top-9 left-1/2 -translate-x-1/2 h-6 px-2.5 inline-flex items-center gap-1 rounded-full border-[0.5px] border-border bg-surface-2 text-xs text-text-muted shadow-pop cursor-pointer hover:text-text"
          >
            <ArrowDown size={11} /> Latest
          </button>
        )}
        {attachError && (
          <div className="text-sm text-danger rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-2 py-1">{attachError}</div>
        )}
        {state.pending.map((prompt) => (
          <PromptCard key={prompt.id} prompt={prompt} onRespond={(response) => respond(prompt.id, response)} />
        ))}
        <Composer
          busy={state.busy}
          info={state.info}
          usage={state.usage}
          models={state.models}
          commands={state.commands}
          loadFiles={loadFiles}
          onSend={send}
          onStop={() => { void window.api.chatInterrupt(tabId) }}
          onSetModel={(model) => { void window.api.chatSetModel(tabId, model) }}
          onSetMode={(mode) => { void window.api.chatSetMode(tabId, mode) }}
          onSetEffort={(effort) => { void window.api.chatSetEffort(tabId, effort) }}
          onOpenInTerminal={openInTerminal}
          focusSignal={visible}
        />
      </div>
    </div>
  )
}
