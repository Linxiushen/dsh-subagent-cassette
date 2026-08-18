import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { normalizeRequest, requestMetadata, snapshotResult } from './canonical.ts'
import { CassetteError, CassetteRecordedError } from './errors.ts'
import type { CassetteWriter } from './format.ts'
import { redactJson } from './redact.ts'
import { InteractionMatcher, TopologyTracker } from './topology.ts'
import type {
  CassetteInteraction,
  CassetteInteractionBody,
  JsonValue,
  RecordedError,
  ReplayTiming,
  RequestStorage,
  StoredRequest,
} from './types.ts'

function elapsed(started: number): number {
  return Math.max(0, Math.round((performance.now() - started) * 1_000) / 1_000)
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contentStructureObjects(input: JsonValue, rootField: 'prompt' | 'output'): {
  readonly blocks: WeakSet<object>
  readonly attachments: WeakSet<object>
} {
  const blocks = new WeakSet<object>()
  const attachments = new WeakSet<object>()
  if (!isRecord(input)) return { blocks, attachments }
  const root = input[rootField]
  if (!Array.isArray(root)) return { blocks, attachments }
  const pending: JsonValue[][] = [root]
  for (let content = pending.pop(); content !== undefined; content = pending.pop()) {
    for (const value of content) {
      if (!isRecord(value) || typeof value['type'] !== 'string') continue
      blocks.add(value)
      if (value['type'] === 'image' && isRecord(value['attachment'])) {
        attachments.add(value['attachment'])
      }
      if (value['type'] === 'tool-result' && Array.isArray(value['content'])) {
        pending.push(value['content'])
      }
    }
  }
  return { blocks, attachments }
}

function redactBoundary<T extends JsonValue>(
  input: T,
  rootField: 'prompt' | 'output',
  enabled: boolean,
  patterns: readonly string[],
) {
  const structure = contentStructureObjects(input, rootField)
  return redactJson(input, enabled, patterns, {
    preserveString: (parent, key) => (
      (key === 'type' && parent !== undefined && structure.blocks.has(parent))
      || (key === 'mediaType' && parent !== undefined && structure.attachments.has(parent))
    ),
    onPreservedStringMatch: (_parent, key) => {
      throw new CassetteError(
        `redaction pattern matches protected content-block field "${key ?? '<unknown>'}"`,
        'INVALID_CONFIG',
      )
    },
  })
}

function errorFacts(error: unknown, redactSecrets: boolean, patterns: readonly string[]): RecordedError {
  const candidate: RecordedError = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...typeof (error as { code?: unknown } | null)?.code === 'string'
      ? { code: (error as { code: string }).code }
      : {},
  }
  return redactJson(candidate as unknown as JsonValue, redactSecrets, patterns).value as unknown as RecordedError
}

function storedRequest(
  request: ReturnType<typeof normalizeRequest>,
  storage: RequestStorage,
  redactSecrets: boolean,
  patterns: readonly string[],
): StoredRequest {
  if (storage === 'metadata') return { storage, metadata: requestMetadata(request) }
  const redacted = redactBoundary(request as unknown as JsonValue, 'prompt', redactSecrets, patterns)
  return {
    storage,
    value: redacted.value as unknown as ReturnType<typeof normalizeRequest>,
    redactions: redacted.count,
  }
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => { resolvePromise?.() },
    reject: error => { rejectPromise?.(error) },
  }
}

export interface RecordingProviderOptions {
  readonly requestStorage: RequestStorage
  readonly redactSecrets: boolean
  readonly redactionPatterns?: readonly string[]
  readonly isUpstreamAvailable?: () => boolean
}

