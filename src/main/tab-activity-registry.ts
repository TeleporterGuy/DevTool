import { classifyNotification, nextAiStatus, type AiStatusEvent } from '../shared/ai-status'
import { reduceAgentActivity, type ActivityUpdate, type AgentActivity } from '../shared/agent-activity'
import type { TabStatusValue } from '../shared/types'

/**
 * Main's copy of "what is this tab's process doing right now".
 *
 * A window's `TabStatusContext` is per-window by construction, so it is blind to a
 * task running in another window — and idle cleanup deleting a live agent because
 * the sweeping window could not see it is finding #7. Main receives every hook
 * event and owns every PTY, so this is the only complete picture there is.
 *
 * The transitions come from `shared/ai-status.ts`, the same state machine
 * `AiToolTab` drives, so the two cannot disagree about what "working" means.
 * Only hook and process events feed it: the renderer-only heuristics (terminal
 * bell, PTY-quiet) have no equivalent here, which is why the sweep also treats a
 * live PTY as protection rather than trusting statuses alone.
 */
export class TabActivityRegistry {
  private readonly statuses = new Map<string, TabStatusValue>()
  private readonly since = new Map<string, number>()
  /** The "what is it doing" side (shared/agent-activity.ts), fed by every Claude hook body. */
  private readonly activities = new Map<string, AgentActivity>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Claude's UserPromptSubmit / pi's agent_start. */
  working(tabId: string): void {
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-working', this.context()))
  }

  /** Claude's Stop hook — authoritative "the agent is done". */
  stopped(tabId: string): void {
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-stopped', this.context()))
  }

  /**
   * Claude's Notification hook / pi's agent_end. The renderer suppresses the idle
   * nudge while you are looking at the tab; main has no window to ask, so it takes
   * the protective reading — and a tab you are actually looking at belongs to a
   * task the open-in-any-window safeguard already exempts.
   */
  notification(tabId: string, body?: Record<string, unknown>): void {
    const notificationKind = classifyNotification(body)
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-notification', this.context(notificationKind)))
  }

  /**
   * A status event implied by an `activity` hook (permission dialog, question,
   * API failure, answered prompt) — see `reduceAgentActivity`.
   */
  statusEvent(tabId: string, event: AiStatusEvent): void {
    this.apply(tabId, (current) => nextAiStatus(current, event, this.context()))
  }

  /**
   * Fold a hook body into the tab's activity. Returns null when nothing changed,
   * so callers only broadcast real updates.
   */
  applyHook(tabId: string, body: Record<string, unknown> | undefined): ActivityUpdate | null {
    const prev = this.activities.get(tabId)
    const update = reduceAgentActivity(prev, body, this.now())
    if (!update.changed) return null
    this.activities.set(tabId, update.activity)
    return update
  }

  getActivity(tabId: string): AgentActivity | null {
    return this.activities.get(tabId) ?? null
  }

  getActivitySnapshot(): Record<string, AgentActivity> {
    return Object.fromEntries(this.activities)
  }

  /** A session started in this tab: it exists, but nothing is claimed about its status. */
  touch(tabId: string): void {
    if (this.statuses.has(tabId)) return
    this.statuses.set(tabId, null)
    this.since.set(tabId, this.now())
  }

  /** The PTY exited. Terminal until the tab respawns — and not a protective status. */
  exited(tabId: string): void {
    this.apply(tabId, (current) => nextAiStatus(current, 'exit', this.context()))
    this.endTurn(tabId)
  }

  /** A fresh process for the same tab id — the old status describes a dead one. */
  reset(tabId: string): void {
    this.statuses.set(tabId, null)
    this.since.set(tabId, this.now())
    this.endTurn(tabId)
  }

  /**
   * Keep what the conversation was about (a resume continues it); drop anything
   * that described the dead process's in-flight turn.
   */
  private endTurn(tabId: string): void {
    const activity = this.activities.get(tabId)
    if (!activity) return
    this.activities.set(tabId, {
      ...activity,
      tool: undefined,
      waiting: undefined,
      subagents: 0,
      compacting: false,
      turnStartedAt: undefined,
      updatedAt: this.now()
    })
  }

  /** The tab is gone (removed, or its task deleted). */
  remove(tabId: string): void {
    this.statuses.delete(tabId)
    this.since.delete(tabId)
    this.activities.delete(tabId)
  }

  getStatus(tabId: string): TabStatusValue {
    return this.statuses.get(tabId) ?? null
  }

  getSnapshot(): Record<string, TabStatusValue> {
    return Object.fromEntries(this.statuses)
  }

  getSinceSnapshot(): Record<string, number> {
    return Object.fromEntries(this.since)
  }

  private context(notificationKind?: ReturnType<typeof classifyNotification>) {
    // No window context to consult: `visible`/`windowFocused` are the renderer's
    // suppression inputs, and main deliberately never suppresses.
    return { isHookTab: true, visible: false, windowFocused: false, notificationKind }
  }

  private apply(tabId: string, decide: (current: TabStatusValue) => TabStatusValue | 'keep'): void {
    const current = this.statuses.get(tabId) ?? null
    const decision = decide(current)
    if (decision === 'keep') {
      this.touch(tabId)
      return
    }
    if (this.statuses.has(tabId) && current === decision) return
    this.statuses.set(tabId, decision)
    this.since.set(tabId, this.now())
  }
}
