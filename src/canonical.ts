import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  deriveEventMessage,
  foldSurface,
  snapshotJsonValue,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {
  JsonValue,
  NormalizedParentContext,
  NormalizedSubagentRequest,
  NormalizedToolFilter,
  RequestMetadata,
} from './types.ts'

/** Serialize plain JSON with lexicographically sorted object keys. */
export function canonicalStringify(value: JsonValue): string {
  type Task = { readonly kind: 'value'; readonly value: JsonValue } | { readonly kind: 'raw'; readonly text: string }
  const output: string[] = []
  const tasks: Task[] = [{ kind: 'value', value }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'raw') {
      output.push(task.text)
      continue
    }
    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      output.push(JSON.stringify(current))
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError('canonical JSON contains a non-lossless number')
      }
      output.push(JSON.stringify(current))
      continue
    }
    if (Array.isArray(current)) {
      output.push('[')
      tasks.push({ kind: 'raw', text: ']' })
      for (let index = current.length - 1; index >= 0; index--) {
        const child = current[index]
        if (child === undefined) throw new TypeError(`canonical JSON array index ${index} is undefined`)
        tasks.push({ kind: 'value', value: child })
        if (index > 0) tasks.push({ kind: 'raw', text: ',' })
      }
      continue
    }
    output.push('{')
    tasks.push({ kind: 'raw', text: '}' })
    const keys = Object.keys(current).sort()
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) continue
      const child = current[key]
      if (child === undefined) throw new TypeError(`canonical JSON object field "${key}" is undefined`)
      tasks.push({ kind: 'value', value: child })
      tasks.push({ kind: 'raw', text: ':' })
      tasks.push({ kind: 'raw', text: JSON.stringify(key) })
      if (index > 0) tasks.push({ kind: 'raw', text: ',' })
    }
  }
  return output.join('')
}

function normalizeToolFilter(value: unknown): NormalizedToolFilter | undefined {
  if (value === undefined) return
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('subagent cassette toolFilter must be an object')
  }
  const filter = value as Record<string, unknown>
  const extra = Object.keys(filter).find(field => field !== 'allow' && field !== 'deny')
  if (extra !== undefined) {
    throw new TypeError(`subagent cassette toolFilter.${extra} is not supported`)
  }
  const projection: { allow?: string[]; deny?: string[] } = {}
  for (const field of ['allow', 'deny']) {
    const names = filter[field]
    if (names === undefined) continue
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new TypeError(`subagent cassette toolFilter.${field} must be an array of strings`)
    }
    if (field === 'allow') projection.allow = [...names]
    else projection.deny = [...names]
  }
  return projection
}

