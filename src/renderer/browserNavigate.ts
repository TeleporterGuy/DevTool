/**
 * In-memory browser navigation. Used so Jupyter can load a token URL in the
 * webview without writing that secret into projects.json.
 *
 * addTab is React state — the tab may not be mounted yet when we fire the
 * event. Stash the URL so BrowserTab can pick it up on first render.
 */

const pendingByTabId = new Map<string, string>()

export function requestBrowserTabNavigate(tabId: string, url: string): void {
  pendingByTabId.set(tabId, url)
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('navigate-browser-tab', { detail: { tabId, url } })
  )
}

/** Consume a pending URL once (mount or the live event handler). */
export function takePendingBrowserNavigate(tabId: string): string | undefined {
  const url = pendingByTabId.get(tabId)
  if (url !== undefined) pendingByTabId.delete(tabId)
  return url
}

/** Test helper — do not call from app code. */
export function clearPendingBrowserNavigates(): void {
  pendingByTabId.clear()
}
