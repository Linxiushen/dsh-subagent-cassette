import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { canonicalStringify, fingerprintJson } from './canonical.ts'
import { CassetteFormatError } from './errors.ts'
import {
  CASSETTE_FORMAT,
  CASSETTE_VERSION,
  TARGET_DSH_SUBAGENT_VERSION,
  type CassetteFile,
  type CassetteHeader,
  type CassetteHeaderBody,
  type CassetteInteraction,
  type CassetteInteractionBody,
  type CassetteSummary,
  type CassetteWriteMode,
  type JsonValue,
} from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CassetteFormatError(`${path} must be a non-empty string`)
  }
}

function assertDigest(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new CassetteFormatError(`${path} must be a lowercase SHA-256 digest`)
  }
}

function assertNonNegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CassetteFormatError(`${path} must be a non-negative finite number`)
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CassetteFormatError(`${path} must be a positive safe integer`)
  }
}

function hashRecord(value: Record<string, unknown>): string {
  return fingerprintJson(value as JsonValue)
}

function headerWithoutHash(header: CassetteHeader): CassetteHeaderBody {
  const { hash: _hash, ...body } = header
  return body
}

function interactionWithoutHash(interaction: CassetteInteraction): CassetteInteractionBody & { previousHash: string } {
  const { hash: _hash, ...body } = interaction
  return body
}

function validateCapabilities(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteFormatError(`${path} must be an object`)
  for (const key of ['outputSchema', 'depthLimit', 'toolFilter', 'persona']) {
    if (typeof value[key] !== 'boolean') throw new CassetteFormatError(`${path}.${key} must be a boolean`)
  }
}

function validateHeader(value: unknown): CassetteHeader {
  if (!isRecord(value)) throw new CassetteFormatError('line 1 must be a cassette header object')
  if (value['kind'] !== 'cassette/header') throw new CassetteFormatError('line 1 is not a cassette header')
  if (value['format'] !== CASSETTE_FORMAT) {
    throw new CassetteFormatError(`unsupported cassette format "${String(value['format'])}"`)
  }
  if (value['version'] !== CASSETTE_VERSION) {
    throw new CassetteFormatError(`unsupported cassette schema version ${String(value['version'])}`)
  }
  assertString(value['cassetteId'], 'header.cassetteId')
  assertString(value['createdAt'], 'header.createdAt')
  if (!Number.isFinite(Date.parse(value['createdAt']))) {
    throw new CassetteFormatError('header.createdAt must be an ISO timestamp')
  }
  const target = value['target']
  if (!isRecord(target) || target['dshSubagent'] !== TARGET_DSH_SUBAGENT_VERSION) {
    throw new CassetteFormatError(
      `cassette targets @deepseek-ai/dsh-subagent ${String(isRecord(target) ? target['dshSubagent'] : undefined)}, `
      + `expected ${TARGET_DSH_SUBAGENT_VERSION}`,
    )
  }
  const provider = value['provider']
  if (!isRecord(provider)) throw new CassetteFormatError('header.provider must be an object')
  assertString(provider['cassette'], 'header.provider.cassette')
  assertString(provider['upstream'], 'header.provider.upstream')
  validateCapabilities(provider['capabilities'], 'header.provider.capabilities')
  if (typeof provider['inheritsParentContext'] !== 'boolean') {
    throw new CassetteFormatError('header.provider.inheritsParentContext must be a boolean')
  }
  if (value['requestStorage'] !== 'metadata' && value['requestStorage'] !== 'full') {
    throw new CassetteFormatError('header.requestStorage must be "metadata" or "full"')
  }
  if (typeof value['redactSecrets'] !== 'boolean') {
    throw new CassetteFormatError('header.redactSecrets must be a boolean')
  }
  if (!Array.isArray(value['redactionPatterns'])
    || value['redactionPatterns'].some(pattern => typeof pattern !== 'string')) {
    throw new CassetteFormatError('header.redactionPatterns must be an array of strings')
  }
  assertDigest(value['hash'], 'header.hash')
  const header = value as unknown as CassetteHeader
  const expected = hashRecord(headerWithoutHash(header) as unknown as Record<string, unknown>)
  if (header.hash !== expected) throw new CassetteFormatError('header hash mismatch')
  return header
}

