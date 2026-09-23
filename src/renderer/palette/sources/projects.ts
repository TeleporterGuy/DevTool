// src/renderer/palette/sources/projects.ts
import type { AppActions } from '../../hooks/useAppState'
import type { PaletteEntity } from '../types'
import { isEphemeralProject } from '../../../shared/types'

export function projectsToEntities(actions: AppActions): PaletteEntity[] {
  // Ad-hoc projects are an implementation detail of "task in a directory" —
  // their tasks are searchable, the container isn't.
  return actions.projects.filter(p => !isEphemeralProject(p)).map(p => ({
    kind: 'project' as const,
    id: `project:${p.id}`,
    title: p.name,
    subtitle: p.emoji ?? undefined,
    searchable: p.name
  }))
}
