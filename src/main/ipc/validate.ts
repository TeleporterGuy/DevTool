/**
 * A tiny, dependency-free runtime validator for IPC arguments.
 *
 * Every renderer → main argument arrives as `unknown`: TypeScript's types in the
 * preload are a promise the renderer makes, not something main can rely on. A
 * `Validator<T>` either returns a value of type `T` or throws an
 * `IpcValidationError` naming the offending argument path.
 */

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

export type Validator<T> = (value: unknown, path: string) => T

export type Infer<V> = V extends Validator<infer T> ? T : never

type Shape = Record<string, Validator<unknown>>
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S]
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>
type Simplify<T> = { [K in keyof T]: T[K] } & {}
export type ObjectOf<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>

function fail(path: string, expected: string, value: unknown): never {
  throw new IpcValidationError(`Invalid IPC argument ${path}: expected ${expected}, got ${describe(value)}`)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Own-property assignment that cannot be turned into a prototype write by a `__proto__` key. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

interface StringOptions {
  /** Reject the empty string (after nothing — no trimming). */
  nonEmpty?: boolean
  max?: number
  pattern?: RegExp
  /** Human-readable name for `pattern`, used in the error message. */
  patternName?: string
}

interface NumberOptions {
  int?: boolean
  min?: number
  max?: number
}

type ObjectMode = 'strip' | 'passthrough' | 'reject'

export const v = {
  unknown: ((value: unknown) => value) as Validator<unknown>,

  string(options: StringOptions = {}): Validator<string> {
    return (value, path) => {
      if (typeof value !== 'string') fail(path, 'a string', value)
      if (options.nonEmpty && value.length === 0) fail(path, 'a non-empty string', value)
      if (options.max !== undefined && value.length > options.max) {
        throw new IpcValidationError(`Invalid IPC argument ${path}: longer than ${options.max} characters`)
      }
      if (options.pattern && !options.pattern.test(value)) {
        throw new IpcValidationError(`Invalid IPC argument ${path}: not ${options.patternName ?? `matching ${options.pattern}`}`)
      }
      return value
    }
  },

  number(options: NumberOptions = {}): Validator<number> {
    return (value, path) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number', value)
      if (options.int && !Number.isInteger(value)) fail(path, 'an integer', value)
      if (options.min !== undefined && value < options.min) {
        throw new IpcValidationError(`Invalid IPC argument ${path}: must be >= ${options.min}`)
      }
      if (options.max !== undefined && value > options.max) {
        throw new IpcValidationError(`Invalid IPC argument ${path}: must be <= ${options.max}`)
      }
      return value
    }
  },

  boolean(): Validator<boolean> {
    return (value, path) => {
      if (typeof value !== 'boolean') fail(path, 'a boolean', value)
      return value
    }
  },

  literal<const T extends readonly (string | number | boolean)[]>(...values: T): Validator<T[number]> {
    return (value, path) => {
      if (!values.includes(value as T[number])) fail(path, `one of ${values.map(x => JSON.stringify(x)).join(', ')}`, value)
      return value as T[number]
    }
  },

  /** Accepts `undefined` and `null` (both become `undefined`). */
  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined || value === null ? undefined : inner(value, path))
  },

  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (value, path) => (value === null ? null : inner(value, path))
  },

  array<T>(inner: Validator<T>, options: { max?: number } = {}): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) fail(path, 'an array', value)
      if (options.max !== undefined && value.length > options.max) {
        throw new IpcValidationError(`Invalid IPC argument ${path}: more than ${options.max} items`)
      }
      return value.map((item, index) => inner(item, `${path}[${index}]`))
    }
  },

  record<T>(inner: Validator<T>): Validator<Record<string, T>> {
    return (value, path) => {
      if (!isPlainRecord(value)) fail(path, 'an object', value)
      const out: Record<string, T> = {}
      for (const [key, item] of Object.entries(value)) setOwn(out, key, inner(item, `${path}.${key}`))
      return out
    }
  },

  /**
   * A fixed-shape object. `strip` (default) drops keys the shape does not name,
   * `passthrough` keeps them untouched, `reject` refuses them. Optional fields
   * that are absent stay absent rather than becoming `undefined`.
   */
  object<S extends Shape>(shape: S, mode: ObjectMode = 'strip'): Validator<ObjectOf<S>> {
    return (value, path) => {
      if (!isPlainRecord(value)) fail(path, 'an object', value)
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(shape, key)) continue
        if (mode === 'reject') throw new IpcValidationError(`Invalid IPC argument ${path}: unexpected key "${key}"`)
        if (mode === 'passthrough') setOwn(out, key, value[key])
      }
      for (const key of Object.keys(shape)) {
        const present = Object.prototype.hasOwnProperty.call(value, key)
        const result = shape[key](present ? value[key] : undefined, `${path}.${key}`)
        if (present || result !== undefined) setOwn(out, key, result)
      }
      return out as ObjectOf<S>
    }
  },

  /** First validator that accepts wins; the error lists nothing more specific. */
  union<T extends readonly Validator<unknown>[]>(...options: T): Validator<Infer<T[number]>> {
    return (value, path) => {
      const errors: string[] = []
      for (const option of options) {
        try {
          return option(value, path) as Infer<T[number]>
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      throw new IpcValidationError(`Invalid IPC argument ${path}: no variant matched (${errors.join('; ')})`)
    }
  },

  /** Any plain object, returned as-is — for opaque payloads validated elsewhere. */
  plainObject(): Validator<Record<string, unknown>> {
    return (value, path) => {
      if (!isPlainRecord(value)) fail(path, 'an object', value)
      return value
    }
  }
}

export type ArgsOf<A extends readonly Validator<unknown>[]> = { [K in keyof A]: Infer<A[K]> }

/**
 * Validate a handler's positional arguments. Missing trailing arguments are
 * passed to their validator as `undefined` (so optional ones are fine); extra
 * arguments beyond the schema are refused.
 */
export function validateArgs<A extends readonly Validator<unknown>[]>(
  channel: string,
  schema: A,
  args: readonly unknown[]
): ArgsOf<A> {
  if (args.length > schema.length) {
    throw new IpcValidationError(`Invalid IPC call ${channel}: expected at most ${schema.length} argument(s), got ${args.length}`)
  }
  return schema.map((validator, index) => validator(args[index], `${channel}#${index}`)) as ArgsOf<A>
}
