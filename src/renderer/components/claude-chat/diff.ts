/**
 * A small line diff for Edit/Write cards: an LCS over lines, which is plenty for
 * the snippets Claude's Edit tool carries. Big inputs fall back to "all removed,
 * all added" rather than spending seconds in the renderer.
 */
export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

const MAX_CELLS = 400_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}

/** The before/after pairs an edit-like tool call carries, or null for other tools. */
export function editPairs(name: string, input: Record<string, unknown>): { before: string; after: string }[] | null {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (name === 'Edit') return [{ before: str(input.old_string), after: str(input.new_string) }]
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit) => {
      const e = (edit && typeof edit === 'object' ? edit : {}) as Record<string, unknown>
      return { before: str(e.old_string), after: str(e.new_string) }
    })
  }
  if (name === 'Write') return [{ before: '', after: str(input.content) }]
  return null
}
