// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ThemedSelect from '../src/renderer/components/ThemedSelect'

void React

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
})

const options = [
  { value: '', label: 'None (default PATH)' },
  { value: 'C:\\envs\\ml', label: 'ml' }
]

describe('ThemedSelect', () => {
  it('opens a themed menu and selects an option', () => {
    const onChange = vi.fn()
    render(
      <ThemedSelect
        aria-label="Conda environment"
        value=""
        options={options}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Conda environment' }))
    fireEvent.click(screen.getByRole('option', { name: 'ml' }))
    expect(onChange).toHaveBeenCalledWith('C:\\envs\\ml')
    expect(screen.queryByRole('option', { name: 'ml' })).toBeNull()
  })

  it('closes on Escape without changing the value', () => {
    const onChange = vi.fn()
    render(
      <ThemedSelect
        aria-label="Conda environment"
        value=""
        options={options}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Conda environment' }))
    expect(screen.getByRole('option', { name: 'ml' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('option', { name: 'ml' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