/** A one-shot provider wrapper that records final subagent boundary outcomes. */
export class RecordingSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities
  readonly inheritsParentContext: boolean
  private readonly topology: TopologyTracker
  private sequence: number
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(
    name: string,
    private readonly upstream: SubagentProvider,
    private readonly writer: CassetteWriter,
    private readonly options: RecordingProviderOptions,
  ) {
    this.name = name
    this.capabilities = { ...upstream.capabilities }
    this.inheritsParentContext = upstream.inheritsParentContext
    this.sequence = writer.nextSequence
    this.topology = new TopologyTracker(upstream.inheritsParentContext, writer.existingInteractions)
    // Compile custom expressions before the provider can admit real work.
    redactJson('', options.redactSecrets, options.redactionPatterns ?? [])
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (this.options.isUpstreamAvailable?.() === false) {
      throw new CassetteError(
        `upstream subagent provider "${this.upstream.name}" is no longer registered`,
        'NO_UPSTREAM',
      )
    }
    this.active++
    try {
      return await this.startTracked(request)
    } catch (error: unknown) {
      this.leave()
      throw error
    }
  }

  private async startTracked(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const patterns = this.options.redactionPatterns ?? []
    const normalizedRequest = normalizeRequest(request)
    const requestView = storedRequest(
      normalizedRequest,
      this.options.requestStorage,
      this.options.redactSecrets,
      patterns,
    )
    const reserved = this.topology.reserve(request, normalizedRequest)
    const sequence = this.sequence++
    const started = performance.now()
    const startedAt = new Date().toISOString()
    let signalAbortedAtMs: number | undefined = request.signal.aborted ? 0 : undefined
    const onAbort = (): void => { signalAbortedAtMs ??= elapsed(started) }
    request.signal.addEventListener('abort', onAbort, { once: true })

    let upstreamRun: SubagentRun
    try {
      upstreamRun = await this.upstream.start(request)
    } catch (error: unknown) {
      const durationMs = elapsed(started)
      request.signal.removeEventListener('abort', onAbort)
      await this.writer.append({
        kind: 'cassette/interaction',
        sequence,
        callKey: reserved.callKey,
        parentKey: reserved.parentKey,
        parentContextFingerprint: reserved.parentContextFingerprint,
        occurrence: reserved.occurrence,
        requestFingerprint: reserved.requestFingerprint,
        request: requestView,
        timing: {
          startedAt,
          startLatencyMs: durationMs,
          durationMs,
          ...(signalAbortedAtMs === undefined ? {} : { signalAbortedAtMs }),
        },
        published: false,
        local: false,
        outcome: {
          kind: 'start-error',
          error: errorFacts(error, this.options.redactSecrets, patterns),
        },
      })
      throw error
    }

    const startLatencyMs = elapsed(started)
    try {
      if (upstreamRun.localAgent !== undefined) {
        this.topology.registerLocalChild(upstreamRun.localAgent, reserved.callKey)
      }
    } catch (error: unknown) {
      await upstreamRun.dispose()
      const durationMs = elapsed(started)
      request.signal.removeEventListener('abort', onAbort)
      await this.writer.append({
        kind: 'cassette/interaction',
        sequence,
        callKey: reserved.callKey,
        parentKey: reserved.parentKey,
        parentContextFingerprint: reserved.parentContextFingerprint,
        occurrence: reserved.occurrence,
        requestFingerprint: reserved.requestFingerprint,
        request: requestView,
        timing: {
          startedAt,
          startLatencyMs,
          durationMs,
          ...(signalAbortedAtMs === undefined ? {} : { signalAbortedAtMs }),
        },
        published: false,
        local: false,
        outcome: {
          kind: 'start-error',
          error: errorFacts(error, this.options.redactSecrets, patterns),
        },
      })
      throw error
    }
    let disposeCalledAtMs: number | undefined
    const recording = deferred()
    void recording.promise.catch(() => {})

    const appendOutcome = async (
      outcome: CassetteInteractionBody['outcome'],
    ): Promise<void> => {
      const durationMs = elapsed(started)
      const body: CassetteInteractionBody = {
        kind: 'cassette/interaction',
        sequence,
        callKey: reserved.callKey,
        parentKey: reserved.parentKey,
        parentContextFingerprint: reserved.parentContextFingerprint,
        occurrence: reserved.occurrence,
        requestFingerprint: reserved.requestFingerprint,
        request: requestView,
        timing: {
          startedAt,
          startLatencyMs,
          durationMs,
          ...(signalAbortedAtMs === undefined ? {} : { signalAbortedAtMs }),
          ...(disposeCalledAtMs === undefined ? {} : { disposeCalledAtMs }),
        },
        published: true,
        local: upstreamRun.localAgent !== undefined,
        outcome,
      }
      await this.writer.append(body)
    }

    const result = (async (): Promise<SubagentResult> => {
      let settled: SubagentResult
      try {
        settled = await upstreamRun.result
      } catch (error: unknown) {
        try {
          await appendOutcome({
            kind: 'result-error',
            error: errorFacts(error, this.options.redactSecrets, patterns),
          })
          recording.resolve()
        } catch (writeError: unknown) {
          recording.reject(writeError)
          throw writeError
        } finally {
          request.signal.removeEventListener('abort', onAbort)
        }
        throw error
      }

      let snapshot: SubagentResult
      let stored: SubagentResult
      let redactionCount: number
      try {
        snapshot = snapshotResult(settled)
        const redacted = redactBoundary(
          snapshot as unknown as JsonValue,
          'output',
          this.options.redactSecrets,
          patterns,
        )
        stored = redacted.value as unknown as SubagentResult
        redactionCount = redacted.count
      } catch (error: unknown) {
        try {
          await appendOutcome({
            kind: 'result-error',
            error: errorFacts(error, this.options.redactSecrets, patterns),
          })
          recording.resolve()
        } catch (writeError: unknown) {
          recording.reject(writeError)
          throw writeError
        } finally {
          request.signal.removeEventListener('abort', onAbort)
        }
        throw error
      }

      try {
        await appendOutcome({ kind: 'result', result: stored, redactions: redactionCount })
        recording.resolve()
      } catch (error: unknown) {
        recording.reject(error)
        throw error
      } finally {
        request.signal.removeEventListener('abort', onAbort)
      }
      return snapshot
    })().finally(() => { this.leave() })

    let disposal: Promise<void> | undefined
    return {
      id: upstreamRun.id,
      localAgent: upstreamRun.localAgent,
      result,
      dispose: (): Promise<void> => {
        if (disposal !== undefined) return disposal
        disposeCalledAtMs ??= elapsed(started)
        disposal = (async (): Promise<void> => {
          const [upstreamDisposal, persistence] = await Promise.allSettled([
            upstreamRun.dispose(),
            recording.promise,
          ])
          if (upstreamDisposal.status === 'rejected' && persistence.status === 'rejected') {
            throw new AggregateError(
              [upstreamDisposal.reason, persistence.reason],
              'upstream disposal and cassette persistence both failed',
            )
          }
          if (upstreamDisposal.status === 'rejected') throw upstreamDisposal.reason
          if (persistence.status === 'rejected') throw persistence.reason
        })()
        return disposal
      },
    }
  }

  /** Resolve after every admitted start has either failed or persisted its terminal outcome. */
  whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.add(resolve) })
  }

  private leave(): void {
    this.active--
    if (this.active !== 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}

function recordedError(interaction: CassetteInteraction): CassetteRecordedError {
  if (interaction.outcome.kind === 'result') {
    return new CassetteRecordedError('invalid recorded result error', 'CassetteError')
  }
  const { name, message, code } = interaction.outcome.error
  return new CassetteRecordedError(message, name, code)
}

function abortResult(): SubagentResult {
  return { output: [], stopReason: 'aborted' }
}

async function waitFor(ms: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new CassetteError('cassette replay delay must be a non-negative finite number', 'INVALID_CONFIG')
  }
  if (signal.aborted) return 'aborted'
  if (ms <= 0) return 'elapsed'
  const maximumTimerDelayMs = 2_147_483_647
  let remaining = ms
  while (remaining > 0) {
    const delay = Math.min(remaining, maximumTimerDelayMs)
    const outcome = await new Promise<'elapsed' | 'aborted'>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve('elapsed')
      }, delay)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve('aborted')
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    if (outcome === 'aborted') return outcome
    remaining -= delay
  }
  return 'elapsed'
}

