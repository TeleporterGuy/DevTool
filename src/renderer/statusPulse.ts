/**
 * Drives the blinking "working"/"connecting" status dots (`.status-pulse`).
 *
 * Deliberately a 1Hz JS toggle rather than Tailwind's `animate-pulse`: any
 * infinite CSS animation — even opacity on a 6px dot — keeps Chromium's
 * compositor producing a frame every vsync, pinning the renderer at a constant
 * 60fps (and the GPU awake) while the app is otherwise idle. Toggling a class
 * from JS produces 2 frames per second instead.
 */

const TICK_MS = 1000

let started = false

export function startStatusPulse(): void {
  if (started) return
  started = true
  window.setInterval(() => {
    document.documentElement.classList.toggle('status-pulse-on')
  }, TICK_MS)
}
