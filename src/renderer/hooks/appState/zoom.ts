/** Pure zoom steps for terminals (font-size delta) and browser tabs (zoom factor). */

export type ZoomDirection = 'in' | 'out' | 'reset'

const MIN_TERMINAL_FONT_SIZE = 6
const MAX_TERMINAL_FONT_SIZE = 48

/**
 * The next terminal font-size delta. A step that would take the effective size
 * (`fontSize + delta`) outside 6..48 is refused and `prev` comes back.
 */
export function nextTerminalZoomDelta(prev: number, direction: ZoomDirection, fontSize: number): number {
  if (direction === 'reset') return 0
  const step = direction === 'in' ? 2 : -2
  const next = prev + step
  const effective = fontSize + next
  if (effective < MIN_TERMINAL_FONT_SIZE || effective > MAX_TERMINAL_FONT_SIZE) return prev
  return next
}

/** The next browser zoom factor in 0.1 steps, held to 0.3..3.0. */
export function nextBrowserZoomFactor(prev: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 1.0
  const step = direction === 'in' ? 0.1 : -0.1
  const next = Math.round((prev + step) * 10) / 10
  if (next < 0.3 || next > 3.0) return prev
  return next
}
