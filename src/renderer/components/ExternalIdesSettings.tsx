import React, { useState } from 'react'
import type { ExternalEditor, ExternalEditorsConfig } from '../../shared/types'
import { Field, GrpHead, FormGroup, SetBlock, HelperText, LinkBtn } from './ui'

function newEditor(): ExternalEditor {
  return {
    id: crypto.randomUUID(),
    name: '',
    command: '',
    extraArgs: ''
  }
}

function patchEditors(
  current: ExternalEditorsConfig,
  editors: ExternalEditor[],
  defaultId: string | null
): ExternalEditorsConfig {
  const stillThere = defaultId && editors.some((editor) => editor.id === defaultId)
  return {
    editors,
    defaultId: stillThere ? defaultId : (editors[0]?.id ?? null)
  }
}

interface Props {
  value: ExternalEditorsConfig
  onChange: (next: ExternalEditorsConfig) => void
}

export default function ExternalIdesSettings({ value, onChange }: Props): React.ReactElement {
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)

  const updateEditor = (id: string, patch: Partial<ExternalEditor>): void => {
    onChange({
      ...value,
      editors: value.editors.map((editor) => (editor.id === id ? { ...editor, ...patch } : editor))
    })
  }

  const handleDetect = async (): Promise<void> => {
    setDetecting(true)
    setDetectError(null)
    try {
      const found = await window.api.externalIdeDetect()
      const existing = new Set(value.editors.map((editor) => editor.command.toLowerCase()))
      const added: ExternalEditor[] = []
      for (const candidate of found) {
        if (existing.has(candidate.command.toLowerCase())) continue
        existing.add(candidate.command.toLowerCase())
        added.push({
          id: crypto.randomUUID(),
          name: candidate.name,
          command: candidate.command,
          extraArgs: ''
        })
      }
      if (added.length === 0) {
        setDetectError(found.length === 0 ? 'No VS Code or Cursor install found.' : 'Those editors are already in the list.')
        return
      }
      const editors = [...value.editors, ...added]
      onChange(patchEditors(value, editors, value.defaultId ?? added[0].id))
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : String(error))
    } finally {
      setDetecting(false)
    }
  }

  return (
    <>
      <GrpHead>External IDEs</GrpHead>
      <FormGroup>
        <HelperText>
          Open the project folder in VS Code, Cursor, or another editor. This does not change the
          Monaco editor above.
        </HelperText>
        {value.editors.map((editor) => (
          <SetBlock key={editor.id} divider>
            <div className="flex items-center gap-2 mb-2">
              <label className="flex items-center gap-1.5 text-sm text-text shrink-0">
                <input
                  type="radio"
                  name="external-ide-default"
                  checked={value.defaultId === editor.id}
                  onChange={() => onChange({ ...value, defaultId: editor.id })}
                />
                Default
              </label>
              <Field
                className="flex-1"
                value={editor.name}
                placeholder="Display name"
                onChange={(e) => updateEditor(editor.id, { name: e.target.value })}
              />
              <LinkBtn
                danger
                onClick={() => {
                  const editors = value.editors.filter((item) => item.id !== editor.id)
                  onChange(patchEditors(value, editors, value.defaultId))
                }}
              >
                Remove
              </LinkBtn>
            </div>
            <div className="flex items-center gap-2.5">
              <Field
                className="flex-1"
                value={editor.command}
                placeholder="Path to the .exe"
                onChange={(e) => updateEditor(editor.id, { command: e.target.value })}
              />
              <LinkBtn
                onClick={() => {
                  void window.api.pickFile('Select editor executable').then((picked) => {
                    if (!picked) return
                    const name = editor.name.trim() ? editor.name : fileNameFromPath(picked)
                    updateEditor(editor.id, { command: picked, name })
                  })
                }}
              >
                Browse
              </LinkBtn>
            </div>
            <div className="mt-2">
              <Field
                value={editor.extraArgs}
                placeholder="Optional extra args"
                onChange={(e) => updateEditor(editor.id, { extraArgs: e.target.value })}
              />
            </div>
          </SetBlock>
        ))}
        <SetBlock divider>
          <div className="flex items-center gap-3">
            <LinkBtn
              onClick={() => {
                const editor = newEditor()
                onChange(patchEditors(value, [...value.editors, editor], value.defaultId ?? editor.id))
              }}
            >
              Add editor
            </LinkBtn>
            <LinkBtn disabled={detecting} onClick={() => { void handleDetect() }}>
              {detecting ? 'Detecting…' : 'Detect VS Code / Cursor'}
            </LinkBtn>
          </div>
          {detectError && (
            <div role="alert" className="mt-2 text-sm text-danger">{detectError}</div>
          )}
        </SetBlock>
      </FormGroup>
    </>
  )
}

function fileNameFromPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = slash === -1 ? filePath : filePath.slice(slash + 1)
  return base.replace(/\.(exe|cmd|bat)$/i, '')
}
