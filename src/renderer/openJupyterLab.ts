import { isHomeTask, isRemoteProject, isShellCommandProject, type Project, type Tab, type Task } from '../shared/types'
import { JUPYTER_ERRORS, JUPYTER_LAB_TITLE, isSameJupyterOrigin, persistableBrowserUrl } from '../shared/jupyter'
import { requestBrowserTabNavigate } from './browserNavigate'
import { localProjectFolder } from '../shared/external-editors'
import type { AppActions } from './hooks/useAppState'

/** Prefer the selected task; otherwise the most recently touched non-home task. */
export function pickJupyterTask(project: Project, selectedTaskId: string | null | undefined): Task | null {
  const selected = project.tasks.find((task) => task.id === selectedTaskId)
  if (selected && !isHomeTask(selected)) return selected
  const visible = project.tasks.filter((task) => !isHomeTask(task))
  visible.sort((a, b) => (b.lastInteractedAt ?? 0) - (a.lastInteractedAt ?? 0))
  return visible[0] ?? null
}

/** A browser tab already pointed at this project's JupyterLab server. */
export function findJupyterBrowserTab(
  task: Task,
  serverUrl: string
): { pane: 'left' | 'right'; tab: Tab } | null {
  for (const pane of ['left', 'right'] as const) {
    for (const tab of task.tabs[pane]) {
      if (tab.type === 'browser' && tab.url && isSameJupyterOrigin(tab.url, serverUrl)) {
        return { pane, tab }
      }
    }
  }
  return null
}

/**
 * Start (or reuse) JupyterLab in main, then open the in-app browser tab.
 * Returns an error string, or null on success.
 */
export async function openJupyterLabForProject(
  actions: AppActions,
  projectId?: string | null
): Promise<string | null> {
  const id = projectId ?? actions.selectedProjectId
  if (!id) return JUPYTER_ERRORS.noProject
  const project = actions.projects.find((item) => item.id === id)
  if (!project) return JUPYTER_ERRORS.noProject
  if (isRemoteProject(project) || isShellCommandProject(project)) {
    return JUPYTER_ERRORS.notLocal
  }

  const selectedTaskId = id === actions.selectedProjectId ? actions.selectedTaskId : null
  const task = pickJupyterTask(project, selectedTaskId)
  if (!task) return JUPYTER_ERRORS.noTask

  const cwd = localProjectFolder(project, task) ?? project.directory?.trim() ?? ''
  if (!cwd) return JUPYTER_ERRORS.noFolder

  const result = await window.api.jupyterOpen(id, cwd)
  if (!result.ok) return result.error

  actions.switchToTask(id, task.id)

  const persistUrl = persistableBrowserUrl(result.url)
  const found = findJupyterBrowserTab(task, result.url)
  if (found) {
    actions.setActiveTab(id, task.id, found.pane, found.tab.id)
    actions.updateTabUrl(id, task.id, found.pane, found.tab.id, persistUrl)
    requestBrowserTabNavigate(found.tab.id, result.url)
    return null
  }

  const tab = actions.addTab(id, task.id, 'left', 'browser', { url: persistUrl, title: JUPYTER_LAB_TITLE })
  requestBrowserTabNavigate(tab.id, result.url)
  return null
}
