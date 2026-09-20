/**
 * IPC send that must not take down main when a BrowserWindow/frame is gone.
 * console.error of a failed send is what turns a dead frame into "write EIO".
 */

export interface SendableWindow {
  isDestroyed: () => boolean
  webContents?: {
    isDestroyed: () => boolean
    send: (channel: string, ...args: unknown[]) => void
  }
}

export function safeWebContentsSend(
  window: SendableWindow,
  channel: string,
  ...args: unknown[]
): void {
  if (window.isDestroyed()) return
  const contents = window.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    contents.send(channel, ...args)
  } catch {
    // Destroyed frame. Do not log — logging can EIO as well.
  }
}
