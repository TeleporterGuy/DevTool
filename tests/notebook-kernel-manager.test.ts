import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  NotebookKernelManager,
  type NotebookKernelPrepareResult,
  type NotebookKernelSpawnFn
} from '../src/main/notebook-kernel'
import {
  NOTEBOOK_EXECUTE_CHAR_LIMIT,
  notebookExecuteTooLarge,
  notebookExecuteTooLargeMessage,
  type NotebookKernelEvent
} from '../src/shared/notebook'

class FakeStdin extends EventEmitter {
  writes: string[] = []
  private onShutdown: () => void

  constructor(onShutdown: () => void) {
    super()
    this.onShutdown = onShutdown
  }

  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(chunk)
    if (chunk.includes('"shutdown"')) {
      queueMicrotask(() => this.onShutdown())
    }
    if (cb) queueMicrotask(() => cb(null))
    return true
  }
}

class FakeChild extends EventEmitter {
  pid: number
  stdin: FakeStdin
  stdout = Object.assign(new EventEmitter(), { setEncoding(): void { /* utf8 */ } })
  stderr = Object.assign(new EventEmitter(), { setEncoding(): void { /* utf8 */ } })

  constructor(pid: number) {
    super()
    this.pid = pid
    this.stdin = new FakeStdin(() => {
      this.emit('exit', 0, null)
    })
  }

  get stdinWrites(): string[] {
    return this.stdin.writes
  }
}

function preparedOk(): NotebookKernelPrepareResult {
  return {
    ok: true,
    python: 'python',
    args: ['-u', 'helper.py'],
    env: { PATH: '/usr/bin' },
    cwd: '/proj',
    helperPath: 'helper.py'
  }
}

function makeManager(children: FakeChild[]): NotebookKernelManager {
  let index = 0
  const spawn: NotebookKernelSpawnFn = () => {
    const child = children[index]
    index += 1
    if (!child) throw new Error('unexpected spawn')
    return child as unknown as ReturnType<NotebookKernelSpawnFn>
  }
  return new NotebookKernelManager({ spawn, prepare: () => preparedOk() })
}

function emitLine(child: FakeChild, event: NotebookKernelEvent): void {
  child.stdout.emit('data', `${JSON.stringify(event)}\n`)
}

describe('notebookExecuteTooLarge', () => {
  it('rejects cell source over NOTEBOOK_EXECUTE_CHAR_LIMIT', () => {
    expect(notebookExecuteTooLarge('print(1)')).toBe(false)
    expect(notebookExecuteTooLarge('x'.repeat(NOTEBOOK_EXECUTE_CHAR_LIMIT))).toBe(false)
    expect(notebookExecuteTooLarge('x'.repeat(NOTEBOOK_EXECUTE_CHAR_LIMIT + 1))).toBe(true)
    expect(notebookExecuteTooLargeMessage(NOTEBOOK_EXECUTE_CHAR_LIMIT + 1)).toContain(
      String(NOTEBOOK_EXECUTE_CHAR_LIMIT)
    )
  })
})

describe('NotebookKernelManager session replace', () => {
  it('ignores old helper stdout after Restart so it cannot dirty the new session', () => {
    const oldChild = new FakeChild(91001)
    const newChild = new FakeChild(91002)
    const manager = makeManager([oldChild, newChild])
    const events: NotebookKernelEvent[] = []
    manager.onEvent((_tabId, event) => events.push(event))

    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')

    emitLine(oldChild, { event: 'stream', id: 'old#1', name: 'stdout', text: 'stale' })
    emitLine(oldChild, { event: 'execute_reply', id: 'old#1', status: 'ok' })

    expect(events.filter((event) => event.event === 'stream')).toEqual([])
    expect(events.filter((event) => event.event === 'execute_reply')).toEqual([])

    manager.execute('tab-1', 'new#1', 'print(1)', 'cell-new')
    manager.execute('tab-1', 'new#2', 'print(2)', 'cell-new')
    expect(newChild.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(1)
    // Old iopub/reply must not complete the new run queue.
    emitLine(oldChild, { event: 'execute_reply', id: 'new#1', status: 'ok' })
    expect(newChild.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(1)
    expect(newChild.stdinWrites.some((line) => line.includes('"new#2"'))).toBe(false)

    manager.shutdown('tab-1')
  })
})

describe('NotebookKernelManager execute gate', () => {
  it('clears the gate on interrupt so a later Run starts immediately', () => {
    const child = new FakeChild(91003)
    const manager = makeManager([child])
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')

    expect(manager.execute('tab-1', 'a#1', '1', 'a')).toEqual({})
    expect(manager.execute('tab-1', 'b#2', '2', 'b')).toEqual({})
    expect(child.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(1)

    manager.interrupt('tab-1')
    expect(child.stdinWrites.some((line) => line.includes('"interrupt"'))).toBe(true)

    expect(manager.execute('tab-1', 'c#3', '3', 'c')).toEqual({})
    expect(child.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(2)
    expect(child.stdinWrites.some((line) => line.includes('"c#3"'))).toBe(true)

    manager.shutdown('tab-1')
  })

  it('clears the gate on restart so the new session is not wedged', () => {
    const first = new FakeChild(91004)
    const second = new FakeChild(91005)
    const manager = makeManager([first, second])
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    manager.execute('tab-1', 'a#1', '1', 'a')
    manager.execute('tab-1', 'b#2', '2', 'b')
    expect(first.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(1)

    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    expect(manager.execute('tab-1', 'c#3', '3', 'c')).toEqual({})
    expect(second.stdinWrites.filter((line) => line.includes('"cmd":"execute"'))).toHaveLength(1)

    manager.shutdown('tab-1')
  })

  it('clears the gate on helper death', () => {
    const child = new FakeChild(91006)
    const manager = makeManager([child])
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    manager.execute('tab-1', 'a#1', '1', 'a')
    child.emit('exit', 1, null)
    expect(manager.has('tab-1')).toBe(false)
    expect(manager.execute('tab-1', 'b#2', '2', 'b')).toEqual({
      error: 'Kernel is not running. Click Restart kernel.'
    })
  })

  it('rejects oversize execute without writing to the helper', () => {
    const child = new FakeChild(91007)
    const manager = makeManager([child])
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    const code = 'x'.repeat(NOTEBOOK_EXECUTE_CHAR_LIMIT + 1)
    expect(manager.execute('tab-1', 'big#1', code, 'big')).toEqual({
      error: notebookExecuteTooLargeMessage(code.length)
    })
    expect(child.stdinWrites.some((line) => line.includes('"cmd":"execute"'))).toBe(false)
    // Gate must stay free for a normal cell.
    expect(manager.execute('tab-1', 'ok#1', 'print(1)', 'ok')).toEqual({})
    expect(child.stdinWrites.some((line) => line.includes('"ok#1"'))).toBe(true)
    manager.shutdown('tab-1')
  })
})

describe('NotebookKernelManager stream errors', () => {
  it('does not throw when helper stdin emits write EIO after teardown', () => {
    const child = new FakeChild(91008)
    const manager = makeManager([child])
    manager.start('tab-1', { name: 'ml', prefix: '/envs/ml' }, '/proj')
    const err = Object.assign(new Error('write EIO'), { code: 'EIO' })
    expect(() => child.stdin.emit('error', err)).not.toThrow()
    expect(() =>
      child.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).not.toThrow()
    expect(() => child.stderr.emit('error', err)).not.toThrow()
    manager.shutdown('tab-1')
  })
})
