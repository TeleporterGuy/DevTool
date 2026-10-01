/** The chat tab's `/permissions`: what main reads from Claude's settings files. */

export type PermissionSourceKind = 'localSettings' | 'projectSettings' | 'userSettings'

export const PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny'] as const
export type PermissionBehavior = typeof PERMISSION_BEHAVIORS[number]

export interface PermissionSettingsSource {
  kind: PermissionSourceKind
  /** The settings file, absolute. */
  path: string
  exists: boolean
  allow: string[]
  ask: string[]
  deny: string[]
  defaultMode?: string
  /** It exists but couldn't be read or parsed; it is not edited. */
  error?: string
}

export const PERMISSION_SOURCE_LABELS: Record<PermissionSourceKind, { title: string; hint: string }> = {
  localSettings: { title: 'This project, only you', hint: '.claude/settings.local.json (not committed)' },
  projectSettings: { title: 'This project, shared', hint: '.claude/settings.json (committed)' },
  userSettings: { title: 'All your projects', hint: '~/.claude/settings.json' }
}
