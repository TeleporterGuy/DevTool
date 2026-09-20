/**
 * Gating and helpers for live jupyter_client smoke tests.
 * Not imported by the app — tests only.
 */

import path from 'node:path'

export function notebookLiveRequested(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.NOTEBOOK_LIVE === '1' || env.NOTEBOOK_LIVE_REQUIRED === '1'
}

export function notebookLiveHelperPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'resources', 'notebook-kernel.py')
}

export async function waitForKernelEvent<T extends { event: string }>(
  events: T[],
  match: (event: T) => boolean,
  timeoutMs: number,
  label: string,
  fromIndex = 0
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = events.slice(fromIndex).find(match)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const recent = events.slice(-12)
  throw new Error(`Timed out waiting for ${label}. Recent events: ${JSON.stringify(recent)}`)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
