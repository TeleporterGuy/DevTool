/**
 * window.error in this renderer used to replace the whole React tree with a
 * crash screen. That unmounts AppProvider; a remount can run with
 * window.api undefined and then throw in useAppState effects.
 *
 * Monaco / ResizeObserver fire a lot of that noise when notebook cells move.
 */

/** Name and message only: a stack that merely passes through Monaco is not noise. */
function headlineText(error: unknown, message?: string): string {
  const chunks: string[] = []
  if (message) chunks.push(message)
  if (error instanceof Error || (error && typeof error === 'object')) {
    const rec = error as { name?: unknown; message?: unknown }
    if (typeof rec.name === 'string') chunks.push(rec.name)
    if (typeof rec.message === 'string') chunks.push(rec.message)
  } else if (typeof error === 'string') {
    chunks.push(error)
  }
  return chunks.join(' ')
}

/** Monaco's CancellationError: name and message are both exactly "Canceled". */
function isMonacoCancellation(error: unknown, message?: string): boolean {
  if (message && /^(Uncaught )?(Error: )?Canceled(: Canceled)?$/.test(message.trim())) return true
  if (!error || typeof error !== 'object') return false
  const rec = error as { name?: unknown; message?: unknown }
  return rec.message === 'Canceled' && (rec.name === 'Canceled' || rec.name === 'Error')
}

export function isIgnorableRendererError(error: unknown, message?: string): boolean {
  const text = headlineText(error, message)
  if (!text.trim()) return false
  if (/ResizeObserver loop/i.test(text)) return true
  if (isMonacoCancellation(error, message)) return true
  if (/InstantiationService has been disposed/i.test(text)) return true
  if (/\b(model|editor|textmodel)\b.*\bdisposed\b|\bdisposed\b.*\b(model|editor|textmodel)\b/i.test(text)) return true
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
