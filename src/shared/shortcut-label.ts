/**
 * Turn an Electron-style accelerator into a label people already know.
 *
 * macOS stays compact glyphs (⌘W). Windows and Linux use plus-separated
 * names (Ctrl+W), matching the native Electron menu.
 *
 * This is display only. It does not bind keys.
 */

export type ShortcutPlatform = NodeJS.Platform | string

type Mods = {
  cmdOrCtrl: boolean
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

const MODIFIERS = new Set([
  'commandorcontrol',
  'cmdorctrl',
  'command',
  'cmd',
  'control',
  'ctrl',
  'alt',
  'option',
  'shift',
  'super',
  'meta'
])

function parseAccelerator(accelerator: string): Mods {
  const mods: Mods = {
    cmdOrCtrl: false,
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: ''
  }

  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean)
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (!MODIFIERS.has(lower)) {
      mods.key = part
      continue
    }
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') mods.cmdOrCtrl = true
    else if (lower === 'command' || lower === 'cmd') mods.cmd = true
    else if (lower === 'control' || lower === 'ctrl') mods.ctrl = true
    else if (lower === 'alt' || lower === 'option') mods.alt = true
    else if (lower === 'shift') mods.shift = true
  }

  return mods
}

function displayKey(key: string): string {
  if (key.toLowerCase() === 'plus') return '+'
  if (key.length === 1) return key.toUpperCase() === key.toLowerCase() ? key : key.toUpperCase()
  return key
}

function isDarwin(platform: ShortcutPlatform): boolean {
  return platform === 'darwin'
}

/**
 * Format an Electron accelerator for a given OS.
 *
 * @example formatShortcut('CmdOrCtrl+Shift+T', 'win32') // 'Ctrl+Shift+T'
 * @example formatShortcut('CmdOrCtrl+Alt+I', 'darwin') // '⌘⌥I'
 */
export function formatShortcut(accelerator: string, platform: ShortcutPlatform): string {
  const parsed = parseAccelerator(accelerator)
  const key = displayKey(parsed.key)
  const cmd = parsed.cmd || (parsed.cmdOrCtrl && isDarwin(platform))
  const ctrl = parsed.ctrl || (parsed.cmdOrCtrl && !isDarwin(platform))

  if (isDarwin(platform)) {
    let out = ''
    if (ctrl && !cmd) out += '⌃'
    if (cmd) out += '⌘'
    if (parsed.shift) out += '⇧'
    if (parsed.alt) out += '⌥'
    if (ctrl && cmd) out += '⌃'
    return `${out}${key}`
  }

  const parts: string[] = []
  if (cmd || ctrl) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  if (key) parts.push(key)
  return parts.join('+')
}

/** OS for labels: preload `window.api.platform` in the app, else Node's platform. */
export function shortcutPlatform(): ShortcutPlatform {
  if (typeof window !== 'undefined') {
    const apiPlatform = window.api?.platform
    if (apiPlatform) return apiPlatform
  }
  if (typeof process !== 'undefined' && process.platform) return process.platform
  return 'darwin'
}

/** Same as formatShortcut, using the running app's platform. */
export function formatShortcutForApp(accelerator: string): string {
  return formatShortcut(accelerator, shortcutPlatform())
}
