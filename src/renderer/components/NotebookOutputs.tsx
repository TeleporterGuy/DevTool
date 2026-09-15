import React from 'react'
import {
  mimePlainText,
  mimePng,
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
    const png = mimePng(output.data)
    const text = mimePlainText(output.data)
    const truncated = (text != null && looksTruncated(text)) || Object.values(output.data).some(looksTruncated)
    return (
      <div className="px-3 py-1.5">
        {png && (
          <img
            alt=""
            src={`data:image/png;base64,${png.replace(/\s/g, '')}`}
            className="max-w-full h-auto"
          />
        )}
        {!png && text && (
          <pre className="m-0 text-[12px] leading-snug font-mono whitespace-pre-wrap break-words">{text}</pre>
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
