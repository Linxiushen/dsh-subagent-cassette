import type { JsonValue } from './types.ts'

const REDACTED = '[REDACTED]'
const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
])
const SECRET_KEY_SUFFIXES = [
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
] as const

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SECRET_KEYS.has(normalized)
    || SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

interface RedactionPattern {
  readonly expression: RegExp
  readonly keepFirstCapture: boolean
}

const BUILTIN_PATTERNS: RedactionPattern[] = [
  { expression: /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepFirstCapture: false },
  { expression: /\b(?:sk[-_]|gh[opusr]_)[A-Za-z0-9_-]{12,}\b/gi, keepFirstCapture: false },
  { expression: /\bAKIA[0-9A-Z]{16}\b/g, keepFirstCapture: false },
  {
    expression: /(\b(?:[a-z0-9_-]*api[_-]?key|[a-z0-9_-]*(?:access|refresh|id)[_-]?token|[a-z0-9_-]*client[_-]?secret|authorization|password|secret|token)\s*["']?\s*[:=]\s*["']?)([^"'\s,}]{4,})/gi,
    keepFirstCapture: true,
  },
]

export interface RedactionResult<T> {
  readonly value: T
  readonly count: number
}

function compilePatterns(enabled: boolean, patterns: readonly string[]): RedactionPattern[] {
  if (!enabled) return []
  const compiled = [...BUILTIN_PATTERNS]
  for (const pattern of patterns) {
    try {
      compiled.push({ expression: new RegExp(pattern, 'gi'), keepFirstCapture: false })
    } catch (error: unknown) {
      throw new Error(`invalid cassette redaction pattern "${pattern}"`, { cause: error })
    }
  }
  return compiled
}

/** Recursively redact exact secret keys and configured string patterns. */
export function redactJson<T extends JsonValue>(
  input: T,
  enabled = true,
  customPatterns: readonly string[] = [],
): RedactionResult<T> {
  const patterns = compilePatterns(enabled, customPatterns)
  let count = 0

  const redactString = (value: string): string => {
    let output = value
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0
      output = output.replace(pattern.expression, (_match, firstCapture: string | undefined) => {
        count++
        return pattern.keepFirstCapture && typeof firstCapture === 'string'
          ? `${firstCapture}${REDACTED}`
          : REDACTED
      })
    }
    return output
  }

  type Destination =
    | { readonly kind: 'root' }
    | { readonly kind: 'array'; readonly target: JsonValue[]; readonly index: number }
    | { readonly kind: 'object'; readonly target: Record<string, JsonValue>; readonly key: string }
  interface Task {
    readonly value: JsonValue
    readonly key?: string
    readonly destination: Destination
  }

  let root: JsonValue = null
  const assign = (destination: Destination, value: JsonValue): void => {
    if (destination.kind === 'root') {
      root = value
    } else if (destination.kind === 'array') {
      destination.target[destination.index] = value
    } else {
      Object.defineProperty(destination.target, destination.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }

  const tasks: Task[] = [{ value: input, destination: { kind: 'root' } }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    const { value, key, destination } = task
    if (key !== undefined && enabled && isSecretKey(key)) {
      count++
      assign(destination, REDACTED)
      continue
    }
    if (typeof value === 'string') {
      assign(destination, redactString(value))
      continue
    }
    if (value === null || typeof value !== 'object') {
      assign(destination, value)
      continue
    }
    if (Array.isArray(value)) {
      const result = Array.from({ length: value.length }, (): JsonValue => null)
      assign(destination, result)
      for (let index = value.length - 1; index >= 0; index--) {
        const child = value[index]
        if (child === undefined) throw new TypeError(`redaction input array index ${index} is undefined`)
        tasks.push({ value: child, destination: { kind: 'array', target: result, index } })
      }
      continue
    }
    const result: Record<string, JsonValue> = {}
    assign(destination, result)
    const entries = Object.entries(value)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry === undefined) continue
      const [childKey, child] = entry
      tasks.push({
        value: child,
        key: childKey,
        destination: { kind: 'object', target: result, key: childKey },
      })
    }
  }

  return { value: root as T, count }
}
