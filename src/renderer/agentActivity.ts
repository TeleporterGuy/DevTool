import { useSyncExternalStore } from 'react'
import type { AgentActivity } from '../shared/agent-activity'

/**
 * This window's mirror of main's per-tab agent activity (shared/agent-activity.ts).
 *
 * Unlike tab statuses, which each window derives for the tabs it mounts, activity
 * is computed once in main and pushed to every window: the sidebar and inbox list
 * tasks whose tabs are not mounted here. So this is a plain module store — there
 * is nothing per-window to decide.
 */

let activities: Record<string, AgentActivity> = {}
const listeners = new Set<() => void>()
let connected = false

function notify(): void {
  listeners.forEach((listener) => listener())
}

function connect(): void {
  if (connected) return
  connected = true
  let receivedLive = false
  window.api.onAgentActivity((tabId, activity) => {
    receivedLive = true
    const next = { ...activities }
    if (activity) next[tabId] = activity
    else delete next[tabId]
    activities = next
    notify()
  })
  window.api.getAgentActivity().then((snapshot) => {
    // A live update beats the snapshot for the tabs it touched; merge rather than
    // replace so one that raced ahead of the snapshot is not lost.
    activities = receivedLive ? { ...snapshot, ...activities } : snapshot
    notify()
  }).catch(() => {
    // Older main without the handler: the sidebar just shows status words.
  })
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAllAgentActivity(): Record<string, AgentActivity> {
  return useSyncExternalStore(subscribe, () => activities)
}
