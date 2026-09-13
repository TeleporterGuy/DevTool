import { describe, expect, it, vi } from 'vitest'
import { createQuitGate } from '../src/main/quit-gate'

describe('createQuitGate', () => {
  it('prevents the first quit, awaits shutdown, then exits', async () => {
    const order: string[] = []
    let finishShutdown: () => void = () => {}
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    const runQuit = createQuitGate({
      prepare: () => order.push('prepare'),
      shutdown: async () => {
        order.push('shutdown-start')
        await shutdown
        order.push('shutdown-done')
      },
      exit: () => order.push('exit')
    })

    const first = { preventDefault: vi.fn() }
    runQuit(first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(order).toContain('prepare')
    expect(order).not.toContain('exit')

    const second = { preventDefault: vi.fn() }
    runQuit(second)
    expect(second.preventDefault).not.toHaveBeenCalled()

    finishShutdown()
    await vi.waitFor(() => expect(order).toEqual(['prepare', 'shutdown-start', 'shutdown-done', 'exit']))
  })
})
