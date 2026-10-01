import type { TabStatusValue } from '../shared/types'

/** The part of Electron's `powerSaveBlocker` this uses; injected for tests. */
export interface PowerSaveApi {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/**
 * Keeps the machine from going to sleep while any agent tab (terminal or chat) is
 * working, so a long turn isn't frozen halfway when you walk away. The display
 * may still sleep ('prevent-app-suspension' only holds off system sleep). Driven
 * by main's TabActivityRegistry, which sees every window's tabs.
 */
export class SleepBlocker {
  private blockerId: number | null = null

  constructor(
    private readonly power: PowerSaveApi,
    private readonly statuses: () => Record<string, TabStatusValue>,
    private readonly enabled: () => boolean,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /** Re-read the statuses and the setting; call after either changes. */
  update(): void {
    const working = this.enabled() && Object.values(this.statuses()).some((status) => status === 'working')
    if (working && this.blockerId === null) {
      this.blockerId = this.power.start('prevent-app-suspension')
      this.log('sleepBlocker on')
    } else if (!working && this.blockerId !== null) {
      this.release()
    }
  }

  release(): void {
    if (this.blockerId === null) return
    if (this.power.isStarted(this.blockerId)) this.power.stop(this.blockerId)
    this.blockerId = null
    this.log('sleepBlocker off')
  }

  isBlocking(): boolean {
    return this.blockerId !== null
  }
}
