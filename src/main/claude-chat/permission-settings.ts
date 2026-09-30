import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  PERMISSION_BEHAVIORS,
  type PermissionBehavior,
  type PermissionSettingsSource,
  type PermissionSourceKind
} from '../../shared/chat-permissions'

/**
 * `/permissions` for chat tabs: the allow / ask / deny rules in the three settings
 * files Claude reads for a project. The CLI watches these files, so a running
 * session picks up an edit without a restart. Only `permissions.<behavior>` is
 * touched; everything else in the file (DevTool's own hooks in the local file,
 * env, the user's other settings) is written back as it was.
 */

export function settingsPath(kind: PermissionSourceKind, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  switch (kind) {
    case 'userSettings':
      return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
    case 'projectSettings':
      return path.join(cwd, '.claude', 'settings.json')
    case 'localSettings':
      return path.join(cwd, '.claude', 'settings.local.json')
  }
}

const KINDS: PermissionSourceKind[] = ['localSettings', 'projectSettings', 'userSettings']

function rulesOf(permissions: Record<string, unknown>, behavior: PermissionBehavior): string[] {
  const list = permissions[behavior]
  return Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string') : []
}

async function readJson(file: string): Promise<{ exists: boolean; data: Record<string, unknown> }> {
  let raw: string
  try {
    raw = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, data: {} }
    throw err
  }
  if (!raw.trim()) return { exists: true, data: {} }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
  return { exists: true, data: parsed as Record<string, unknown> }
}

export async function readPermissionSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<PermissionSettingsSource[]> {
  return Promise.all(KINDS.map(async (kind): Promise<PermissionSettingsSource> => {
    const file = settingsPath(kind, cwd, env)
    const empty = { kind, path: file, exists: false, allow: [], ask: [], deny: [] }
    try {
      const { exists, data } = await readJson(file)
      const permissions = data.permissions && typeof data.permissions === 'object' ? data.permissions as Record<string, unknown> : {}
      const defaultMode = typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined
      return {
        kind,
        path: file,
        exists,
        allow: rulesOf(permissions, 'allow'),
        ask: rulesOf(permissions, 'ask'),
        deny: rulesOf(permissions, 'deny'),
        ...(defaultMode ? { defaultMode } : {})
      }
    } catch (err) {
      return { ...empty, exists: true, error: `Couldn't read it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }))
}

/**
 * Add or remove one rule. A file that doesn't parse is left alone rather than
 * rewritten, so a hand edit in progress is never clobbered.
 */
export async function updatePermissionRule(
  cwd: string,
  kind: PermissionSourceKind,
  behavior: PermissionBehavior,
  rule: string,
  action: 'add' | 'remove',
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!PERMISSION_BEHAVIORS.includes(behavior)) throw new Error(`Unknown rule list: ${behavior}`)
  const trimmed = rule.trim()
  if (!trimmed) throw new Error('The rule is empty.')
  const file = settingsPath(kind, cwd, env)
  const { exists, data } = await readJson(file)
  if (!exists && action === 'remove') return
  const permissions = data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
    ? { ...data.permissions as Record<string, unknown> }
    : {}
  const current = rulesOf(permissions, behavior)
  const next = action === 'add'
    ? (current.includes(trimmed) ? current : [...current, trimmed])
    : current.filter((existing) => existing !== trimmed)
  if (next.length === current.length && next.every((value, index) => value === current[index])) return
  if (next.length > 0) permissions[behavior] = next
  else delete permissions[behavior]
  const out = { ...data }
  if (Object.keys(permissions).length > 0) out.permissions = permissions
  else delete out.permissions
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  // Write beside the real file and rename, so the CLI's watcher never sees a
  // half-written one and a symlinked settings file (dotfiles) stays a symlink.
  const target = exists ? await fs.promises.realpath(file) : file
  const temp = `${target}.${process.pid}.tmp`
  await fs.promises.writeFile(temp, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  await fs.promises.rename(temp, target)
}
