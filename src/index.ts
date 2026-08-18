import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CassetteWriter,
  createHeader,
  loadCassette,
  resolveCassettePath,
} from './format.ts'
import { CassetteError } from './errors.ts'
import {
  RecordingSubagentProvider,
  ReplaySubagentProvider,
} from './provider.ts'
import { redactJson } from './redact.ts'
import { InteractionMatcher } from './topology.ts'
import type {
  CassetteMode,
  CassetteWriteMode,
  DuplicatePolicy,
  InstallConfig,
  ReplayTiming,
  RequestStorage,
} from './types.ts'

export {
  CassetteAmbiguityError,
  CassetteError,
  CassetteFormatError,
  CassetteMismatchError,
  CassetteRecordedError,
} from './errors.ts'
export type { CassetteMismatchErrorOptions } from './errors.ts'
export { diffCassettes } from './diff.ts'
export type {
  CassetteBoundaryChangedCall,
  CassetteCallIdentity,
  CassetteCallSummary,
  CassetteChangedCall,
  CassetteComparisonIssue,
  CassetteDiff,
  CassettePolicyField,
  CassetteTimingDelta,
} from './diff.ts'
export {
  ambiguousGroups,
  CassetteWriter,
  createHeader,
  loadCassette,
  parseCassette,
  resolveCassettePath,
  summarizeCassette,
} from './format.ts'
export {
  RecordingSubagentProvider,
  ReplaySubagentProvider,
} from './provider.ts'
export { InteractionMatcher, TopologyTracker } from './topology.ts'
export {
  CASSETTE_FORMAT,
  CASSETTE_VERSION,
  TARGET_DSH_SUBAGENT_VERSION,
} from './types.ts'
export type {
  CassetteFile,
  CassetteHeader,
  CassetteInteraction,
  CassetteDiagnostic,
  CassetteDiagnosticCandidate,
  CassetteDiagnosticRequest,
  CassetteMatchDiagnostic,
  CassetteMode,
  CassetteMismatchDiagnostic,
  CassetteMismatchReason,
  CassetteSummary,
  CassetteWriteMode,
  DuplicatePolicy,
  InstallConfig,
  RecordConfig,
  ReplayConfig,
  ReplayTiming,
  RequestStorage,
} from './types.ts'

export const name = 'subagent-cassette'
export const inject = ['subagents']

export interface Config {
  mode?: CassetteMode
  provider?: string
  upstreamProvider?: string
  file?: string
  writeMode?: CassetteWriteMode
  requestStorage?: RequestStorage
  redactSecrets?: boolean
  redactionPatterns?: string[]
  timing?: ReplayTiming
  speed?: number
  duplicatePolicy?: DuplicatePolicy
  allowRedactedReplay?: boolean
  assertConsumed?: boolean
}

export const Config: z<Config> = z.object({
  mode: z.union(['record', 'replay'] as const).default('record'),
  provider: z.string().default('cassette'),
  upstreamProvider: z.string().default('spawn'),
  file: z.string().default('.dsh-cassettes/subagents-{timestamp}-{pid}.cassette.jsonl'),
  writeMode: z.union(['create', 'append', 'truncate'] as const).default('create'),
  requestStorage: z.union(['metadata', 'full'] as const).default('metadata'),
  redactSecrets: z.boolean().default(true),
  redactionPatterns: z.array(z.string()).default([]),
  timing: z.union(['instant', 'recorded'] as const).default('instant'),
  speed: z.number().min(0.001).default(1),
  duplicatePolicy: z.union(['reject', 'sequence'] as const).default('reject'),
  allowRedactedReplay: z.boolean().default(false),
  assertConsumed: z.boolean().default(true),
})

export interface CassetteHandle {
  readonly mode: CassetteMode
  readonly providerName: string
  readonly file: string
  assertConsumed(): void
  dispose(): Promise<void>
}

function normalizedName(value: string | undefined, fallback: string, field: string): string {
  const resolved = value ?? fallback
  if (resolved.length === 0 || resolved !== resolved.trim()) {
    throw new CassetteError(`${field} must be a non-empty normalized string`, 'INVALID_CONFIG')
  }
  return resolved
}

