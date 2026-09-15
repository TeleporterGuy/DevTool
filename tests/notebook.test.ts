import { describe, expect, it } from 'vitest'
import {
  addCellAt,
  applyKernelEventToOutputs,
  changeCellTypeAt,
  clearAllOutputs,
  deleteCellAt,
  emptyNotebook,
  isNotebookCellCollapsed,
  isNotebookFile,
  joinNotebookText,
  moveCell,
  notebookCellSourcePreview,
  NOTEBOOK_MIME_CHAR_LIMIT,
  NOTEBOOK_PNG_OMITTED,
  NOTEBOOK_STREAM_CHAR_LIMIT,
  NOTEBOOK_TRUNCATED_MARKER,
  parseKernelEventLine,
  parseNotebook,
  serializeNotebook,
  setNotebookCellCollapsed,
  setNotebookCondaEnvMetadata,
  notebookCondaEnvFromMetadata,
  splitNotebookText,
  updateCellSource
} from '../src/shared/notebook'

const sample = `{
 "nbformat": 4,
 "nbformat_minor": 5,
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  }
 },
 "cells": [
  {
   "id": "md-1",
   "cell_type": "markdown",
   "metadata": {},
   "source": ["# Hello\\n", "world"]
  },
  {
   "id": "code-1",
   "cell_type": "code",
   "metadata": {},
   "execution_count": 3,
   "source": ["print(1)\\n", "2 + 2"],
   "outputs": [
    {
     "output_type": "stream",
     "name": "stdout",
     "text": ["1\\n"]
    },
    {
     "output_type": "execute_result",
     "execution_count": 3,
     "data": { "text/plain": ["4"] },
     "metadata": {}
    }
   ]
  }
 ]
}
`

describe('isNotebookFile', () => {
  it('matches .ipynb case-insensitively', () => {
    expect(isNotebookFile('analysis.ipynb')).toBe(true)
    expect(isNotebookFile('notes.IPYNB')).toBe(true)
    expect(isNotebookFile('src/app.ts')).toBe(false)
    expect(isNotebookFile(undefined)).toBe(false)
  })
})

describe('join/split notebook text', () => {
  it('round-trips Jupyter line arrays', () => {
    const source = 'print(1)\n2 + 2'
    const lines = splitNotebookText(source)
    expect(lines).toEqual(['print(1)\n', '2 + 2'])
    expect(joinNotebookText(lines)).toBe(source)
  })

  it('treats empty source as an empty array', () => {
    expect(splitNotebookText('')).toEqual([])
    expect(joinNotebookText([])).toBe('')
    expect(joinNotebookText('already a string')).toBe('already a string')
  })
})

describe('parseNotebook / serializeNotebook', () => {
  it('parses nbformat 4 cells and outputs', () => {
    const doc = parseNotebook(sample)
    expect(doc.nbformat).toBe(4)
    expect(doc.cells).toHaveLength(2)
    expect(doc.cells[0]).toMatchObject({ id: 'md-1', cellType: 'markdown', source: '# Hello\nworld' })
    expect(doc.cells[1].source).toBe('print(1)\n2 + 2')
    expect(doc.cells[1].executionCount).toBe(3)
    expect(doc.cells[1].outputs[0]).toEqual({ type: 'stream', name: 'stdout', text: '1\n' })
    expect(doc.cells[1].outputs[1]).toMatchObject({
      type: 'execute_result',
      executionCount: 3,
      data: { 'text/plain': '4' }
    })
  })

  it('round-trips a parsed notebook without dropping ids or outputs', () => {
    const doc = parseNotebook(sample)
    const again = parseNotebook(serializeNotebook(doc))
    expect(again.cells.map((cell) => cell.id)).toEqual(['md-1', 'code-1'])
    expect(again.cells[1].source).toBe('print(1)\n2 + 2')
    expect(again.cells[1].outputs).toEqual(doc.cells[1].outputs)
  })

  it('round-trips metadata.devtool.condaEnv', () => {
    const withEnv = setNotebookCondaEnvMetadata(parseNotebook(sample), {
      condaEnvName: 'ml',
      condaEnvPrefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
    })
    const again = parseNotebook(serializeNotebook(withEnv))
    expect(notebookCondaEnvFromMetadata(again.metadata)).toEqual({
      condaEnvName: 'ml',
      condaEnvPrefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
    })
    const cleared = parseNotebook(serializeNotebook(setNotebookCondaEnvMetadata(again, null)))
    expect(notebookCondaEnvFromMetadata(cleared.metadata)).toBeNull()
    expect(cleared.metadata.devtool).toBeUndefined()
  })

  it('turns an empty file into a one-cell notebook', () => {
    const doc = parseNotebook('')
    expect(doc.cells).toHaveLength(1)
    expect(doc.cells[0].cellType).toBe('code')
    expect(doc.cells[0].source).toBe('')
  })

  it('rejects unsupported nbformat and invalid JSON', () => {
    expect(() => parseNotebook('{ "nbformat": 3, "cells": [] }')).toThrow(/nbformat 3/)
    expect(() => parseNotebook('not json')).toThrow(/valid JSON/)
  })

  it('preserves error and png outputs', () => {
    const doc = parseNotebook(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        id: 'c1',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        source: 'raise ValueError("nope")',
        outputs: [
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'nope',
            traceback: ['Traceback...', 'ValueError: nope']
          },
          {
            output_type: 'display_data',
            data: { 'image/png': 'abc123', 'text/plain': '<Figure>' },
            metadata: {}
          }
        ]
      }]
    }))
    expect(doc.cells[0].outputs[0]).toEqual({
      type: 'error',
      ename: 'ValueError',
      evalue: 'nope',
      traceback: ['Traceback...', 'ValueError: nope']
    })
    expect(doc.cells[0].outputs[1]).toMatchObject({
      type: 'display_data',
      data: { 'image/png': 'abc123', 'text/plain': '<Figure>' }
    })
    const roundTrip = parseNotebook(serializeNotebook(doc))
    expect(roundTrip.cells[0].outputs).toEqual(doc.cells[0].outputs)
  })
})

