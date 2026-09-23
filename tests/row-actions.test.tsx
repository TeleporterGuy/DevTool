// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

import { RowActions, RowAction } from '../src/renderer/components/ui/RowActions'

afterEach(() => {
  cleanup()
})

function renderRow(onRowClick = vi.fn(), onAction = vi.fn()) {
  render(
    <div className="group" onClick={onRowClick} data-testid="row">
      <span>a task</span>
      <RowActions>
        <RowAction title="Settle" onClick={onAction}>✓</RowAction>
      </RowActions>
    </div>
  )
  return { onRowClick, onAction }
}

describe('RowActions', () => {
  /**
   * The regression: the cluster used to `transition-all`, so revealing it on hover
   * animated its max-width from 0 — sliding each icon ~26px left over 120ms while
   * it was still clipped. A click aimed at where the icon lands fell through to the
   * row underneath, so the first click on a row's action selected the task and the
   * action only fired on the second click. Fading is fine; moving is not.
   */
  it('animates only the fade, never the geometry that carries the hit target', () => {
    renderRow()
    const cluster = screen.getByTitle('Settle').parentElement!
    const classes = cluster.className

    expect(classes).toContain('transition-opacity')
    expect(classes).not.toContain('transition-all')
    // Whatever else changes on hover, the transition must not name a box property.
    expect(classes).not.toMatch(/transition-(all|\[?max-w|width|size|transform)/)
  })

  it('keeps the actions out of the row space until the row is hovered', () => {
    renderRow()
    const cluster = screen.getByTitle('Settle').parentElement!
    expect(cluster.className).toContain('max-w-0')
    expect(cluster.className).toContain('group-hover:max-w-[120px]')
  })

  it('does not let an action click reach the row underneath', () => {
    const { onRowClick, onAction } = renderRow()
    fireEvent.click(screen.getByTitle('Settle'))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
