export function buildWindowTitle(projectName: string | null, taskName: string | null, taskIsHome?: boolean): string {
  if (projectName && taskName && !taskIsHome) {
    return `${projectName} / ${taskName}`
  }
  if (projectName) {
    return projectName
  }
  return 'DevTool'
}
