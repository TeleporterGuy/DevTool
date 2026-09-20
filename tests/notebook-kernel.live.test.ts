/**
 * Live jupyter_client / ipykernel smoke. Skipped unless:
 *   NOTEBOOK_LIVE=1            local opt-in (Git Bash: NOTEBOOK_LIVE=1 npm test -- tests/notebook-kernel.live.test.ts)
 *   NOTEBOOK_LIVE_REQUIRED=1   Windows CI — fail the job if conda/ipykernel is missing
 *
 * Does not launch Electron. Toolbar clicks, Run-all-above buttons, and Monaco stay manual.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  condaPythonExecutable,
  listCondaEnvsForNotebookKernel,
  resetCondaEnvForTests
} from '../src/main/conda-env'
import {
  NotebookKernelManager,
  prepareNotebookKernelSpawn
} from '../src/main/notebook-kernel'
import type { CondaEnvInfo } from '../src/shared/conda'
import type { NotebookKernelEvent } from '../src/shared/notebook'
import {
  delay,
  notebookLiveHelperPath,
  notebookLiveRequested,
  waitForKernelEvent
} from './notebook-live-support'

const live = notebookLiveRequested()
const helperPath = notebookLiveHelperPath()
const START_MS = 70_000
const EXEC_MS = 45_000

type LiveKernel = {
  env: CondaEnvInfo
  python: string
}

function pythonHasJupyter(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      python,
      ['-c', 'import jupyter_client, ipykernel'],
      { timeout: 20_000, windowsHide: true },
      (err) => resolve(!err)
    )
  })
}

async function resolveLiveKernel(): Promise<LiveKernel> {
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Notebook helper missing at ${helperPath}`)
  }
  const envs = await listCondaEnvsForNotebookKernel()
  const checked: string[] = []
  for (const env of envs) {
    const python = condaPythonExecutable(env.prefix)
    if (!python) continue
    checked.push(`${env.name} ${python}`)
    if (await pythonHasJupyter(python)) {
      return { env, python }
    }
  }
  throw new Error(
    'No listed conda env has jupyter_client and ipykernel. ' +
      'Install them in a conda env (conda install ipykernel jupyter_client), then retry. ' +
      `Checked: ${checked.join('; ') || '(none — is conda.exe on PATH or CONDA_EXE set?)'}`
  )
}

describe.skipIf(!live)('live notebook kernel (jupyter_client)', { timeout: 120_000 }, () => {
  let liveKernel: LiveKernel
  let cwd = ''
  let manager: NotebookKernelManager | undefined
  let events: NotebookKernelEvent[]
  const tabId = 'live-tab'

  beforeAll(async () => {
    liveKernel = await resolveLiveKernel()
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-nb-live-'))
    manager = new NotebookKernelManager({
      prepare: (condaEnv, kernelCwd, deps) =>
        prepareNotebookKernelSpawn(condaEnv, kernelCwd, deps, helperPath)
    })
    events = []
    manager.onEvent((id, event) => {
      if (id === tabId) events.push(event)
    })
  }, START_MS)

  afterEach(async () => {
    manager?.shutdown(tabId)
    events.length = 0
    // Windows jupyter connection files / python.exe need a beat after taskkill.
    await delay(process.platform === 'win32' ? 1000 : 400)
  })

  afterAll(() => {
    manager?.shutdownAll()
    resetCondaEnvForTests()
    if (cwd) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true })
      } catch {
        /* tmp dir */
      }
    }
  })

  async function startReady(): Promise<void> {
    const from = events.length
    const started = manager!.start(tabId, liveKernel.env, cwd)
    expect(started).toEqual({})
    const readyOrFail = await waitForKernelEvent(
      events,
      (event) => event.event === 'ready' || event.event === 'fail',
      START_MS,
      'ready or fail',
      from
    )
    if (readyOrFail.event === 'fail') {
      throw new Error(`kernel fail: ${readyOrFail.code} ${readyOrFail.message}`)
    }
  }

  it('resolves conda python the same way production spawn does', () => {
    const prepared = prepareNotebookKernelSpawn(liveKernel.env, cwd, {}, helperPath)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.python).toBe(liveKernel.python)
    expect(fs.existsSync(prepared.python)).toBe(true)
    if (process.platform === 'win32') {
      expect(path.win32.isAbsolute(prepared.python)).toBe(true)
      expect(prepared.python.toLowerCase().replace(/\//g, '\\').endsWith('python.exe')).toBe(true)
    }
    expect(prepared.args).toEqual(['-u', helperPath])
    expect(prepared.env.CONDA_PREFIX).toBe(liveKernel.env.prefix)
  })

  it('starts the helper and captures stdout from a cell', async () => {
    await startReady()
    const from = events.length
    expect(manager!.execute(tabId, 'cell-a#1', 'print("hello-smoke")', 'cell-a')).toEqual({})
    const stream = await waitForKernelEvent(
      events,
      (event) => event.event === 'stream' && event.id === 'cell-a#1' && event.text.includes('hello-smoke'),
      EXEC_MS,
      'stdout hello-smoke',
      from
    )
    expect(stream.event).toBe('stream')
    const reply = await waitForKernelEvent(
      events,
      (event) => event.event === 'execute_reply' && event.id === 'cell-a#1',
      EXEC_MS,
      'execute_reply cell-a',
      from
    )
    expect(reply.event === 'execute_reply' && reply.status).toBe('ok')
  })

  it('queues a second cell like Run all / Run all above (helper, not the toolbar)', async () => {
    await startReady()
    const from = events.length
    expect(manager!.execute(tabId, 'above#1', 'print("run-above-1")', 'above-1')).toEqual({})
    expect(manager!.execute(tabId, 'above#2', 'print("run-above-2")', 'above-2')).toEqual({})
    await waitForKernelEvent(
      events,
      (event) => event.event === 'stream' && event.text.includes('run-above-1'),
      EXEC_MS,
      'stdout run-above-1',
      from
    )
    await waitForKernelEvent(
      events,
      (event) => event.event === 'stream' && event.text.includes('run-above-2'),
      EXEC_MS,
      'stdout run-above-2',
      from
    )
    const replies = events.filter(
      (event) => event.event === 'execute_reply' && (event.id === 'above#1' || event.id === 'above#2')
    )
    expect(replies).toHaveLength(2)
  })

  it('interrupts a long cell then runs again', async () => {
    await startReady()
    const from = events.length
    const startedAt = Date.now()
    expect(
      manager!.execute(tabId, 'sleep#1', 'import time\ntime.sleep(25)', 'sleep')
    ).toEqual({})
    await waitForKernelEvent(
      events,
      (event) =>
        (event.event === 'status' && event.execution_state === 'busy') ||
        (event.event === 'execute_reply' && event.id === 'sleep#1'),
      15_000,
      'busy or sleep reply',
      from
    )
    manager!.interrupt(tabId)
    await waitForKernelEvent(
      events,
      (event) => event.event === 'execute_reply' && event.id === 'sleep#1',
      EXEC_MS,
      'interrupted sleep reply',
      from
    )
    expect(Date.now() - startedAt).toBeLessThan(20_000)

    const after = events.length
    expect(manager!.execute(tabId, 'after#1', 'print("after-interrupt")', 'after')).toEqual({})
    await waitForKernelEvent(
      events,
      (event) => event.event === 'stream' && event.text.includes('after-interrupt'),
      EXEC_MS,
      'stdout after-interrupt',
      after
    )
  })

  it('restarts and runs on the new session', async () => {
    await startReady()
    const firstFrom = events.length
    expect(manager!.execute(tabId, 'pre#1', 'print("before-restart")', 'pre')).toEqual({})
    await waitForKernelEvent(
      events,
      (event) => event.event === 'execute_reply' && event.id === 'pre#1',
      EXEC_MS,
      'pre-restart reply',
      firstFrom
    )

    const restartFrom = events.length
    await startReady()
    expect(manager!.execute(tabId, 'post#1', 'print("after-restart")', 'post')).toEqual({})
    await waitForKernelEvent(
      events,
      (event) => event.event === 'stream' && event.text.includes('after-restart'),
      EXEC_MS,
      'stdout after-restart',
      restartFrom
    )
    const stale = events.slice(restartFrom).some(
      (event) => event.event === 'stream' && event.text.includes('before-restart')
    )
    expect(stale).toBe(false)
  })
})
