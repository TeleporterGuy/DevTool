/**
 * window.error in this renderer replaces the whole React tree with a crash
 * screen. Some browser/Electron events are noise (especially with several
 * Monaco editors whose containers move in the DOM).
 */
export function isIgnorableRendererError(error: unknown, message?: string): boolean {
  const parts = [
    message,
    error instanceof Error ? `${error.name} ${error.message}` : '',
    typeof error === 'string' ? error : ''
  ]
  const text = parts.join(' ')
  return /ResizeObserver loop/i.test(text)
}
