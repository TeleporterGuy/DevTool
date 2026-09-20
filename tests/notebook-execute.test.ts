import { describe, expect, it } from 'vitest'
import {
  beginRunAll,
  beginSingleRun,
  cellIdFromRequestId,
  completeRun,
  idleRunQueue,
  makeExecuteRequestId,
  NotebookExecuteGate
} from '../src/shared/notebook-execute'
import {
  NOTEBOOK_EXECUTE_CHAR_LIMIT,
  notebookExecuteTooLarge
} from '../src/shared/notebook'

describe('execute request ids', () => {
  it('is unique per execute, not just per cell', () => {
    expect(makeExecuteRequestId('cell-a', 1)).toBe('cell-a#1')
    expect(makeExecuteRequestId('cell-a', 2)).toBe('cell-a#2')
    expect(makeExecuteRequestId('cell-a', 1)).not.toBe(makeExecuteRequestId('cell-a', 2))
  })

  it('recovers the cell id from the request id or an explicit field', () => {
    expect(cellIdFromRequestId('cell-a#3')).toBe('cell-a')
    expect(cellIdFromRequestId('cell-a#3', 'cell-b')).toBe('cell-b')
    expect(cellIdFromRequestId('no-hash')).toBe('no-hash')
  })
})

describe('run-all queue ownership', () => {
  it('does not wipe a run-all queue when a mid-flight Run is requested', () => {
    const running = beginRunAll(['a', 'b', 'c'])
    expect(running).toEqual({ owner: 'all', inFlight: 'a', queued: ['b', 'c'] })

    const afterRun = beginSingleRun(running, 'd')
    expect(afterRun.owner).toBe('all')
    expect(afterRun.inFlight).toBe('a')
    expect(afterRun.queued).toEqual(['b', 'c', 'd'])
  })

  it('does not re-queue a cell that is already in flight or queued', () => {
    const running = beginRunAll(['a', 'b'])
    expect(beginSingleRun(running, 'a')).toEqual(running)
    expect(beginSingleRun(running, 'b')).toEqual(running)
  })

  it('starts a single run only when idle', () => {
    expect(beginSingleRun(idleRunQueue(), 'a')).toEqual({
      owner: 'single',
      inFlight: 'a',
      queued: []
    })
  })

  it('ignores a stale completeRun that is not the in-flight cell', () => {
    const running = beginRunAll(['a', 'b'])
    const stale = completeRun(running, 'b')
    expect(stale.next).toBeNull()
    expect(stale.state).toEqual(running)
  })

  it('advances to the next queued cell on complete', () => {
    const running = beginRunAll(['a', 'b', 'c'])
    const first = completeRun(running, 'a')
    expect(first.next).toBe('b')
    expect(first.state).toEqual({ owner: 'all', inFlight: 'b', queued: ['c'] })
    const last = completeRun(first.state, 'b')
    expect(last.next).toBe('c')
    const done = completeRun(last.state, 'c')
    expect(done).toEqual({ state: idleRunQueue(), next: null })
  })
})

describe('NotebookExecuteGate', () => {
  it('single-flights execute and queues extras until complete', () => {
    const gate = new NotebookExecuteGate()
    expect(gate.submit({ requestId: 'a#1', cellId: 'a', code: '1' })).toBe('start')
    expect(gate.submit({ requestId: 'b#2', cellId: 'b', code: '2' })).toBe('queued')
    expect(gate.submit({ requestId: 'c#3', cellId: 'c', code: '3' })).toBe('queued')

    const next = gate.complete('a#1')
    expect(next).toEqual({ requestId: 'b#2', cellId: 'b', code: '2' })
    expect(gate.complete('nope')).toBeNull()
    expect(gate.complete('b#2')).toEqual({ requestId: 'c#3', cellId: 'c', code: '3' })
    expect(gate.complete('c#3')).toBeNull()
    expect(gate.busy).toBe(false)
  })

  it('clear drops in-flight and queued work so a later submit can start', () => {
    const gate = new NotebookExecuteGate()
    expect(gate.submit({ requestId: 'a#1', cellId: 'a', code: '1' })).toBe('start')
    expect(gate.submit({ requestId: 'b#2', cellId: 'b', code: '2' })).toBe('queued')
    gate.clear()
    expect(gate.busy).toBe(false)
    expect(gate.inFlightId).toBeNull()
    expect(gate.queue).toEqual([])
    // Late execute_reply after interrupt must not dequeue leftover work.
    expect(gate.complete('a#1')).toBeNull()
    expect(gate.submit({ requestId: 'c#3', cellId: 'c', code: '3' })).toBe('start')
  })
})

describe('execute payload cap', () => {
  it('treats source over NOTEBOOK_EXECUTE_CHAR_LIMIT as too large', () => {
    expect(NOTEBOOK_EXECUTE_CHAR_LIMIT).toBe(1_000_000)
    expect(notebookExecuteTooLarge('x'.repeat(NOTEBOOK_EXECUTE_CHAR_LIMIT))).toBe(false)
    expect(notebookExecuteTooLarge('x'.repeat(NOTEBOOK_EXECUTE_CHAR_LIMIT + 1))).toBe(true)
  })
})
