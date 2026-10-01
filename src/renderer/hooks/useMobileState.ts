import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MobileState } from '../../shared/mobile'

/** Main's mobile state, live: loaded once and kept current by `mobile-state-changed`. */
export function useMobileState(): [MobileState | null, (state: MobileState) => void] {
  const [state, setState] = useState<MobileState | null>(null)

  useEffect(() => {
    let alive = true
    const unsubscribe = window.api.onMobileStateChanged((next) => { if (alive) setState(next) })
    void window.api.mobileGetState()
      .then((next) => { if (alive) setState(prev => prev ?? next) })
      .catch(() => {})
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return [state, setState]
}

// Whether this window is showing Settings → Mobile, where the pending request has
// its own place in the pairing section. The app-wide prompt stands down while it is.
let mobileSettingsVisible = false
const visibilityListeners = new Set<() => void>()

export function setMobileSettingsVisible(visible: boolean): void {
  if (mobileSettingsVisible === visible) return
  mobileSettingsVisible = visible
  for (const listener of visibilityListeners) listener()
}

export function useMobileSettingsVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      visibilityListeners.add(listener)
      return () => { visibilityListeners.delete(listener) }
    },
    () => mobileSettingsVisible
  )
}

/** Ticks every second while `active`: for countdowns and "last seen" labels. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function formatLastSeen(lastSeen: number | null, now: number): string {
  if (lastSeen === null) return 'Not seen since pairing'
  const minutes = Math.floor((now - lastSeen) / 60_000)
  if (minutes < 1) return 'Last seen just now'
  if (minutes < 60) return `Last seen ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Last seen ${hours} h ago`
  return `Last seen ${new Date(lastSeen).toLocaleDateString()}`
}

export function formatCountdown(expSeconds: number, now: number): string {
  const left = Math.max(0, Math.ceil(expSeconds - now / 1000))
  const m = Math.floor(left / 60)
  const s = left % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
