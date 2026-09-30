// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { handleCodeCopyClick, renderChatMarkdown } from '../src/renderer/components/claude-chat/markdown'

describe('chat code block Copy', () => {
  it('survives sanitizing and copies the code, not the button', async () => {
    const clipboardWriteText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { api: unknown }).api = { clipboardWriteText }
    const host = document.createElement('div')
    host.innerHTML = renderChatMarkdown('Run:\n\n```sh\nnpm test <x>\n```')
    const button = host.querySelector('button[data-chat-copy]')
    expect(button?.textContent).toBe('Copy')
    expect(handleCodeCopyClick(button)).toBe(true)
    expect(clipboardWriteText).toHaveBeenCalledWith('npm test <x>')
    await Promise.resolve()
    expect(button?.textContent).toBe('Copied')
    expect(handleCodeCopyClick(host.querySelector('p'))).toBe(false)
  })
})
