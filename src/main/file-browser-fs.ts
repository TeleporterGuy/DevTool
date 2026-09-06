import fs from 'fs'
import path from 'path'
import type { DirectoryEntry } from '../shared/types'
import { effectiveIgnorePatterns, nameMatchesIgnore } from '../shared/file-tree-ignore'
import { posixRelativeJoin } from '../shared/workspace-path'
import { resolveSafeProjectPath } from './project-fs-path'

const fsPromises = fs.promises

export type ListDirectoryOptions = {
  ignore?: readonly string[]
  includeIgnored?: boolean
}

/** A single path segment: no slashes, not `.` / `..`. */
export function assertFileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name is required')
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name')
  if (/[\\/]/.test(trimmed)) throw new Error('Name cannot contain a path')
  return trimmed
}

function ignoreCaseForHost(): boolean {
  return process.platform === 'win32'
}

export async function listProjectDirectory(
  projectCwd: string,
  relativeDirPath: string,
  options: ListDirectoryOptions = {}
): Promise<DirectoryEntry[]> {
  const fullPath = resolveSafeProjectPath(projectCwd, relativeDirPath)
  const entries = await fsPromises.readdir(fullPath, { withFileTypes: true })
  const patterns = effectiveIgnorePatterns(options.ignore, options.includeIgnored === true)
  const caseInsensitive = ignoreCaseForHost()
  return entries
    .filter((entry) => !nameMatchesIgnore(entry.name, patterns, caseInsensitive))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      relativePath: posixRelativeJoin(relativeDirPath, entry.name)
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function createProjectFile(
  projectCwd: string,
  parentRelativePath: string,
  name: string
): Promise<DirectoryEntry> {
  const fileName = assertFileName(name)
  const relativePath = posixRelativeJoin(parentRelativePath, fileName)
  const fullPath = resolveSafeProjectPath(projectCwd, relativePath)
  // wx: fail if the file already exists instead of overwriting.
  await fsPromises.writeFile(fullPath, '', { encoding: 'utf-8', flag: 'wx' })
  return { name: fileName, type: 'file', relativePath }
}

export async function createProjectDirectory(
  projectCwd: string,
  parentRelativePath: string,
  name: string
): Promise<DirectoryEntry> {
  const dirName = assertFileName(name)
  const relativePath = posixRelativeJoin(parentRelativePath, dirName)
  const fullPath = resolveSafeProjectPath(projectCwd, relativePath)
  await fsPromises.mkdir(fullPath)
  return { name: dirName, type: 'directory', relativePath }
}

function sameResolvedPath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (process.platform === 'win32') return ra.toLowerCase() === rb.toLowerCase()
  return ra === rb
}

export async function renameProjectEntry(
  projectCwd: string,
  fromRelativePath: string,
  newName: string
): Promise<DirectoryEntry> {
  if (!fromRelativePath) throw new Error('Cannot rename the project root')
  const fileName = assertFileName(newName)
  const slash = fromRelativePath.lastIndexOf('/')
  const parent = slash === -1 ? '' : fromRelativePath.slice(0, slash)
  const toRelativePath = posixRelativeJoin(parent, fileName)
  const fromFull = resolveSafeProjectPath(projectCwd, fromRelativePath)
  const toFull = resolveSafeProjectPath(projectCwd, toRelativePath)

  if (sameResolvedPath(fromFull, toFull)) {
    const fromBase = path.basename(fromFull)
    const toBase = path.basename(toFull)
    if (fromBase !== toBase) {
      // Windows: Foo → foo is the same path, so hop through a temp name.
      const tmp = fromFull + '.devtool-rename-tmp'
      await fsPromises.rename(fromFull, tmp)
      await fsPromises.rename(tmp, toFull)
    }
    const st = await fsPromises.stat(toFull)
    return {
      name: fileName,
      type: st.isDirectory() ? 'directory' : 'file',
      relativePath: toRelativePath
    }
  }

  try {
    await fsPromises.stat(toFull)
    throw new Error('A file or folder with that name already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fsPromises.rename(fromFull, toFull)
  const st = await fsPromises.stat(toFull)
  return {
    name: fileName,
    type: st.isDirectory() ? 'directory' : 'file',
    relativePath: toRelativePath
  }
}

export async function deleteProjectEntry(
  projectCwd: string,
  relativePath: string
): Promise<void> {
  if (!relativePath) throw new Error('Cannot delete the project root')
  const fullPath = resolveSafeProjectPath(projectCwd, relativePath)
  const st = await fsPromises.lstat(fullPath)
  if (st.isDirectory()) {
    await fsPromises.rm(fullPath, { recursive: true })
    return
  }
  await fsPromises.unlink(fullPath)
}