function validateRecordedError(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteFormatError(`${path} must be an object`)
  assertString(value['name'], `${path}.name`)
  if (typeof value['message'] !== 'string') throw new CassetteFormatError(`${path}.message must be a string`)
  if (value['code'] !== undefined && typeof value['code'] !== 'string') {
    throw new CassetteFormatError(`${path}.code must be a string when present`)
  }
}

function validateOutcome(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteFormatError(`${path} must be an object`)
  if (value['kind'] === 'start-error' || value['kind'] === 'result-error') {
    validateRecordedError(value['error'], `${path}.error`)
    return
  }
  if (value['kind'] !== 'result') throw new CassetteFormatError(`${path}.kind is unsupported`)
  assertNonNegative(value['redactions'], `${path}.redactions`)
  const result = value['result']
  if (!isRecord(result) || !Array.isArray(result['output']) || typeof result['stopReason'] !== 'string') {
    throw new CassetteFormatError(`${path}.result must contain output[] and stopReason`)
  }
}

function validateStoredRequest(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteFormatError(`${path} must be an object`)
  if (value['storage'] === 'metadata') {
    if (!isRecord(value['metadata'])) throw new CassetteFormatError(`${path}.metadata must be an object`)
    return
  }
  if (value['storage'] === 'full') {
    if (!isRecord(value['value'])) throw new CassetteFormatError(`${path}.value must be an object`)
    assertNonNegative(value['redactions'], `${path}.redactions`)
    return
  }
  throw new CassetteFormatError(`${path}.storage must be "metadata" or "full"`)
}

function validateInteraction(value: unknown, line: number, expectedPreviousHash: string): CassetteInteraction {
  const path = `line ${line}`
  if (!isRecord(value) || value['kind'] !== 'cassette/interaction') {
    throw new CassetteFormatError(`${path} is not a cassette interaction`)
  }
  assertPositiveInteger(value['sequence'], `${path}.sequence`)
  assertString(value['callKey'], `${path}.callKey`)
  assertString(value['parentKey'], `${path}.parentKey`)
  assertDigest(value['parentContextFingerprint'], `${path}.parentContextFingerprint`)
  assertPositiveInteger(value['occurrence'], `${path}.occurrence`)
  assertDigest(value['requestFingerprint'], `${path}.requestFingerprint`)
  validateStoredRequest(value['request'], `${path}.request`)
  const timing = value['timing']
  if (!isRecord(timing)) throw new CassetteFormatError(`${path}.timing must be an object`)
  assertString(timing['startedAt'], `${path}.timing.startedAt`)
  assertNonNegative(timing['startLatencyMs'], `${path}.timing.startLatencyMs`)
  assertNonNegative(timing['durationMs'], `${path}.timing.durationMs`)
  if ((timing['durationMs'] as number) < (timing['startLatencyMs'] as number)) {
    throw new CassetteFormatError(`${path}.timing.durationMs cannot be less than startLatencyMs`)
  }
  if (timing['signalAbortedAtMs'] !== undefined) {
    assertNonNegative(timing['signalAbortedAtMs'], `${path}.timing.signalAbortedAtMs`)
  }
  if (timing['disposeCalledAtMs'] !== undefined) {
    assertNonNegative(timing['disposeCalledAtMs'], `${path}.timing.disposeCalledAtMs`)
  }
  if (typeof value['published'] !== 'boolean' || typeof value['local'] !== 'boolean') {
    throw new CassetteFormatError(`${path}.published and ${path}.local must be booleans`)
  }
  validateOutcome(value['outcome'], `${path}.outcome`)
  const outcome = value['outcome'] as Record<string, unknown>
  if (outcome['kind'] === 'start-error' && value['published'] !== false) {
    throw new CassetteFormatError(`${path} start-error must be unpublished`)
  }
  if (outcome['kind'] !== 'start-error' && value['published'] !== true) {
    throw new CassetteFormatError(`${path} post-publication outcome must be published`)
  }
  if (value['local'] === true && value['published'] !== true) {
    throw new CassetteFormatError(`${path} an unpublished interaction cannot be local`)
  }
  assertDigest(value['previousHash'], `${path}.previousHash`)
  assertDigest(value['hash'], `${path}.hash`)
  if (value['previousHash'] !== expectedPreviousHash) {
    throw new CassetteFormatError(`${path} hash chain points to the wrong previous record`)
  }
  const interaction = value as unknown as CassetteInteraction
  const expectedHash = hashRecord(interactionWithoutHash(interaction) as unknown as Record<string, unknown>)
  if (interaction.hash !== expectedHash) throw new CassetteFormatError(`${path} hash mismatch`)
  return interaction
}

