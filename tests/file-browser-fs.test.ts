import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertFileName,
  createProjectDirectory,
  createProjectFile,
  deleteProjectEntry,
  listProjectDirectory,
  renameProjectEntry
} from '../src/main/file-browser-fs'

const tmpDirs: string[] = []

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-fb-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('file-browser-fs', () => {
  it('rejects names that are paths or empty', () => {
    expect(() => assertFileName('')).toThrow(/required/i)
    expect(() => assertFileName('..')).toThrow(/Invalid name/)
    expect(() => assertFileName('a/b')).toThrow(/path/)
    expect(() => assertFileName('a\\b')).toThrow(/path/)
  })

  it('creates, lists, renames, and deletes files and folders', async () => {
    const root = makeProject()
    await createProjectFile(root, '', 'hello.py')
    await createProjectDirectory(root, '', 'src')
    await createProjectFile(root, 'src', 'app.py')

    const rootList = await listProjectDirectory(root, '', { ignore: [] })
    expect(rootList.map((e) => e.name).sort()).toEqual(['hello.py', 'src'])

    const renamed = await renameProjectEntry(root, 'hello.py', 'main.py')
    expect(renamed.relativePath).toBe('main.py')
    expect(fs.existsSync(path.join(root, 'main.py'))).toBe(true)

    await deleteProjectEntry(root, 'src')
    expect(fs.existsSync(path.join(root, 'src'))).toBe(false)
    await deleteProjectEntry(root, 'main.py')
    expect(fs.existsSync(path.join(root, 'main.py'))).toBe(false)
  })

  it('hides ignored basenames when listing', async () => {
    const root = makeProject()
    fs.mkdirSync(path.join(root, '__pycache__'))
    fs.writeFileSync(path.join(root, 'hello.py'), '')
    fs.writeFileSync(path.join(root, '.env'), '')

    const hidden = await listProjectDirectory(root, '', { ignore: ['.*', '__pycache__'] })
    expect(hidden.map((e) => e.name)).toEqual(['hello.py'])

    const shown = await listProjectDirectory(root, '', { ignore: ['.*', '__pycache__'], includeIgnored: true })
    expect(shown.map((e) => e.name).sort()).toEqual(['.env', '__pycache__', 'hello.py'])
  })

  it('rejects overwrite on create and rename, and path escape', async () => {
    const root = makeProject()
    await createProjectFile(root, '', 'a.txt')
    await expect(createProjectFile(root, '', 'a.txt')).rejects.toThrow()
    await createProjectFile(root, '', 'b.txt')
    await expect(renameProjectEntry(root, 'a.txt', 'b.txt')).rejects.toThrow(/already exists/)
    await expect(renameProjectEntry(root, '../secret', 'x')).rejects.toThrow(/Path traversal/)
    await expect(deleteProjectEntry(root, '')).rejects.toThrow(/project root/)
  })
})