/** Install a record or replay provider into an already-mounted DSH context. */
export async function installCassette(ctx: Context, config: InstallConfig): Promise<CassetteHandle> {
  const providerName = normalizedName(config.provider, 'cassette', 'provider')
  if (config.file.length === 0 || config.file !== config.file.trim()) {
    throw new CassetteError('file must be a non-empty normalized path', 'INVALID_CONFIG')
  }
  const redactSecrets = config.redactSecrets ?? true
  const redactionPatterns = config.redactionPatterns ?? []
  let disposal: Promise<void> | undefined

  if (config.mode === 'record') {
    const upstreamName = normalizedName(config.upstreamProvider, 'spawn', 'upstreamProvider')
    if (upstreamName === providerName) {
      throw new CassetteError('provider and upstreamProvider must be different', 'INVALID_CONFIG')
    }
    const upstream = ctx.subagents.getProvider(upstreamName)
    if (upstream === undefined) {
      throw new CassetteError(`no upstream subagent provider registered for "${upstreamName}"`, 'NO_UPSTREAM')
    }
    redactJson('', redactSecrets, redactionPatterns)
    const path = resolveCassettePath(config.file)
    const header = createHeader({
      cassette: providerName,
      upstream: upstreamName,
      capabilities: upstream.capabilities,
      inheritsParentContext: upstream.inheritsParentContext,
      requestStorage: config.requestStorage ?? 'metadata',
      redactSecrets,
      redactionPatterns,
    })
    const writer = await CassetteWriter.open(path, header, config.writeMode ?? 'create')
    const provider = new RecordingSubagentProvider(providerName, upstream, writer, {
      requestStorage: config.requestStorage ?? 'metadata',
      redactSecrets,
      redactionPatterns,
      isUpstreamAvailable: () => ctx.subagents.getProvider(upstreamName) === upstream,
    })
    let unregister: () => void
    try {
      unregister = ctx.subagents.registerProvider(provider)
    } catch (error: unknown) {
      await writer.close()
      throw error
    }
    return {
      mode: 'record',
      providerName,
      file: writer.path,
      assertConsumed: () => {},
      dispose: (): Promise<void> => {
        if (disposal !== undefined) return disposal
        disposal = (async (): Promise<void> => {
          unregister()
          await provider.whenIdle()
          await writer.close()
        })()
        return disposal
      },
    }
  }

  const path = resolveCassettePath(config.file)
  const cassette = await loadCassette(path)
  const speed = config.speed ?? 1
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new CassetteError('speed must be a positive finite number', 'INVALID_CONFIG')
  }
  const matcher = new InteractionMatcher(
    cassette,
    config.duplicatePolicy ?? 'reject',
    config.allowRedactedReplay ?? false,
  )
  const provider = new ReplaySubagentProvider(
    providerName,
    matcher,
    cassette.header.provider,
    { timing: config.timing ?? 'instant', speed },
  )
  const unregister = ctx.subagents.registerProvider(provider)
  const shouldAssert = config.assertConsumed ?? true
  return {
    mode: 'replay',
    providerName,
    file: path,
    assertConsumed: () => { matcher.assertConsumed() },
    dispose: (): Promise<void> => {
      if (disposal !== undefined) return disposal
      disposal = (async (): Promise<void> => {
        unregister()
        if (shouldAssert) matcher.assertConsumed()
      })()
      return disposal
    },
  }
}

/** Cordis Loader entry point. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const mode = config.mode ?? 'record'
  const file = config.file ?? '.dsh-cassettes/subagents-{timestamp}-{pid}.cassette.jsonl'
  const common = {
    mode,
    file,
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.redactSecrets === undefined ? {} : { redactSecrets: config.redactSecrets }),
    ...(config.redactionPatterns === undefined ? {} : { redactionPatterns: config.redactionPatterns }),
  }
  const installConfig: InstallConfig = mode === 'record'
    ? {
        ...common,
        mode,
        ...(config.upstreamProvider === undefined ? {} : { upstreamProvider: config.upstreamProvider }),
        ...(config.writeMode === undefined ? {} : { writeMode: config.writeMode }),
        ...(config.requestStorage === undefined ? {} : { requestStorage: config.requestStorage }),
      }
    : {
        ...common,
        mode,
        ...(config.timing === undefined ? {} : { timing: config.timing }),
        ...(config.speed === undefined ? {} : { speed: config.speed }),
        ...(config.duplicatePolicy === undefined ? {} : { duplicatePolicy: config.duplicatePolicy }),
        ...(config.allowRedactedReplay === undefined ? {} : { allowRedactedReplay: config.allowRedactedReplay }),
        ...(config.assertConsumed === undefined ? {} : { assertConsumed: config.assertConsumed }),
      }
  const handle = await installCassette(ctx, installConfig)
  return async () => { await handle.dispose() }
}