/** Parse and verify a complete cassette JSONL document. */
export function parseCassette(text: string, source?: string): CassetteFile {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0) throw new CassetteFormatError('cassette is empty')
  const parseLine = (line: string, index: number): unknown => {
    try {
      return JSON.parse(line)
    } catch (error: unknown) {
      throw new CassetteFormatError(`line ${index + 1} is not valid JSON`, { cause: error })
    }
  }
  const first = lines[0]
  if (first === undefined) throw new CassetteFormatError('cassette is empty')
  const header = validateHeader(parseLine(first, 0))
  const interactions: CassetteInteraction[] = []
  const sequences = new Set<number>()
  const callKeys = new Set<string>()
  const occurrences = new Map<string, Set<number>>()
  let previousHash = header.hash
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined) continue
    const interaction = validateInteraction(parseLine(line, index), index + 1, previousHash)
    if (sequences.has(interaction.sequence)) {
      throw new CassetteFormatError(`line ${index + 1} duplicates sequence ${interaction.sequence}`)
    }
    if (callKeys.has(interaction.callKey)) {
      throw new CassetteFormatError(`line ${index + 1} duplicates call key "${interaction.callKey}"`)
    }
    sequences.add(interaction.sequence)
    callKeys.add(interaction.callKey)
    const groupKey = `${interaction.parentKey}\0${interaction.parentContextFingerprint}\0${interaction.requestFingerprint}`
    const group = occurrences.get(groupKey) ?? new Set<number>()
    if (group.has(interaction.occurrence)) {
      throw new CassetteFormatError(
        `line ${index + 1} duplicates occurrence ${interaction.occurrence} for one parent-context/request group`,
      )
    }
    group.add(interaction.occurrence)
    occurrences.set(groupKey, group)
    interactions.push(interaction)
    previousHash = interaction.hash
  }
  for (let sequence = 1; sequence <= sequences.size; sequence++) {
    if (!sequences.has(sequence)) throw new CassetteFormatError(`cassette is missing sequence ${sequence}`)
  }
  for (const group of occurrences.values()) {
    for (let occurrence = 1; occurrence <= group.size; occurrence++) {
      if (!group.has(occurrence)) {
        throw new CassetteFormatError(`cassette parent-context/request group is missing occurrence ${occurrence}`)
      }
    }
  }
  return { header, interactions, ...(source === undefined ? {} : { source }) }
}

/** Read, parse, and verify a cassette file. */
export async function loadCassette(path: string): Promise<CassetteFile> {
  const absolute = resolve(path)
  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error: unknown) {
    throw new CassetteFormatError(`cannot read cassette "${absolute}"`, { cause: error })
  }
  return parseCassette(text, absolute)
}