/** SHA-256 digest over canonical JSON. */
export function fingerprintJson(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`
}

/** Snapshot the stable, serializable fields of a DSH subagent request. */
export function normalizeRequest(request: ResolvedSubagentStartRequest): NormalizedSubagentRequest {
  const candidate = {
    ...(request.label === undefined ? {} : { label: request.label }),
    prompt: request.prompt,
    ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
    ...(request.toolFilter === undefined ? {} : { toolFilter: request.toolFilter }),
    ...(request.persona === undefined ? {} : { persona: request.persona }),
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new TypeError('subagent cassette request is not lossless plain JSON')
  }
  const normalized = snapshot as unknown as NormalizedSubagentRequest
  const toolFilter = normalizeToolFilter(normalized.toolFilter)
  return {
    ...normalized,
    ...(toolFilter === undefined ? {} : { toolFilter }),
  }
}

/** Fingerprint a request without its signal, parent identity, or generated descriptor provider. */
export function fingerprintRequest(request: NormalizedSubagentRequest): string {
  return fingerprintJson(request as unknown as JsonValue)
}

interface ContextServiceLookup {
  get(name: string): unknown
}

function contextService(parent: Agent, name: string): unknown {
  const ctx = parent.ctx as unknown as Partial<ContextServiceLookup> | undefined
  return typeof ctx?.get === 'function' ? ctx.get.call(parent.ctx, name) : undefined
}

function serviceMethod(
  service: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (service === null || typeof service !== 'object') return
  const method = (service as Record<string, unknown>)[name]
  if (typeof method !== 'function') return
  return (...args: unknown[]) => Reflect.apply(method, service, args)
}

function latestRequestHeader(events: readonly SessionEvent[]): JsonValue | undefined {
  const event = events.findLast(candidate => candidate.type === 'request/header')
  if (event === undefined) return
  const candidate = {
    ...(event.data.header.system === undefined ? {} : { system: event.data.header.system }),
    ...(event.data.header.tools === undefined ? {} : { tools: event.data.header.tools }),
  }
  return snapshotJsonValue(candidate) as unknown as JsonValue
}

function stableCallId(raw: string, ids: Map<string, string>): string {
  const known = ids.get(raw)
  if (known !== undefined) return known
  const stable = `call-${ids.size + 1}`
  ids.set(raw, stable)
  return stable
}

function normalizeMessage(message: unknown, callIds: Map<string, string>): JsonValue {
  const snapshot = snapshotJsonValue(message)
  if (snapshot === undefined || snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    throw new TypeError('parent context contains a non-JSON model message')
  }
  const normalized = snapshot as Record<string, JsonValue>
  delete normalized['id']

  const source = normalized['source']
  if (source !== null && typeof source === 'object' && !Array.isArray(source)
    && source['kind'] === 'tool' && typeof source['callId'] === 'string') {
    source['callId'] = stableCallId(source['callId'], callIds)
  }

  const content = normalized['content']
  const blocks = Array.isArray(content) ? [...content].reverse() : []
  for (let block = blocks.pop(); block !== undefined; block = blocks.pop()) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block['type'] === 'tool-call' && typeof block['id'] === 'string') {
      block['id'] = stableCallId(block['id'], callIds)
    } else if (block['type'] === 'tool-result') {
      if (typeof block['toolCallId'] === 'string') {
        block['toolCallId'] = stableCallId(block['toolCallId'], callIds)
      }
      const nested = block['content']
      if (Array.isArray(nested)) {
        for (let index = nested.length - 1; index >= 0; index--) {
          const child = nested[index]
          if (child !== undefined) blocks.push(child)
        }
      }
    }
  }
  return normalized
}

function completedTurnPrefix(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  return lastEnd === undefined ? [] : events.slice(0, lastEnd.seq + 1)
}

function completedTurnMessages(prefix: readonly SessionEvent[]): JsonValue[] {
  if (prefix.length === 0) return []
  const surface = foldSurface(prefix)
  const callIds = new Map<string, string>()
  const messages: JsonValue[] = []
  for (const seq of surface.nodes) {
    const event = prefix[seq]
    if (event === undefined || event.seq !== seq) {
      throw new TypeError(`parent context has no event at surface sequence ${seq}`)
    }
    const message = deriveEventMessage(event)
    if (message !== null) messages.push(normalizeMessage(message, callIds))
  }
  return messages
}

/** Snapshot parent state that official in-process providers can carry into a child. */
export function normalizeParentContext(
  parent: Agent,
  inheritsParentContext: boolean,
): NormalizedParentContext {
  // Production Sessions always expose events. The fallback keeps structural
  // Agent test doubles and third-party seam implementations deterministic.
  const sessionEvents = (parent.session as { readonly events?: readonly SessionEvent[] }).events
  const events = Array.isArray(sessionEvents) ? sessionEvents : []
  const inheritedPrefix = inheritsParentContext ? completedTurnPrefix(events) : []
  const requestHeader = inheritsParentContext ? latestRequestHeader(inheritedPrefix) : undefined
  const options = snapshotJsonValue(parent.options)
  if (options === undefined) throw new TypeError('parent Agent options are not lossless plain JSON')

  const presetService = contextService(parent, 'agentPresets')
  const composedPreset = serviceMethod(presetService, 'composedPreset')?.(parent.ctx)
  if (composedPreset !== undefined && typeof composedPreset !== 'string') {
    throw new TypeError('parent Agent composed preset is not a string')
  }

  const sandboxService = contextService(parent, 'sandboxPolicy')
  const sandboxMode = serviceMethod(sandboxService, 'overrideOf')?.(parent.session)
  const approvalPolicy = contextService(parent, 'approval') === undefined ? undefined : 'never'
  const header = parent.session.header
  const composition = {
    ...(composedPreset === undefined ? {} : { agentPreset: composedPreset }),
    ...(requestHeader === undefined ? {} : requestHeader as Record<string, JsonValue>),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  }
  const candidate = {
    options,
    session: {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    },
    ...(Object.keys(composition).length === 0 ? {} : { composition }),
    ...(inheritsParentContext ? { inheritedMessages: completedTurnMessages(inheritedPrefix) } : {}),
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) throw new TypeError('parent context is not lossless plain JSON')
  return snapshot as unknown as NormalizedParentContext
}

/** SHA-256 digest of stable parent state that can affect the child. */
export function fingerprintParentContext(context: NormalizedParentContext): string {
  return fingerprintJson({
    kind: 'dsh-subagent/parent-context',
    value: context as unknown as JsonValue,
  })
}

/** Build a low-sensitivity request view suitable for the default cassette. */
export function requestMetadata(request: NormalizedSubagentRequest): RequestMetadata {
  const agentOptions = request.agentOptions
  const options = agentOptions !== null && typeof agentOptions === 'object' && !Array.isArray(agentOptions)
    ? agentOptions
    : undefined
  const provider = options?.['provider']
  const model = options?.['model']
  const toolFilter = normalizeToolFilter(request.toolFilter)
  return {
    ...(request.label === undefined ? {} : { label: request.label }),
    promptBlocks: request.prompt.length,
    promptBytes: Buffer.byteLength(canonicalStringify(request.prompt as unknown as JsonValue), 'utf8'),
    hasOutputSchema: request.outputSchema !== undefined,
    ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
    ...(typeof provider === 'string' ? { childProvider: provider } : {}),
    ...(typeof model === 'string' ? { childModel: model } : {}),
    ...(toolFilter === undefined ? {} : { toolFilter }),
    hasPersona: request.persona !== undefined,
  }
}

/** Detach a DSH result at the persistence boundary. */
export function snapshotResult<T>(value: T, label = 'subagent cassette result'): T {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError(`${label} is not lossless plain JSON`)
  return snapshot
}
