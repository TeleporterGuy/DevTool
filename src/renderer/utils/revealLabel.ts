/** What the OS calls showing something in its file manager. */
export function revealInFolderLabel(platform: string = window.api.platform): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in file manager'
}