/** Return duplicate request groups whose recorded outcomes are not identical. */
export function ambiguousGroups(cassette: CassetteFile): string[] {
  const groups = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const interaction of cassette.interactions) {
    const key = `${interaction.parentKey}\0${interaction.parentContextFingerprint}\0${interaction.requestFingerprint}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    let outcomes = groups.get(key)
    if (outcomes === undefined) {
      outcomes = new Set()
      groups.set(key, outcomes)
    }
    outcomes.add(canonicalStringify(interaction.outcome as unknown as JsonValue))
  }
  return [...groups.entries()]
    .filter(([key, outcomes]) => (counts.get(key) ?? 0) > 1 && outcomes.size > 1)
    .map(([key]) => key)
}

/** Produce a stable human/CLI summary without exposing prompts or outputs. */
export function summarizeCassette(cassette: CassetteFile): CassetteSummary {
  let completed = 0
  let failed = 0
  let aborted = 0
  let redactedResults = 0
  let durationMs = 0
  for (const interaction of cassette.interactions) {
    durationMs = Math.max(durationMs, interaction.timing.durationMs)
    if (interaction.outcome.kind !== 'result') {
      failed++
      continue
    }
    if (interaction.outcome.redactions > 0) redactedResults++
    if (interaction.outcome.result.stopReason === 'completed') completed++
    else if (interaction.outcome.result.stopReason === 'aborted') aborted++
    else failed++
  }
  return {
    ...(cassette.source === undefined ? {} : { file: cassette.source }),
    cassetteId: cassette.header.cassetteId,
    provider: cassette.header.provider,
    interactions: cassette.interactions.length,
    completed,
    failed,
    aborted,
    ambiguousGroups: ambiguousGroups(cassette).length,
    redactedResults,
    durationMs,
  }
}

export interface CreateHeaderOptions {
  readonly cassette: string
  readonly upstream: string
  readonly capabilities: CassetteHeaderBody['provider']['capabilities']
  readonly inheritsParentContext: boolean
  readonly requestStorage: CassetteHeaderBody['requestStorage']
  readonly redactSecrets: boolean
  readonly redactionPatterns?: readonly string[]
}

/** Create a new versioned cassette header and its integrity hash. */
export function createHeader(options: CreateHeaderOptions): CassetteHeader {
  const body: CassetteHeaderBody = {
    kind: 'cassette/header',
    format: CASSETTE_FORMAT,
    version: CASSETTE_VERSION,
    cassetteId: randomUUID(),
    createdAt: new Date().toISOString(),
    target: { dshSubagent: TARGET_DSH_SUBAGENT_VERSION },
    provider: {
      cassette: options.cassette,
      upstream: options.upstream,
      capabilities: { ...options.capabilities },
      inheritsParentContext: options.inheritsParentContext,
    },
    requestStorage: options.requestStorage,
    redactSecrets: options.redactSecrets,
    redactionPatterns: [...(options.redactionPatterns ?? [])],
  }
  return { ...body, hash: hashRecord(body as unknown as Record<string, unknown>) }
}

function assertAppendCompatible(actual: CassetteHeader, requested: CassetteHeader): void {
  const fields: Array<[string, unknown, unknown]> = [
    ['provider.cassette', actual.provider.cassette, requested.provider.cassette],
    ['provider.upstream', actual.provider.upstream, requested.provider.upstream],
    ['provider.capabilities', actual.provider.capabilities, requested.provider.capabilities],
    ['provider.inheritsParentContext', actual.provider.inheritsParentContext, requested.provider.inheritsParentContext],
    ['requestStorage', actual.requestStorage, requested.requestStorage],
    ['redactSecrets', actual.redactSecrets, requested.redactSecrets],
    ['redactionPatterns', actual.redactionPatterns, requested.redactionPatterns],
  ]
  for (const [name, existing, expected] of fields) {
    if (canonicalStringify(existing as JsonValue) !== canonicalStringify(expected as JsonValue)) {
      throw new CassetteFormatError(`cannot append: existing header ${name} differs from configured value`)
    }
  }
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error['code'] : undefined
}

class CassetteWriterLock {
  private releasePromise: Promise<void> | undefined

  constructor(
    readonly path: string,
    private readonly ownerPath: string,
  ) {}

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOnce()
    return this.releasePromise
  }

  private async releaseOnce(): Promise<void> {
    try {
      await unlink(this.ownerPath)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return
      throw new CassetteFormatError(`cannot release cassette writer lock "${this.path}"`, { cause: error })
    }

    try {
      await rmdir(this.path)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return
      throw new CassetteFormatError(
        `cannot release cassette writer lock "${this.path}"; the lock directory contains unowned data`,
        { cause: error },
      )
    }
  }
}

async function resolveWriterLockPath(absolute: string): Promise<string> {
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(absolute)
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      throw new CassetteFormatError(`cannot resolve cassette path "${absolute}" for writing`, { cause: error })
    }
    try {
      canonicalTarget = join(await realpath(dirname(absolute)), basename(absolute))
    } catch (parentError: unknown) {
      throw new CassetteFormatError(`cannot resolve cassette path "${absolute}" for writing`, { cause: parentError })
    }
  }
  return `${canonicalTarget}.writer.lock`
}

async function acquireWriterLock(absolute: string): Promise<CassetteWriterLock> {
  const lockPath = await resolveWriterLockPath(absolute)
  try {
    await mkdir(lockPath)
  } catch (error: unknown) {
    const detail = errorCode(error) === 'EEXIST'
      ? '; another writer may be active (remove a stale lock only after confirming no writer is using it)'
      : ''
    throw new CassetteFormatError(`cannot acquire cassette writer lock "${lockPath}"${detail}`, { cause: error })
  }

  const ownerToken = randomUUID()
  const ownerPath = join(lockPath, `${ownerToken}.json`)
  let ownerHandle: FileHandle | undefined
  let ownsMarker = false
  try {
    ownerHandle = await open(ownerPath, 'wx')
    ownsMarker = true
    await ownerHandle.writeFile(`${JSON.stringify({ ownerToken, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    await ownerHandle.close()
    ownerHandle = undefined
    return new CassetteWriterLock(lockPath, ownerPath)
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = []
    if (ownerHandle !== undefined) {
      try {
        await ownerHandle.close()
      } catch (closeError: unknown) {
        cleanupErrors.push(closeError)
      }
    }
    if (ownsMarker) {
      try {
        await unlink(ownerPath)
      } catch (unlinkError: unknown) {
        if (errorCode(unlinkError) !== 'ENOENT') cleanupErrors.push(unlinkError)
      }
    }
    try {
      await rmdir(lockPath)
    } catch (removeError: unknown) {
      if (errorCode(removeError) !== 'ENOENT' && errorCode(removeError) !== 'ENOTEMPTY') {
        cleanupErrors.push(removeError)
      }
    }
    const cause = cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], 'writer lock initialization and cleanup failed')
    throw new CassetteFormatError(`cannot initialize cassette writer lock "${lockPath}"`, { cause })
  }
}

