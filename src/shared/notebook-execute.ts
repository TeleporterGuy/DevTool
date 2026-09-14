/**
 * Per-execute request ids and run-all queue ownership.
 * Cell id alone is not unique across overlapping Run / Run all.
 */

export type NotebookRunOwner = 'idle' | 'single' | 'all'

export interface NotebookRunQueueState {
  owner: NotebookRunOwner
  /** Cell currently executing, if any. */
  inFlight: string | null
  /** Remaining cell ids, in order. */
  queued: string[]
}

export function idleRunQueue(): NotebookRunQueueState {
  return { owner: 'idle', inFlight: null, queued: [] }
}

export function makeExecuteRequestId(cellId: string, seq: number): string {
  return `${cellId}#${seq}`
}

export function cellIdFromRequestId(requestId: string, eventCellId?: string): string {
  if (eventCellId && eventCellId.length > 0) return eventCellId
  const hash = requestId.lastIndexOf('#')
  return hash === -1 ? requestId : requestId.slice(0, hash)
}

function alreadyListed(state: NotebookRunQueueState, cellId: string): boolean {
  return state.inFlight === cellId || state.queued.includes(cellId)
}

/**
 * A toolbar Run while Run-all is in flight must not wipe the remaining queue.
 * The cell is appended if it is not already in flight or queued.
 */
export function beginSingleRun(state: NotebookRunQueueState, cellId: string): NotebookRunQueueState {
  if (state.inFlight || state.queued.length > 0) {
    if (alreadyListed(state, cellId)) return state
    return { ...state, queued: [...state.queued, cellId] }
  }
  return { owner: 'single', inFlight: cellId, queued: [] }
}

export function beginRunAll(cellIds: string[]): NotebookRunQueueState {
  if (cellIds.length === 0) return idleRunQueue()
  return { owner: 'all', inFlight: cellIds[0], queued: cellIds.slice(1) }
}

export function completeRun(
  state: NotebookRunQueueState,
  cellId: string
): { state: NotebookRunQueueState; next: string | null } {
  if (state.inFlight !== cellId) {
    return { state, next: null }
  }
  const [next, ...rest] = state.queued
  if (!next) return { state: idleRunQueue(), next: null }
  return { state: { owner: state.owner, inFlight: next, queued: rest }, next }
}

/** One in-flight execute per kernel; extras wait. Used in main as a safety net. */
export type PendingNotebookExecute = {
  requestId: string
  cellId: string
  code: string
}

export class NotebookExecuteGate {
  busy = false
  inFlightId: string | null = null
  queue: PendingNotebookExecute[] = []

  submit(req: PendingNotebookExecute): 'start' | 'queued' {
    if (this.busy) {
      this.queue.push(req)
      return 'queued'
    }
    this.busy = true
    this.inFlightId = req.requestId
    return 'start'
  }

  complete(requestId: string): PendingNotebookExecute | null {
    if (this.inFlightId !== null && this.inFlightId !== requestId) {
      return null
    }
    this.busy = false
    this.inFlightId = null
    const next = this.queue.shift() ?? null
    if (next) {
      this.busy = true
      this.inFlightId = next.requestId
    }
    return next
  }

  clear(): void {
    this.busy = false
    this.inFlightId = null
    this.queue = []
  }
}
