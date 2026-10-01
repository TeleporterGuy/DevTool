/**
 * Every validation failure in `protocol/ts` throws this, so callers can tell "the peer
 * sent something malformed" (drop it, maybe reply `bad-request`) apart from bugs.
 */
export class ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProtocolError'
  }
}
