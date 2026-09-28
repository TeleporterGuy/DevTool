import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { senderRejection, type IpcEventLike, type SenderPolicy } from './sender'
import { validateArgs, type ArgsOf, type Validator } from './validate'

/** The part of `ipcMain` the registrar uses — a fake in tests. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void
}

type Schema = readonly Validator<unknown>[]

/**
 * Every IPC handler goes through here: the sender is checked first, then each
 * positional argument against its validator, and only then does the handler run
 * — with arguments typed from the schema rather than trusted from the preload.
 */
export interface IpcRegistrar {
  /** `ipcMain.handle`: a refused sender or bad argument rejects the renderer's promise. */
  handle<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (event: IpcMainInvokeEvent, ...args: ArgsOf<A>) => unknown
  ): void
  /** `ipcMain.on` (fire-and-forget): a refused call is logged and dropped. */
  on<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (event: IpcMainEvent, ...args: ArgsOf<A>) => void
  ): void
  /**
   * `ipcMain.on` answering `sendSync`: the handler's return value becomes
   * `event.returnValue`; a refused call answers `fallback` so the renderer is
   * never left blocked.
   */
  onSync<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (event: IpcMainEvent, ...args: ArgsOf<A>) => unknown,
    fallback: unknown
  ): void
}

export interface RegistrarOptions {
  ipcMain: IpcMainLike
  senderPolicy: SenderPolicy
  log: (message: string) => void
}

export class IpcSenderError extends Error {
  constructor(channel: string, reason: string) {
    super(`IPC ${channel} refused: ${reason}`)
    this.name = 'IpcSenderError'
  }
}

export function createIpcRegistrar({ ipcMain, senderPolicy, log }: RegistrarOptions): IpcRegistrar {
  const check = (channel: string, event: IpcEventLike): void => {
    const reason = senderRejection(event, senderPolicy)
    if (reason) throw new IpcSenderError(channel, reason)
  }

  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  return {
    handle(channel, schema, handler) {
      ipcMain.handle(channel, (event, ...raw) => {
        try {
          check(channel, event as unknown as IpcEventLike)
          const args = validateArgs(channel, schema, raw)
          return handler(event, ...args)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          throw err
        }
      })
    },

    on(channel, schema, handler) {
      ipcMain.on(channel, (event, ...raw) => {
        let args: ArgsOf<typeof schema>
        try {
          check(channel, event as unknown as IpcEventLike)
          args = validateArgs(channel, schema, raw)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          return
        }
        handler(event, ...args)
      })
    },

    onSync(channel, schema, handler, fallback) {
      ipcMain.on(channel, (event, ...raw) => {
        let args: ArgsOf<typeof schema>
        try {
          check(channel, event as unknown as IpcEventLike)
          args = validateArgs(channel, schema, raw)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          event.returnValue = fallback
          return
        }
        try {
          event.returnValue = handler(event, ...args)
        } catch (err) {
          log(`ipcFailed channel=${channel} error=${describe(err)}`)
          event.returnValue = fallback
        }
      })
    }
  }
}
