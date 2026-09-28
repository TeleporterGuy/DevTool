import { BrowserWindow } from 'electron'
import type { AppConfig, CleanupActivity, NotesRecord, ProjectsData } from '../../shared/types'
import type { AgentActivity } from '../../shared/agent-activity'
import type { RevisionStore } from '../revision-store'
import type { PaletteFrecencyStorage } from '../palette-frecency-storage'
import type { IpcRegistrar } from './registrar'
import { frecencyFile, notesRecord, projectsData, revisionSave } from './schemas'
import { sanitizeConfigUpdate } from './config-sanitize'
import { v } from './validate'

export interface AppStateDeps {
  projectsStore: RevisionStore<ProjectsData>
  notesStore: RevisionStore<NotesRecord>
  paletteFrecency: PaletteFrecencyStorage
  getAgentActivity: () => Record<string, AgentActivity>
  getCleanupActivity: () => CleanupActivity
  setDirtyTabs: (windowId: number, tabIds: string[]) => void
  backupProjects: () => boolean
  getConfig: () => AppConfig
  /** Merge a validated partial config, persist it and tell every window. */
  applyConfig: (patch: Partial<AppConfig>) => void
  log: (message: string) => void
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Shared persisted state: projects, notes, config, palette frecency and idle-cleanup inputs. */
export function registerAppStateHandlers(ipc: IpcRegistrar, deps: AppStateDeps): void {
  ipc.handle('load-projects', [], () => deps.projectsStore.get())
  ipc.handle('save-projects', [revisionSave(projectsData)], (_event, payload) =>
    deps.projectsStore.save(payload.baseRevision, payload.data))

  // Everything the sweep exempts a task for, as the settings preview needs to show
  // it: what is on screen in any window, what main has heard from the hooks, what
  // still has a process, and what has an unsaved buffer open.
  ipc.handle('get-agent-activity', [], () => deps.getAgentActivity())
  ipc.handle('get-cleanup-activity', [], () => deps.getCleanupActivity())

  // Windows publish their unsaved editors: a background sweep has nobody to show a
  // Save/Discard dialog to, so a dirty buffer keeps its task out of the sweep.
  ipc.handle('report-dirty-tabs', [v.array(v.string())], (event, tabIds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    deps.setDirtyTabs(window.id, tabIds)
    return undefined
  })

  ipc.handle('backup-projects-now', [], () => deps.backupProjects())

  ipc.handle('load-config', [], () => clone(deps.getConfig()))
  ipc.handle('save-config', [v.unknown], (_event, raw) => {
    const { config, droppedKeys, rejectedKeys } = sanitizeConfigUpdate(raw)
    if (droppedKeys.length > 0) deps.log(`saveConfig ignoredKeys=${droppedKeys.join(',')}`)
    // Unsaved, and not merged: the stored value (or the default loadConfig filled in) stays.
    for (const { key, reason } of rejectedKeys) deps.log(`saveConfig rejectedKey=${key} reason=${reason}`)
    deps.applyConfig(config)
    return undefined
  })

  ipc.handle('notes-load', [], () => deps.notesStore.get())
  ipc.handle('notes-save', [revisionSave(notesRecord)], (_event, payload) =>
    deps.notesStore.save(payload.baseRevision, payload.data))

  ipc.handle('palette-frecency:load', [], () => deps.paletteFrecency.load())
  ipc.handle('palette-frecency:save', [frecencyFile], (_event, file) => deps.paletteFrecency.save(file))
}
