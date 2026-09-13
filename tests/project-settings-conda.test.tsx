// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project } from '../src/shared/types'

void React

vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({
    effectiveTheme: 'dark' as const,
    tags: [],
    addTag: () => ''
  })
}))

vi.mock('../src/renderer/components/dashboardIcons', () => ({
  fetchDashboardIconsMetadata: () => Promise.resolve({}),
  searchDashboardIcons: () => [],
  dashboardIconUrl: () => ''
}))

import ProjectSettings from '../src/renderer/components/ProjectSettings'

function localProject(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    directory: 'C:\\Repos\\demo',
    tasks: [],
    ...patch
  }
}

beforeEach(() => {
  ;(window as unknown as { api: { condaListEnvs: ReturnType<typeof vi.fn>; pickDirectory: ReturnType<typeof vi.fn> } }).api = {
    condaListEnvs: vi.fn().mockResolvedValue({
      executable: { kind: 'conda', file: 'C:\\Users\\me\\miniconda3\\Scripts\\conda.exe' },
      envs: [
        { name: 'base', prefix: 'C:\\Users\\me\\miniconda3' },
        { name: 'ml', prefix: 'C:\\Users\\me\\miniconda3\\envs\\ml' }
      ]
    }),
    pickDirectory: vi.fn().mockResolvedValue(null)
  }
})

afterEach(() => {
  cleanup()
})

describe('ProjectSettings conda picker', () => {
  it('lists conda envs and saves the selected name', async () => {
    const onSave = vi.fn()
    render(<ProjectSettings project={localProject()} onSave={onSave} onClose={vi.fn()} />)
    const select = await screen.findByLabelText('Conda environment')
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'ml' })).toBeTruthy()
    })
    fireEvent.change(select, { target: { value: 'ml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ condaEnvName: 'ml' }))
  })

  it('hides the picker on remote projects', () => {
    render(
      <ProjectSettings
        project={localProject({
          ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/x' }
        })}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Conda environment')).toBeNull()
  })
})
