/**
 * Pure transitions of the notes record and of the note tabs that point into it.
 * The record updaters are replayed onto another window's canonical state after a
 * compare-and-swap conflict, so each one is written to be idempotent: a replayed
 * create does not add twice, and an edit to a note someone else deleted is
 * dropped rather than resurrecting it.
 */
import type { NotesRecord, ProjectNote, Project, ProjectsData, Tab } from '../../../shared/types'

export function addNoteToRecord(prev: NotesRecord, projectId: string, note: ProjectNote): NotesRecord {
  const existing = prev[projectId] ?? []
  // A replay of this create must not add the note a second time.
  if (existing.some(n => n.id === note.id)) return prev
  return { ...prev, [projectId]: [...existing, note] }
}

/** Patch one note. A note that is gone (another window deleted it) stays gone. */
export function patchNoteInRecord(
  prev: NotesRecord,
  projectId: string,
  noteId: string,
  patch: Partial<Omit<ProjectNote, 'id'>>
): NotesRecord {
  const existing = prev[projectId]
  if (!existing?.some(n => n.id === noteId)) return prev
  return {
    ...prev,
    [projectId]: existing.map(n => (n.id === noteId ? { ...n, ...patch } : n))
  }
}

export function deleteNoteFromRecord(prev: NotesRecord, projectId: string, noteId: string): NotesRecord {
  const existing = prev[projectId]
  if (!existing?.some(n => n.id === noteId)) return prev
  return { ...prev, [projectId]: existing.filter(n => n.id !== noteId) }
}

export function isNoteTab(tab: Tab, noteId: string): boolean {
  return tab.type === 'note' && tab.noteId === noteId
}

/** Every tab in the project that shows `noteId`. */
export function noteTabIds(project: Project, noteId: string): string[] {
  const ids: string[] = []
  for (const task of project.tasks) {
    for (const tab of [...task.tabs.left, ...task.tabs.right]) {
      if (isNoteTab(tab, noteId)) ids.push(tab.id)
    }
  }
  return ids
}

/** Keep the note's tabs titled after the note. */
export function retitleNoteTabs(data: ProjectsData, projectId: string, noteId: string, name: string): ProjectsData {
  return {
    ...data,
    projects: data.projects.map(project =>
      project.id !== projectId ? project : {
        ...project,
        tasks: project.tasks.map(task => ({
          ...task,
          tabs: {
            left: task.tabs.left.map(tab => (isNoteTab(tab, noteId) ? { ...tab, title: name } : tab)),
            right: task.tabs.right.map(tab => (isNoteTab(tab, noteId) ? { ...tab, title: name } : tab))
          }
        }))
      }
    )
  }
}

export function removeNoteTabs(data: ProjectsData, projectId: string, noteId: string): ProjectsData {
  return {
    ...data,
    projects: data.projects.map(p =>
      p.id !== projectId ? p : {
        ...p,
        tasks: p.tasks.map(task => ({
          ...task,
          tabs: {
            left: task.tabs.left.filter(tab => !isNoteTab(tab, noteId)),
            right: task.tabs.right.filter(tab => !isNoteTab(tab, noteId))
          }
        }))
      }
    )
  }
}
