import { describe, expect, it } from 'vitest'
import {
  beginRunAll,
  beginSingleRun,
  cellIdFromRequestId,
  codeCellIdsAbove,
  completeRun,
  idleRunQueue,
  makeExecuteRequestId,
  notebookRunAboveEnabled,
  notebookRunAboveTitle,
  notebookRunAllEnabled,
  notebookRunAllTitle,
  notebookRunQueueBusy,
  NOTEBOOK_ERROR_EXECUTE_INVALID,
  NOTEBOOK_RUN_QUEUE_BUSY_TITLE,
  NotebookExecuteGate,
  parseNotebookExecuteIpc
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

describe('codeCellIdsAbove', () => {
  const cells = [
    { id: 'md', cellType: 'markdown' as const },
    { id: 'c1', cellType: 'code' as const },
    { id: 'c2', cellType: 'code' as const },
    { id: 'c3', cellType: 'code' as const }
  ]

  it('queues prior code cells in order and skips markdown', () => {
    expect(codeCellIdsAbove(cells, 3)).toEqual(['c1', 'c2'])
    expect(beginRunAll(codeCellIdsAbove(cells, 3))).toEqual({
      owner: 'all',
      inFlight: 'c1',
      queued: ['c2']
    })
  })

  it('is empty on the first code cell (no-op)', () => {
    expect(codeCellIdsAbove(cells, 1)).toEqual([])
    expect(beginRunAll(codeCellIdsAbove(cells, 1))).toEqual(idleRunQueue())
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

describe('parseNotebookExecuteIpc', () => {
  it('accepts string tabId, requestId, and code', () => {
    expect(parseNotebookExecuteIpc('tab-1', 'a#1', 'print(1)', 'a')).toEqual({
      ok: true,
      value: { tabId: 'tab-1', requestId: 'a#1', code: 'print(1)', cellId: 'a' }
    })
    expect(parseNotebookExecuteIpc('tab-1', 'a#1', '')).toEqual({
      ok: true,
      value: { tabId: 'tab-1', requestId: 'a#1', code: '' }
    })
  })

  it('rejects non-string code, requestId, or tabId', () => {
    expect(parseNotebookExecuteIpc('tab-1', 'a#1', { length: 1 })).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_EXECUTE_INVALID
    })
    expect(parseNotebookExecuteIpc('tab-1', 12, 'print(1)')).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_EXECUTE_INVALID
    })
    expect(parseNotebookExecuteIpc(null, 'a#1', 'print(1)')).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_EXECUTE_INVALID
    })
    expect(parseNotebookExecuteIpc('', 'a#1', 'print(1)')).toEqual({
      ok: false,
      error: NOTEBOOK_ERROR_EXECUTE_INVALID
    })
  })
})

describe('run-all / run-above busy', () => {
  it('disables Run all and Run-above while a queue is in flight', () => {
    expect(notebookRunQueueBusy(0)).toBe(false)
    expect(notebookRunQueueBusy(1)).toBe(true)
    expect(notebookRunAllEnabled(false)).toBe(true)
    expect(notebookRunAllEnabled(true)).toBe(false)
    expect(notebookRunAboveEnabled(false, true)).toBe(true)
    expect(notebookRunAboveEnabled(true, true)).toBe(false)
    expect(notebookRunAboveEnabled(false, false)).toBe(false)
    expect(notebookRunAllTitle(false)).toBe('Run all code cells')
    expect(notebookRunAllTitle(true)).toBe(NOTEBOOK_RUN_QUEUE_BUSY_TITLE)
    expect(notebookRunAboveTitle(true)).toBe(NOTEBOOK_RUN_QUEUE_BUSY_TITLE)
    expect(notebookRunAboveTitle(false)).toBe('Run all above')
  })
})
