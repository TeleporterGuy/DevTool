// src/renderer/palette/paletteEvents.ts
type EventMap = {
  'open-settings': void
  'open-project-settings': void
  'toggle-sidebar': void
  'toggle-file-browser': void
  'toggle-watch-strip': void
  'pin-active-tab': void
  'unpin-active-tab': void
  'reload-window': void
  'open-devtools': void
  'quit-app': void
  'switch-theme': 'dark' | 'light' | 'toggle'
  'palette-prefix-set': string
  /** Palette-run Ctrl+L / Ctrl+Shift+L: the visible editor or notebook links to its task's agent. */
  'link-to-agent': 'selection' | 'file'
  /** Short message for the agent-link banner (no agent tab, save failed). */
  'agent-link-notice': string
}

type Listener<K extends keyof EventMap> = EventMap[K] extends void
  ? () => void
  : (payload: EventMap[K]) => void

class PaletteEvents {
  private listeners = new Map<keyof EventMap, Set<(payload: any) => void>>()
  on<K extends keyof EventMap>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(fn as any)
    return () => { set!.delete(fn as any) }
  }
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K] extends void ? [] : [EventMap[K]]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) fn(args[0])
  }
}

export const paletteEvents = new PaletteEvents()
