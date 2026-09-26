import { useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { pickAgentTarget } from '../../shared/agent-link'
import { paletteEvents } from '../palette/paletteEvents'
import { getAgentRecency } from './agentTabRecency'

/** Window event an agent tab listens for: insert `text` into its input, do not submit. */
export const AGENT_INSERT_EVENT = 'agent-insert'

export interface AgentInsertDetail {
  tabId: string
  text: string
}

export function dispatchAgentInsert(detail: AgentInsertDetail): void {
  window.dispatchEvent(new CustomEvent<AgentInsertDetail>(AGENT_INSERT_EVENT, { detail }))
}

/** Subscribe a tab to inserts addressed to it. Returns the unsubscribe function. */
export function onAgentInsert(tabId: string, handler: (text: string) => void): () => void {
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<AgentInsertDetail>).detail
    if (detail?.tabId === tabId) handler(detail.text)
  }
  window.addEventListener(AGENT_INSERT_EVENT, listener)
  return () => window.removeEventListener(AGENT_INSERT_EVENT, listener)
}

export function showAgentLinkNotice(message: string): void {
  paletteEvents.emit('agent-link-notice', message)
}

/**
 * Returns `(text) => boolean` that sends a link to the task's agent tab: the most
 * recently used one, activated in its pane, which then inserts the text and takes
 * focus. False (with a notice) when the task has no agent tab.
 */
export function useLinkToAgent(projectId: string, taskId: string): (text: string) => boolean {
  const { projects, getTaskViewState, setActiveTab } = useApp()
  return useCallback((text: string): boolean => {
    const task = projects.find(p => p.id === projectId)?.tasks.find(t => t.id === taskId)
    if (!task) return false
    const view = getTaskViewState(task)
    const target = pickAgentTarget({ tabs: task.tabs, activeTab: view.activeTab }, getAgentRecency(taskId))
    if (!target) {
      showAgentLinkNotice('No agent tab in this task. Open Pi, Claude or Codex to link to it.')
      return false
    }
    const pane = task.tabs.left.some(t => t.id === target.id) ? 'left' : 'right'
    setActiveTab(projectId, taskId, pane, target.id)
    // After activation so a tab that mounts or reveals on this render still hears it
    // (receivers also queue until their input exists).
    dispatchAgentInsert({ tabId: target.id, text })
    return true
  }, [projects, getTaskViewState, setActiveTab, projectId, taskId])
}
