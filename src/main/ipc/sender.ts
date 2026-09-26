/**
 * Who may talk to main over IPC: only the top-level frame of one of DevTool's
 * own BrowserWindows, showing DevTool's own renderer page. `<webview>` guests
 * (browser tabs), subframes and a window that somehow navigated away are refused.
 *
 * Written against structural types so it can be tested without Electron.
 */

export interface FrameLike {
  url: string
  parent: FrameLike | null
  processId?: number
  routingId?: number
}

export interface SenderLike {
  id: number
  mainFrame?: FrameLike | null
}

export interface IpcEventLike {
  sender: SenderLike
  senderFrame?: FrameLike | null
}

export interface SenderPolicy {
  /** True for the webContents of a window main registered. */
  isAppWebContents(webContentsId: number): boolean
  /** True for a URL DevTool's renderer is served from. */
  isAppUrl(url: string): boolean
}

/** `null` when the sender is trusted, otherwise the reason it is not. */
export function senderRejection(event: IpcEventLike, policy: SenderPolicy): string | null {
  const frame = event.senderFrame
  if (!frame) return 'sender frame is gone'
  if (frame.parent !== null) return 'sender is a subframe'
  const main = event.sender.mainFrame
  if (main && main.processId !== undefined && frame.processId !== undefined
      && (main.processId !== frame.processId || main.routingId !== frame.routingId)) {
    return 'sender is not the main frame'
  }
  if (!policy.isAppWebContents(event.sender.id)) return 'sender is not a DevTool window'
  if (!policy.isAppUrl(frame.url)) return `sender URL is not the app (${frame.url})`
  return null
}

/**
 * The renderer is either the electron-vite dev server (`ELECTRON_RENDERER_URL`)
 * or the bundled `index.html` loaded over `file:`.
 */
export function createAppUrlMatcher(devServerUrl: string | undefined): (url: string) => boolean {
  let devOrigin: string | null = null
  if (devServerUrl) {
    try {
      devOrigin = new URL(devServerUrl).origin
    } catch {
      devOrigin = null
    }
  }
  return (url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (devOrigin) return parsed.origin === devOrigin
    return parsed.protocol === 'file:'
  }
}
