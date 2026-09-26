import { useState, useCallback } from 'react'
import { nextBrowserZoomFactor, nextTerminalZoomDelta, type ZoomDirection } from './zoom'

export interface ZoomActions {
  terminalZoomDelta: number
  browserZoomFactor: number
  zoomTerminal: (direction: ZoomDirection) => void
  zoomBrowser: (direction: ZoomDirection) => void
}

/** Per-window zoom; never persisted. `fontSize` is the configured terminal font size. */
export function useZoom(fontSize: number | undefined): ZoomActions {
  const [terminalZoomDelta, setTerminalZoomDelta] = useState(0)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1.0)

  const zoomTerminal = useCallback((direction: ZoomDirection) => {
    setTerminalZoomDelta(prev => nextTerminalZoomDelta(prev, direction, fontSize ?? 14))
  }, [fontSize])

  const zoomBrowser = useCallback((direction: ZoomDirection) => {
    setBrowserZoomFactor(prev => nextBrowserZoomFactor(prev, direction))
  }, [])

  return { terminalZoomDelta, browserZoomFactor, zoomTerminal, zoomBrowser }
}
