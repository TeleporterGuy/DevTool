import { useState, useCallback } from 'react'
import { DEFAULT_CONFIG, type AppConfig } from '../../../shared/types'
import { nextEditorFontSize } from '../../components/zoom'
import { nextBrowserZoomFactor, nextTerminalZoomDelta, type ZoomDirection } from './zoom'

export interface ZoomActions {
  terminalZoomDelta: number
  browserZoomFactor: number
  zoomTerminal: (direction: ZoomDirection) => void
  zoomBrowser: (direction: ZoomDirection) => void
  /** Editor/notebook/note/diff font size — persisted in config, unlike the other two. */
  zoomEditor: (direction: ZoomDirection) => void
}

/**
 * Per-window terminal and browser zoom (never persisted), plus the editor font
 * size, which lives in config. `fontSize` is the configured terminal font size.
 */
export function useZoom(
  fontSize: number | undefined,
  editorFontSize?: number,
  updateConfig: (updates: Partial<AppConfig>) => void = () => {}
): ZoomActions {
  const [terminalZoomDelta, setTerminalZoomDelta] = useState(0)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1.0)

  const zoomTerminal = useCallback((direction: ZoomDirection) => {
    setTerminalZoomDelta(prev => nextTerminalZoomDelta(prev, direction, fontSize ?? 14))
  }, [fontSize])

  const zoomBrowser = useCallback((direction: ZoomDirection) => {
    setBrowserZoomFactor(prev => nextBrowserZoomFactor(prev, direction))
  }, [])

  const zoomEditor = useCallback((direction: ZoomDirection) => {
    updateConfig({
      editorFontSize: nextEditorFontSize(editorFontSize ?? DEFAULT_CONFIG.editorFontSize, direction)
    })
  }, [editorFontSize, updateConfig])

  return { terminalZoomDelta, browserZoomFactor, zoomTerminal, zoomBrowser, zoomEditor }
}