export interface ReplayProviderOptions {
  readonly timing: ReplayTiming
  readonly speed: number
}

export const MINIMUM_REPLAY_SPEED = 0.001

function scaledDelay(ms: number, scale: number): number {
  const delay = ms * scale
  if (!Number.isFinite(delay)) {
    throw new CassetteError('recorded cassette timing cannot be scaled to a finite delay', 'INVALID_CONFIG')
  }
  return delay
}

/** Offline provider that returns strictly matched cassette outcomes. */
export class ReplaySubagentProvider implements SubagentProvider {
  readonly capabilities
  readonly inheritsParentContext: boolean
  private readonly options: ReplayProviderOptions

  constructor(
    readonly name: string,
    private readonly matcher: InteractionMatcher,
    providerFacts: {
      readonly capabilities: SubagentProvider['capabilities']
      readonly inheritsParentContext: boolean
    },
    options: ReplayProviderOptions,
  ) {
    if (options.timing !== 'instant' && options.timing !== 'recorded') {
      throw new CassetteError('timing must be "instant" or "recorded"', 'INVALID_CONFIG')
    }
    if (!Number.isFinite(options.speed) || options.speed < MINIMUM_REPLAY_SPEED) {
      throw new CassetteError(
        `speed must be a finite number greater than or equal to ${MINIMUM_REPLAY_SPEED}`,
        'INVALID_CONFIG',
      )
    }
    this.capabilities = { ...providerFacts.capabilities }
    this.inheritsParentContext = providerFacts.inheritsParentContext
    this.options = { ...options }
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const interaction = this.matcher.match(request)
    const scale = this.options.timing === 'recorded' ? 1 / this.options.speed : 0
    const startWait = scaledDelay(interaction.timing.startLatencyMs, scale)
    if (await waitFor(startWait, request.signal) === 'aborted') {
      throw new CassetteRecordedError('cassette replay aborted before subagent publication', 'AbortError', 'ABORTED')
    }
    const outcome = interaction.outcome
    if (outcome.kind === 'start-error') throw recordedError(interaction)

    const controller = new AbortController()
    const runSignal = AbortSignal.any([request.signal, controller.signal])
    const remaining = scaledDelay(
      Math.max(0, interaction.timing.durationMs - interaction.timing.startLatencyMs),
      scale,
    )
    const result = (async (): Promise<SubagentResult> => {
      if (await waitFor(remaining, runSignal) === 'aborted') return abortResult()
      if (outcome.kind === 'result-error') throw recordedError(interaction)
      return snapshotResult(outcome.result)
    })()
    const id = SessionId(
      `cassette-${interaction.sequence}-${interaction.requestFingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}-${randomUUID()}`,
    )
    let disposed = false
    return {
      id,
      localAgent: undefined,
      result,
      dispose: async (): Promise<void> => {
        if (!disposed) {
          disposed = true
          controller.abort(new Error('cassette replay run disposed'))
        }
        await result.catch(() => {})
      },
    }
  }
}
