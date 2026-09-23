import React from 'react'
import type { DiffLine } from './diff'

export default function DiffView({ lines }: { lines: DiffLine[] }): React.ReactElement {
  return (
    <pre className="chat-pre chat-diff">
      {lines.map((line, index) => (
        <div key={index} className={line.kind === 'add' ? 'chat-diff-add' : line.kind === 'del' ? 'chat-diff-del' : 'text-text-subtle'}>
          <span className="select-none opacity-60">{line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}</span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  )
}
