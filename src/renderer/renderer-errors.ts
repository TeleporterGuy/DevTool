/**
 * window.error in this renderer used to replace the whole React tree with a
 * crash screen. That unmounts AppProvider; a remount can run with
 * window.api undefined and then throw in useAppState effects.
 *
 * Monaco / ResizeObserver fire a lot of that noise when notebook cells move.
 */

function collectErrorText(error: unknown, message?: string): string {
  const chunks: string[] = []
  if (message) chunks.push(message)
  if (error instanceof Error) {
    chunks.push(error.name, error.message, error.stack ?? '')
    return chunks.join(' ')
  }
  if (typeof error === 'string') {
    chunks.push(error)
    return chunks.join(' ')
  }
  if (error && typeof error === 'object') {
    const rec = error as { name?: unknown; message?: unknown; stack?: unknown }
    if (typeof rec.name === 'string') chunks.push(rec.name)
    if (typeof rec.message === 'string') chunks.push(rec.message)
    if (typeof rec.stack === 'string') chunks.push(rec.stack)
  }
  return chunks.join(' ')
}

export function isIgnorableRendererError(error: unknown, message?: string): boolean {
  const text = collectErrorText(error, message)
  if (!text.trim()) return false
  if (/ResizeObserver loop/i.test(text)) return true
  if (/\bCanceled\b/i.test(text)) return true
  if (/disposed/i.test(text) && /(model|editor|textmodel|monaco)/i.test(text)) return true
  if (/monaco/i.test(text)) return true
  return false
}

/**
 * True when window.error / unhandledrejection must not call root.render(CrashScreen).
 * Non-Error events (Event, undefined, plain Canceled objects) are Monaco/Chromium
 * noise — swapping the React tree is worse than logging them.
 */
export function shouldSkipRendererCrashScreen(error: unknown, message?: string): boolean {
  if (isIgnorableRendererError(error, message)) return true
  if (!(error instanceof Error)) return true
  return false
}
