/**
 * Which agent tab of a task was used last, newest first, so Ctrl+L links go to
 * the agent the user was just talking to. Per window and in memory only: after a
 * restart the pane's active agent tab is a good enough fallback.
 */
const recencyByTask = new Map<string, string[]>()

export function noteAgentTabFocused(taskId: string, tabId: string): void {
  const list = recencyByTask.get(taskId) ?? []
  recencyByTask.set(taskId, [tabId, ...list.filter(id => id !== tabId)])
}

export function getAgentRecency(taskId: string): readonly string[] {
  return recencyByTask.get(taskId) ?? []
}

export function forgetAgentTab(tabId: string): void {
  for (const [taskId, list] of recencyByTask) {
    if (list.includes(tabId)) recencyByTask.set(taskId, list.filter(id => id !== tabId))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('tab-removed', (e: Event) => {
    const tabId = (e as CustomEvent<{ tabId?: string }>).detail?.tabId
    if (tabId) forgetAgentTab(tabId)
  })
}
