/**
 * Mouse-driven drag-and-drop for the sidebar: reordering projects and tasks in
 * the tree, and reordering the pinned list. Plain mousedown/mousemove rather
 * than HTML5 DnD so a click that never passes the threshold stays a click.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { PinnedItem } from '../../../shared/types'
import { getReorderInsertIndex, getTaskDropIndex } from '../sidebarDrag'
import type { DragState, DropTarget } from './SidebarParts'

const DRAG_THRESHOLD = 5

export function useSidebarTreeDrag({
  editingId,
  projectOrder,
  treeProjectIds,
  reorderTasks,
  reorderProjects
}: {
  /** No drag starts while a row is being renamed. */
  editingId: string | null
  projectOrder: string[]
  /** The project ids the tree actually shows, in order. */
  treeProjectIds: string[]
  reorderTasks: (projectId: string, fromIndex: number, toIndex: number) => void
  reorderProjects: (fromIndex: number, toIndex: number) => void
}): {
  dragState: DragState | null
  dropTarget: DropTarget
  handleDragMouseDown: (e: React.MouseEvent, type: 'project' | 'task', id: string, index: number, projectId?: string) => void
} {
  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const dropTargetRef = useRef<DropTarget>(null)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    dropTargetRef.current = dropTarget
  }, [dropTarget])

  const handleDragMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'project' | 'task',
    id: string,
    index: number,
    projectId?: string
  ) => {
    if (e.button !== 0 || editingId) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        const nextDragState: DragState = { type, id, index, projectId }
        dragStateRef.current = nextDragState
        setDragState(nextDragState)
      }

      const sidebarList = document.querySelector('.sidebar-list')
      if (!sidebarList) return

      if (type === 'task' && projectId) {
        const items = sidebarList.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-id="${projectId}"] .task-item`
        )
        const bestIndex = getTaskDropIndex(
          Array.from(items).map((item) => {
            const rect = item.getBoundingClientRect()
            return {
              id: item.dataset.taskId ?? '',
              index: Number(item.dataset.taskIndex ?? '-1'),
              top: rect.top,
              height: rect.height
            }
          }),
          ev.clientY,
          id
        )
        const nextDropTarget: DropTarget = { type: 'between-tasks', projectId, index: bestIndex }
        dropTargetRef.current = nextDropTarget
        setDropTarget(nextDropTarget)
        return
      }

      const projectItems = sidebarList.querySelectorAll<HTMLElement>('[data-drag-type="project"]')
      let newTarget: DropTarget = null

      for (let i = 0; i < projectItems.length; i++) {
        const item = projectItems[i]
        const rect = item.getBoundingClientRect()
        if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue

        const itemId = item.dataset.dragId!
        const listIdx = treeProjectIds.indexOf(itemId)
        if (listIdx < 0) break
        const midY = rect.top + rect.height / 2
        const insertIdx = ev.clientY > midY ? listIdx + 1 : listIdx
        newTarget = { type: 'between-projects', index: insertIdx }
        break
      }

      if (!newTarget) {
        newTarget = { type: 'between-projects', index: treeProjectIds.length }
      }

      dropTargetRef.current = newTarget
      setDropTarget(newTarget)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (!dragging) return

      const currentDragState = dragStateRef.current
      const currentDropTarget = dropTargetRef.current

      if (currentDragState && currentDropTarget) {
        if (currentDragState.type === 'task' && currentDragState.projectId && currentDropTarget.type === 'between-tasks') {
          const toIndex = getReorderInsertIndex(currentDragState.index, currentDropTarget.index)
          if (toIndex !== null) {
            reorderTasks(currentDragState.projectId, currentDragState.index, toIndex)
          }
        } else if (currentDragState.type === 'project' && currentDropTarget.type === 'between-projects') {
          const fromIdx = projectOrder.indexOf(currentDragState.id)
          const orderDropIndex = currentDropTarget.index >= treeProjectIds.length
            ? projectOrder.length
            : projectOrder.indexOf(treeProjectIds[currentDropTarget.index] ?? '')
          if (orderDropIndex >= 0) {
            const toIdx = getReorderInsertIndex(fromIdx, orderDropIndex)
            if (toIdx !== null) {
              reorderProjects(fromIdx, toIdx)
            }
          }
        }
      }

      dragStateRef.current = null
      dropTargetRef.current = null
      setDragState(null)
      setDropTarget(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, projectOrder, treeProjectIds, reorderTasks, reorderProjects])

  return { dragState, dropTarget, handleDragMouseDown }
}

export function usePinnedDrag<P extends { item: PinnedItem }>(
  resolvedPins: P[],
  setPinnedOrder: (items: PinnedItem[]) => void
): {
  pinDragIndex: number | null
  pinDropIndex: number | null
  handlePinMouseDown: (e: React.MouseEvent, key: string, index: number) => void
} {
  const [pinDragIndex, setPinDragIndex] = useState<number | null>(null)
  const [pinDropIndex, setPinDropIndex] = useState<number | null>(null)
  const pinDropIndexRef = useRef<number | null>(null)

  const handlePinMouseDown = useCallback((e: React.MouseEvent, key: string, index: number) => {
    if (e.button !== 0) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        setPinDragIndex(index)
      }
      const list = document.querySelector('.sidebar-pinned-list')
      if (!list) return
      const items = list.querySelectorAll<HTMLElement>('[data-pin-key]')
      const bestIndex = getTaskDropIndex(
        Array.from(items).map((item) => {
          const rect = item.getBoundingClientRect()
          return {
            id: item.dataset.pinKey ?? '',
            index: Number(item.dataset.pinIndex ?? '-1'),
            top: rect.top,
            height: rect.height
          }
        }),
        ev.clientY,
        key
      )
      pinDropIndexRef.current = bestIndex
      setPinDropIndex(bestIndex)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        const dropIndex = pinDropIndexRef.current
        if (dropIndex !== null) {
          const toIndex = getReorderInsertIndex(index, dropIndex)
          if (toIndex !== null) {
            const next = resolvedPins.map(pin => pin.item)
            const [moved] = next.splice(index, 1)
            next.splice(toIndex, 0, moved)
            setPinnedOrder(next)
          }
        }
      }
      pinDropIndexRef.current = null
      setPinDragIndex(null)
      setPinDropIndex(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [resolvedPins, setPinnedOrder])

  return { pinDragIndex, pinDropIndex, handlePinMouseDown }
}