/** Serialized append-only writer with a SHA-256 record chain. */
export class CassetteWriter {
  readonly path: string
  readonly header: CassetteHeader
  readonly nextSequence: number
  readonly existingInteractions: readonly CassetteInteraction[]
  private readonly handle: FileHandle
  private readonly lock: CassetteWriterLock
  private previousHash: string
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private closePromise: Promise<void> | undefined

  private constructor(
    path: string,
    handle: FileHandle,
    lock: CassetteWriterLock,
    header: CassetteHeader,
    previousHash: string,
    nextSequence: number,
    existingInteractions: readonly CassetteInteraction[],
  ) {
    this.path = path
    this.handle = handle
    this.lock = lock
    this.header = header
    this.previousHash = previousHash
    this.nextSequence = nextSequence
    this.existingInteractions = existingInteractions
  }

  static async open(path: string, requestedHeader: CassetteHeader, mode: CassetteWriteMode): Promise<CassetteWriter> {
    const absolute = resolve(path)
    await mkdir(dirname(absolute), { recursive: true })
    const lock = await acquireWriterLock(absolute)
    try {
      if (mode === 'append') {
        try {
          const existing = await loadCassette(absolute)
          assertAppendCompatible(existing.header, requestedHeader)
          const last = existing.interactions.at(-1)
          const handle = await open(absolute, 'a+')
          try {
            const stats = await handle.stat()
            if (stats.size > 0) {
              const trailing = Buffer.allocUnsafe(1)
              const { bytesRead } = await handle.read(trailing, 0, 1, stats.size - 1)
              if (bytesRead !== 1) throw new Error('could not read cassette trailing byte')
              if (trailing[0] !== 0x0a) await handle.write('\n')
            }
          } catch (error: unknown) {
            await handle.close().catch(() => {})
            throw new CassetteFormatError(`cannot prepare cassette "${absolute}" for append`, { cause: error })
          }
          const nextSequence = existing.interactions.reduce(
            (maximum, interaction) => Math.max(maximum, interaction.sequence),
            0,
          ) + 1
          return new CassetteWriter(
            absolute,
            handle,
            lock,
            existing.header,
            last?.hash ?? existing.header.hash,
            nextSequence,
            existing.interactions,
          )
        } catch (error: unknown) {
          const code = isRecord(error) ? error['code'] : undefined
          const cause = isRecord(error) ? error['cause'] : undefined
          if (code !== 'CASSETTE_FORMAT' || !isRecord(cause) || cause['code'] !== 'ENOENT') throw error
          // A missing append target starts a new cassette.
        }
      }
      const flag = mode === 'truncate' ? 'w' : 'wx'
      let handle: FileHandle
      try {
        handle = await open(absolute, flag)
      } catch (error: unknown) {
        throw new CassetteFormatError(`cannot open cassette "${absolute}" in ${mode} mode`, { cause: error })
      }
      try {
        await handle.writeFile(`${canonicalStringify(requestedHeader as unknown as JsonValue)}\n`, 'utf8')
        await handle.sync()
        return new CassetteWriter(absolute, handle, lock, requestedHeader, requestedHeader.hash, 1, [])
      } catch (error: unknown) {
        await handle.close().catch(() => {})
        throw new CassetteFormatError(`cannot initialize cassette "${absolute}"`, { cause: error })
      }
    } catch (error: unknown) {
      try {
        await lock.release()
      } catch (releaseError: unknown) {
        throw new CassetteFormatError(`cannot open cassette "${absolute}" and release its writer lock`, {
          cause: new AggregateError([error, releaseError], 'cassette open and writer lock release failed'),
        })
      }
      throw error
    }
  }

  append(body: CassetteInteractionBody): Promise<void> {
    if (this.closed) return Promise.reject(new CassetteFormatError('cassette writer is closed'))
    const task = this.queue.then(async () => {
      const unhashed = { ...body, previousHash: this.previousHash }
      const interaction: CassetteInteraction = {
        ...unhashed,
        hash: hashRecord(unhashed as unknown as Record<string, unknown>),
      }
      await this.handle.write(`${canonicalStringify(interaction as unknown as JsonValue)}\n`)
      this.previousHash = interaction.hash
    })
    this.queue = task
    return task
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closed = true
    this.closePromise = this.closeOnce()
    return this.closePromise
  }

  private async closeOnce(): Promise<void> {
    const errors: unknown[] = []
    try {
      await this.queue
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.handle.sync()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.handle.close()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.lock.release()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `cannot close cassette writer "${this.path}"`)
  }
}

/** Expand the bundle's collision-resistant path tokens. */
export function resolveCassettePath(path: string, now = new Date(), pid = process.pid): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('.', '')
  return resolve(path.replaceAll('{timestamp}', timestamp).replaceAll('{pid}', String(pid)))
}
