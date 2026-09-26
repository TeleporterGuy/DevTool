import React from 'react'
import { ChevronRight } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { isEphemeralProject, isRemoteProject, isShellCommandProject } from '../../../shared/types'
import type { PinnedItem, Task } from '../../../shared/types'
import { useMenuPosition } from '../../hooks/useMenuPosition'
import { isSettled, isSnoozed, isUnread, snoozePresets } from '../inbox'
import { menuCls, menuItemCls } from '../ui'
import type { SidebarContextMenuState } from './SidebarParts'

/**
 * The right-click menu for a project or task row, and the snooze presets that
 * replace its body rather than fly out sideways — a nested flyout would run off
 * the edge of a 240px sidebar.
 */
export default function SidebarContextMenu({
  contextMenu,
  snoozeSubmenu,
  setSnoozeSubmenu,
  closeContextMenu,
  setContextMenu,
  findTask,
  handleToggleSettled,
  handleDeleteTask,
  beginEdit,
  isPinned,
  setDuplicateProjectId,
  setProjectSettingsId
}: {
  contextMenu: SidebarContextMenuState | null
  snoozeSubmenu: boolean
  setSnoozeSubmenu: (open: boolean) => void
  /** Closes the menu and resets the snooze page. */
  closeContextMenu: () => void
  setContextMenu: (menu: null) => void
  findTask: (projectId: string, taskId: string) => Task | undefined
  handleToggleSettled: (projectId: string, taskId: string) => void
  handleDeleteTask: (projectId: string, taskId: string) => void
  beginEdit: (id: string, name: string, projectId?: string) => void
  isPinned: (item: PinnedItem) => boolean
  setDuplicateProjectId: (projectId: string) => void
  setProjectSettingsId: (projectId: string) => void
}): React.ReactElement {
  const {
    projects, togglePinnedItem, updateProject, setProjectExpanded, connectSsh, removeProject,
    snoozeTask, unsnoozeTask, markTaskUnread, markTaskVisited
  } = useApp()
  // Keeps the popup inside the window — a right-click near the bottom of the
  // sidebar would otherwise render items below the edge, unreachable.
  const contextMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
  const snoozeMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)

  return (
    <>
      {contextMenu && snoozeSubmenu && contextMenu.type === 'task' && (
        <div ref={snoozeMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={snoozeMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          {snoozePresets(Date.now()).map(preset => (
            <button
              key={preset.id}
              className={`${menuItemCls} flex items-center gap-6 justify-between`}
              onClick={() => {
                snoozeTask(contextMenu.projectId, contextMenu.taskId!, {
                  until: preset.until,
                  untilAttention: preset.untilAttention
                })
                closeContextMenu()
              }}
            >
              <span>{preset.label}</span>
              {preset.hint && <span className="text-text-subtle text-xs tabular-nums">{preset.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {contextMenu && !snoozeSubmenu && (
        <div ref={contextMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={contextMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          <>
            {contextMenu.type === 'task' && (() => {
              const task = findTask(contextMenu.projectId, contextMenu.taskId!)
              if (!task) return null
              const settled = isSettled(task)
              const snoozed = isSnoozed(task, Date.now())
              return (
                <div className="border-b border-hair pb-1 mb-1">
                  <button className={menuItemCls} onClick={() => {
                    handleToggleSettled(contextMenu.projectId, contextMenu.taskId!)
                    closeContextMenu()
                  }}>{settled ? 'Unsettle' : 'Settle'}</button>
                  {snoozed ? (
                    <button className={menuItemCls} onClick={() => {
                      unsnoozeTask(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Wake now</button>
                  ) : (
                    <button
                      className={`${menuItemCls} flex items-center gap-6 justify-between`}
                      onClick={() => setSnoozeSubmenu(true)}
                    >
                      <span>Snooze</span>
                      <ChevronRight size={11} className="text-text-subtle" />
                    </button>
                  )}
                  {isUnread(task) ? (
                    <button className={menuItemCls} onClick={() => {
                      markTaskVisited(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark read</button>
                  ) : (
                    <button className={menuItemCls} onClick={() => {
                      markTaskUnread(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark unread</button>
                  )}
                </div>
              )
            })()}
            <button className={menuItemCls} onClick={() => {
                const id = contextMenu.type === 'project' ? contextMenu.projectId : contextMenu.taskId!
                const item = contextMenu.type === 'project'
                  ? projects.find((p) => p.id === id)
                  : projects.find((p) => p.id === contextMenu.projectId)?.tasks.find((t) => t.id === id)
                beginEdit(id, item?.name ?? '', contextMenu.type === 'task' ? contextMenu.projectId : undefined)
                setContextMenu(null)
              }}>Rename</button>
              {(() => {
                const item: PinnedItem = contextMenu.type === 'project'
                  ? { type: 'project', projectId: contextMenu.projectId }
                  : { type: 'task', projectId: contextMenu.projectId, taskId: contextMenu.taskId! }
                const pinned = isPinned(item)
                const noun = contextMenu.type === 'project' ? 'project' : 'task'
                return (
                  <button className={menuItemCls} onClick={() => {
                    togglePinnedItem(item)
                    setContextMenu(null)
                  }}>{pinned ? `Unpin ${noun}` : `Pin ${noun}`}</button>
                )
              })()}
              {/* Promote the hidden project a "task in a directory" is filed under:
                  clearing the flag is all it takes for the tree to show it. */}
              {contextMenu.type === 'task' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isEphemeralProject(project)) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    updateProject(project.id, { ephemeral: undefined })
                    setProjectExpanded(project.id, true)
                    setContextMenu(null)
                  }}>Save as project</button>
                )
              })()}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setDuplicateProjectId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Duplicate</button>
              )}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setProjectSettingsId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Settings</button>
              )}
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isRemoteProject(project)) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    connectSsh(project.id, project.ssh!).catch(() => {})
                    setContextMenu(null)
                  }}>Reconnect SSH</button>
                )
              })()}
              <button className={`${menuItemCls} text-danger`} onClick={() => {
                if (contextMenu.type === 'project') removeProject(contextMenu.projectId)
                else handleDeleteTask(contextMenu.projectId, contextMenu.taskId!)
                setContextMenu(null)
              }}>Delete</button>
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project) return null
                const details: { label: string; value: string }[] = []
                if (isShellCommandProject(project)) {
                  details.push({ label: 'Command', value: project.shellCommand!.command })
                } else if (isRemoteProject(project)) {
                  details.push({ label: 'Connection', value: `${project.ssh!.username}@${project.ssh!.host}:${project.ssh!.port}` })
                  details.push({ label: 'Dir', value: project.ssh!.remoteDir || '(remote home)' })
                } else {
                  details.push({ label: 'Dir', value: project.directory })
                }
                return (
                  <div className="border-t border-hair mt-1 px-2.5 pt-1.5 pb-1">
                    {details.map(d => (
                      <div key={d.label} className="text-text-subtle text-xs leading-snug overflow-hidden text-ellipsis whitespace-nowrap max-w-[260px] select-text cursor-text" title={d.value}>
                        <span className="opacity-70">{d.label}:</span> {d.value}
                      </div>
                    ))}
                  </div>
                )
              })()}
          </>
        </div>
      )}
    </>
  )
}
