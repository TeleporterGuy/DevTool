import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  piExtensionRemotePath,
  PI_REMOTE_EXTENSION_DIR,
  buildRemotePiExtensionScript
} from '../src/main/pi-extension-injector'

describe('piExtensionRemotePath', () => {
  it('lives under $HOME, not /tmp', () => {
    const remotePath = piExtensionRemotePath()
    expect(remotePath).toBe(`$HOME/${PI_REMOTE_EXTENSION_DIR}/pi-status-extension.mjs`)
    expect(remotePath).not.toContain('/tmp/')
  })
})

describe('buildRemotePiExtensionScript', () => {
  it('creates a 0700 home dir and writes via python expanduser', () => {
    const source = path.join(os.tmpdir(), `pi-ext-src-${Date.now()}.mjs`)
    fs.writeFileSync(source, 'export default function () {}')
    try {
      const script = buildRemotePiExtensionScript(source)
      expect(script).toContain(`mkdir -p "$HOME/${PI_REMOTE_EXTENSION_DIR}"`)
      expect(script).toContain(`chmod 700 "$HOME/${PI_REMOTE_EXTENSION_DIR}"`)
      expect(script).toContain('os.path.expanduser')
      expect(script).toContain(`~/${PI_REMOTE_EXTENSION_DIR}/pi-status-extension.mjs`)
      expect(script).not.toContain('/tmp/devtool-')
      // The file contents are base64-encoded in the python one-liner
      const b64 = fs.readFileSync(source).toString('base64')
      expect(script).toContain(b64)
    } finally {
      fs.unlinkSync(source)
    }
  })
})
