/** OS the renderer runs on: preload `window.api.platform` in the app, else Node's platform. */
export function terminalPastePlatform(): string {
  if (typeof window !== 'undefined') {
    const apiPlatform = window.api?.platform
    if (apiPlatform) return apiPlatform
  }
  if (typeof process !== 'undefined' && process.platform) return process.platform
  return 'darwin'
}

/**
 * Keys that should paste OS clipboard into an xterm pane (not send ^V to the PTY).
 * On macOS the paste modifier is Cmd; Ctrl+V is a real control character there
 * (vim visual-block, readline quoted-insert) and must reach the shell.
 */
export function isTerminalPasteKey(event: KeyboardEvent, platform: string = terminalPastePlatform()): boolean {
  if (event.altKey) return false
  if (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey) return true
  if (event.key !== 'v' && event.key !== 'V') return false
  return platform === 'darwin' ? event.metaKey : event.ctrlKey
}

/** Edit → Paste (Cmd+V on macOS, Ctrl+V elsewhere). Electron also injects that paste; we must not paste again. */
export function isEditMenuPasteKey(event: KeyboardEvent, platform: string = terminalPastePlatform()): boolean {
  if (event.altKey || event.shiftKey) return false
  if (event.key !== 'v' && event.key !== 'V') return false
  return platform === 'darwin' ? event.metaKey : event.ctrlKey
}

export async function readClipboardText(): Promise<string> {
  try {
    const text = await window.api.clipboardReadText()
    if (text) return text
  } catch {
    // Renderer clipboard API needs a user gesture and extra permissions; IPC is preferred.
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    return ''
  }
  return ''
}

export function pasteIntoTerminal(term: { paste(data: string): void }, text: string): void {
  if (!text) return
  term.paste(text)
}

/**
 * xterm key handler: `false` swallows the key so the shell never sees the paste chord.
 * The Edit-menu paste key is left to Electron's Paste menu (otherwise the clipboard is inserted twice).
 * Shift+Insert and Ctrl+Shift+V have no menu role, so we paste ourselves.
 */
export function handleTerminalPasteKey(
  event: KeyboardEvent,
  term: { paste(data: string): void } | undefined,
  platform: string = terminalPastePlatform()
): boolean {
  if (!isTerminalPasteKey(event, platform)) return true
  if (event.type === 'keydown' && term && !isEditMenuPasteKey(event, platform)) {
    void readClipboardText().then((text) => pasteIntoTerminal(term, text))
  }
  return false
}