describe('cell operations', () => {
  it('adds, deletes, retypes, and reorders cells', () => {
    let doc = emptyNotebook()
    const firstId = doc.cells[0].id
    doc = addCellAt(doc, 1, 'markdown')
    expect(doc.cells).toHaveLength(2)
    expect(doc.cells[1].cellType).toBe('markdown')

    doc = changeCellTypeAt(doc, 0, 'markdown')
    expect(doc.cells[0].cellType).toBe('markdown')
    expect(doc.cells[0].id).toBe(firstId)

    doc = moveCell(doc, 1, 0)
    expect(doc.cells[1].id).toBe(firstId)

    doc = updateCellSource(doc, firstId, '# title')
    expect(doc.cells[1].source).toBe('# title')

    doc = deleteCellAt(doc, 0)
    expect(doc.cells).toHaveLength(1)
    expect(doc.cells[0].id).toBe(firstId)

    doc = clearAllOutputs({
      ...doc,
      cells: [{ ...doc.cells[0], cellType: 'code', outputs: [{ type: 'stream', name: 'stdout', text: 'x' }], executionCount: 2 }]
    })
    expect(doc.cells[0].outputs).toEqual([])
    expect(doc.cells[0].executionCount).toBeNull()
  })

  it('keeps one empty code cell when deleting the last cell', () => {
    const doc = deleteCellAt(emptyNotebook(), 0)
    expect(doc.cells).toHaveLength(1)
    expect(doc.cells[0].cellType).toBe('code')
  })
})

describe('notebook cell collapse', () => {
  it('starts expanded and writes both Jupyter hide flags when collapsed', () => {
    const doc = emptyNotebook()
    const cell = doc.cells[0]
    expect(isNotebookCellCollapsed(cell)).toBe(false)
    expect(notebookCellSourcePreview(cell.source)).toBe('')

    const collapsed = setNotebookCellCollapsed(doc, cell.id, true)
    expect(isNotebookCellCollapsed(collapsed.cells[0])).toBe(true)
    expect(collapsed.cells[0].metadata.jupyter).toEqual({
      source_hidden: true,
      outputs_hidden: true
    })

    const expanded = setNotebookCellCollapsed(collapsed, cell.id, false)
    expect(isNotebookCellCollapsed(expanded.cells[0])).toBe(false)
    expect(expanded.cells[0].metadata.jupyter).toBeUndefined()
  })

  it('round-trips collapse flags through serialize/parse', () => {
    let doc = parseNotebook(sample)
    doc = setNotebookCellCollapsed(doc, 'code-1', true)
    const again = parseNotebook(serializeNotebook(doc))
    expect(isNotebookCellCollapsed(again.cells[1])).toBe(true)
    expect(isNotebookCellCollapsed(again.cells[0])).toBe(false)
    expect(again.cells[1].metadata.jupyter).toEqual({
      source_hidden: true,
      outputs_hidden: true
    })
  })

  it('does not wipe unrelated cell or jupyter metadata', () => {
    const doc = parseNotebook(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        id: 'c1',
        cell_type: 'code',
        metadata: {
          tags: ['keep-me'],
          jupyter: { slideshow: { slide_type: 'slide' } }
        },
        execution_count: null,
        source: ['print(1)'],
        outputs: []
      }]
    }))
    const collapsed = setNotebookCellCollapsed(doc, 'c1', true)
    expect(collapsed.cells[0].metadata.tags).toEqual(['keep-me'])
    expect(collapsed.cells[0].metadata.jupyter).toEqual({
      slideshow: { slide_type: 'slide' },
      source_hidden: true,
      outputs_hidden: true
    })

    const expanded = setNotebookCellCollapsed(collapsed, 'c1', false)
    expect(expanded.cells[0].metadata.tags).toEqual(['keep-me'])
    expect(expanded.cells[0].metadata.jupyter).toEqual({
      slideshow: { slide_type: 'slide' }
    })
  })

  it('uses the first non-empty source line as the header preview', () => {
    expect(notebookCellSourcePreview('\n  \n  def foo():\n    return 1\n')).toBe('def foo():')
    expect(notebookCellSourcePreview('')).toBe('')
  })

  it('treats a single hide flag as expanded', () => {
    expect(isNotebookCellCollapsed({
      metadata: { jupyter: { source_hidden: true } }
    })).toBe(false)
  })
})

