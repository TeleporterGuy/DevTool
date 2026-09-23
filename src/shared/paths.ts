/**
 * Path bits that have to agree between the renderer and main. Deliberately
 * posix-only: the same helpers run over remote (ssh) paths, where the local
 * platform's separator is the wrong answer.
 */

/** Last segment of a directory path, trailing slashes ignored. */
export function dirBasename(directory: string): string {
  return directory.replace(/\/+$/, '').split('/').pop() || directory
}
