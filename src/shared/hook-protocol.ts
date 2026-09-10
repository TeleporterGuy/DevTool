/**
 * Shared names for the inbox hook protocol (local HTTP + SSH reverse tunnel).
 *
 * The Pi status extension is a plain ESM file loaded by `pi` itself, so it
 * cannot import this module — keep the header / env strings in
 * `resources/pi-status-extension.mjs` in sync with these constants.
 */

/** Header the hook server requires on every POST. */
export const HOOK_TOKEN_HEADER = 'X-Devtool-Token'

/** Tab that should receive the inbox/status event. */
export const HOOK_TAB_ID_HEADER = 'X-Tab-Id'

/** Env var: hook-server port (local) or reverse-forwarded port (SSH remote). */
export const HOOK_PORT_ENV = 'DEVTOOL_HOOK_PORT'

/** Env var: shared secret minted when the hook server starts. */
export const HOOK_TOKEN_ENV = 'DEVTOOL_HOOK_TOKEN'

/** Reject hook bodies larger than this (bytes). */
export const MAX_HOOK_BODY_BYTES = 64 * 1024