describe('kernel message handling', () => {
  it('parses JSON event lines and ignores junk', () => {
    expect(parseKernelEventLine('{"event":"ready"}')).toEqual({ event: 'ready' })
    expect(parseKernelEventLine('  ')).toBeNull()
    expect(parseKernelEventLine('not-json')).toBeNull()
    expect(parseKernelEventLine('{"event":"nope"}')).toBeNull()
  })

  it('requires per-event fields and ignores malformed lines', () => {
    expect(parseKernelEventLine('{"event":"stream","name":"stdout","text":"x"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"stream","id":"a#1","name":"other","text":"x"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"stream","id":"a#1","name":"stdout"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"status"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"status","execution_state":"weird"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"fail","code":"cwd"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"execute_reply","id":"a#1","status":"nope"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"error","id":"a#1","ename":"E"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"execute_result","id":"a#1"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"ready","kernel_pid":-1}')).toBeNull()
    expect(parseKernelEventLine('{"event":"ready","kernel_pid":"12"}')).toBeNull()
    expect(parseKernelEventLine('{"event":"ready","kernel_pid":4242}')).toEqual({
      event: 'ready',
      kernel_pid: 4242
    })
    expect(
      parseKernelEventLine('{"event":"stream","id":"a#1","cellId":"a","name":"stdout","text":"ok"}')
    ).toEqual({
      event: 'stream',
      id: 'a#1',
      cellId: 'a',
      name: 'stdout',
      text: 'ok'
    })
  })

  it('truncates oversized stream text and omits huge PNGs', () => {
    const huge = 'x'.repeat(NOTEBOOK_STREAM_CHAR_LIMIT + 50)
    const stream = parseKernelEventLine(
      JSON.stringify({ event: 'stream', id: 'a#1', name: 'stdout', text: huge })
    )
    expect(stream?.event).toBe('stream')
    if (stream?.event !== 'stream') return
    expect(stream.text.length).toBeLessThanOrEqual(NOTEBOOK_STREAM_CHAR_LIMIT)
    expect(stream.text.endsWith(NOTEBOOK_TRUNCATED_MARKER)).toBe(true)

    const png = 'A'.repeat(NOTEBOOK_MIME_CHAR_LIMIT + 10)
    const display = parseKernelEventLine(
      JSON.stringify({
        event: 'display_data',
        id: 'a#1',
        data: { 'image/png': png, 'text/plain': '<Figure>' }
      })
    )
    expect(display?.event).toBe('display_data')
    if (display?.event !== 'display_data') return
    expect(display.data['image/png']).toBeUndefined()
    expect(String(display.data['text/plain'])).toContain(NOTEBOOK_PNG_OMITTED)
  })

  it('appends stream chunks and merges consecutive stdout', () => {
    const first = applyKernelEventToOutputs([], {
      event: 'stream',
      id: 'c1',
      name: 'stdout',
      text: 'hel'
    })
    expect(first).toEqual([{ type: 'stream', name: 'stdout', text: 'hel' }])
    const merged = applyKernelEventToOutputs(first!, {
      event: 'stream',
      id: 'c1',
      name: 'stdout',
      text: 'lo\n'
    })
    expect(merged).toEqual([{ type: 'stream', name: 'stdout', text: 'hello\n' }])
  })

  it('records execute_result, display_data, and errors', () => {
    let outputs = applyKernelEventToOutputs([], {
      event: 'execute_result',
      id: 'c1',
      data: { 'text/plain': '4' },
      execution_count: 1
    })
    outputs = applyKernelEventToOutputs(outputs!, {
      event: 'display_data',
      id: 'c1',
      data: { 'image/png': 'iVBOR' }
    })
    outputs = applyKernelEventToOutputs(outputs!, {
      event: 'error',
      id: 'c1',
      ename: 'NameError',
      evalue: 'x',
      traceback: ['NameError: x']
    })
    expect(outputs).toEqual([
      { type: 'execute_result', data: { 'text/plain': '4' }, executionCount: 1 },
      { type: 'display_data', data: { 'image/png': 'iVBOR' } },
      { type: 'error', ename: 'NameError', evalue: 'x', traceback: ['NameError: x'] }
    ])
  })

  it('does not change outputs for status or reply events', () => {
    expect(applyKernelEventToOutputs([], { event: 'status', execution_state: 'idle' })).toBeNull()
    expect(applyKernelEventToOutputs([], { event: 'execute_reply', id: 'c1', status: 'ok', execution_count: 2 })).toBeNull()
  })
})
