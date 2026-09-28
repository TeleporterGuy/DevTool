import React from 'react'
import DOMPurify from 'dompurify'
import MarkdownPreview from './MarkdownPreview'
import {
  notebookOutputDisplay,
  NOTEBOOK_PNG_OMITTED,
  NOTEBOOK_TRUNCATED_MARKER,
  type NotebookOutput
} from '../../shared/notebook'

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function looksTruncated(text: string): boolean {
  return text.includes(NOTEBOOK_TRUNCATED_MARKER.trim()) || text.includes(NOTEBOOK_PNG_OMITTED)
}

function TruncationNote(): React.ReactElement {
  return (
    <div className="px-3 pb-1.5 text-2xs text-text-muted">Output truncated.</div>
  )
}

function OutputBlock({ output }: { output: NotebookOutput }): React.ReactElement | null {
  if (output.type === 'stream') {
    const color = output.name === 'stderr' ? 'var(--color-danger)' : undefined
    return (
      <>
        <pre
          className="m-0 px-3 py-1.5 text-[12px] leading-snug font-mono whitespace-pre-wrap break-words"
          style={{ color }}
        >
          {output.text}
        </pre>
        {looksTruncated(output.text) && <TruncationNote />}
      </>
    )
  }

  if (output.type === 'error') {
    const body = output.traceback.length > 0
      ? output.traceback.map(stripAnsi).join('\n')
      : `${output.ename}: ${output.evalue}`
    return (
      <>
        <pre
          className="m-0 px-3 py-1.5 text-[12px] leading-snug font-mono whitespace-pre-wrap break-words"
          style={{ color: 'var(--color-danger)' }}
        >
          {body}
        </pre>
        {looksTruncated(body) && <TruncationNote />}
      </>
    )
  }

  if (output.type === 'execute_result' || output.type === 'display_data') {
    const display = notebookOutputDisplay(output.data, output.jsonData)
    if (!display) return null
    const truncated = Object.values(output.data).some(looksTruncated)
    const pre = 'm-0 text-[12px] leading-snug font-mono whitespace-pre-wrap break-words'
    return (
      <div className="px-3 py-1.5">
        {display.kind === 'image' && <img alt="" src={display.src} className="max-w-full h-auto" />}
        {display.kind === 'text' && <pre className={pre}>{display.text}</pre>}
        {display.kind === 'json' && <pre className={pre}>{display.text}</pre>}
        {display.kind === 'html' && (
          // Kernel HTML is sanitized (no scripts, no event handlers) before it is shown.
          <div className="note-preview text-sm overflow-x-auto" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(display.html) }} />
        )}
        {display.kind === 'markdown' && (
          <MarkdownPreview content={display.markdown} effectiveTheme="dark" variant="flow" />
        )}
        {display.kind === 'unsupported' && (
          <div className="text-2xs text-text-muted italic">Output not shown here: {display.mimeTypes.join(', ')}</div>
        )}
        {truncated && <TruncationNote />}
      </div>
    )
  }

  return null
}

interface Props {
  outputs: NotebookOutput[]
}

export default function NotebookOutputs({ outputs }: Props): React.ReactElement | null {
  if (outputs.length === 0) return null
  return (
    <div className="border-t border-hair bg-bg">
      {outputs.map((output, index) => (
        <OutputBlock key={index} output={output} />
      ))}
    </div>
  )
}
