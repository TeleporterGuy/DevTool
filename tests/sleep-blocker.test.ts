import { describe, expect, it } from 'vitest'
import { SleepBlocker, type PowerSaveApi } from '../src/main/sleep-blocker'
import type { TabStatusValue } from '../src/shared/types'

function fakePower(): PowerSaveApi & { live: Set<number> } {
  let next = 1
  const live = new Set<number>()
  return {
    live,
    start: () => { const id = next++; live.add(id); return id },
    stop: (id) => { live.delete(id) },
    isStarted: (id) => live.has(id)
  }
}

describe('SleepBlocker', () => {
  it('blocks sleep while any tab works, once, and lets go when none does', () => {
    const power = fakePower()
    let statuses: Record<string, TabStatusValue> = { a: null }
    let enabled = true
    const blocker = new SleepBlocker(power, () => statuses, () => enabled)
    blocker.update()
    expect(power.live.size).toBe(0)

    statuses = { a: 'working', b: 'working' }
    blocker.update()
    blocker.update()
    expect(power.live.size).toBe(1)

    statuses = { a: 'attention', b: 'working' }
    blocker.update()
    expect(blocker.isBlocking()).toBe(true)

    statuses = { a: 'attention', b: null }
    blocker.update()
    expect(power.live.size).toBe(0)

    statuses = { a: 'working' }
    enabled = false
    blocker.update()
    expect(power.live.size).toBe(0)
    enabled = true
    blocker.update()
    blocker.release()
    expect(power.live.size).toBe(0)
    expect(blocker.isBlocking()).toBe(false)
  })
})
