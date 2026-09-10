/** Keys that should paste OS clipboard into an xterm pane (not send ^V to the PTY). */
export function isTerminalPasteKey(event: KeyboardEvent): boolean {
  if (event.altKey) return false
  if (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey) return true
  if (event.key !== 'v' && event.key !== 'V') return false
  return event.ctrlKey || event.metaKey
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
 * xterm key handler: `false` swallows the key so the shell never sees ^V.
 * Clipboard read is async; `term.paste` then goes through `onData` into the PTY.
 */
export function handleTerminalPasteKey(
  event: KeyboardEvent,
  term: { paste(data: string): void } | undefined
): boolean {
  if (!isTerminalPasteKey(event)) return true
  if (event.type === 'keydown' && term) {
    void readClipboardText().then((text) => pasteIntoTerminal(term, text))
  }
  return false
}
