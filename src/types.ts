import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  SubagentCapabilities,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'

export const CASSETTE_FORMAT = 'dsh-subagent-cassette'
export const CASSETTE_VERSION = 1
export const TARGET_DSH_SUBAGENT_VERSION = '0.1.0-rc.7'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type CassetteMode = 'record' | 'replay'
export type CassetteWriteMode = 'create' | 'append' | 'truncate'
export type RequestStorage = 'metadata' | 'full'
export type ReplayTiming = 'instant' | 'recorded'
export type DuplicatePolicy = 'reject' | 'sequence'

export interface CassetteProviderFacts {
  readonly cassette: string
  readonly upstream: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
}

export interface CassetteHeaderBody {
  readonly kind: 'cassette/header'
  readonly format: typeof CASSETTE_FORMAT
  readonly version: typeof CASSETTE_VERSION
  readonly cassetteId: string
  readonly createdAt: string
  readonly target: {
    readonly dshSubagent: typeof TARGET_DSH_SUBAGENT_VERSION
  }
  readonly provider: CassetteProviderFacts
  readonly requestStorage: RequestStorage
  readonly redactSecrets: boolean
  readonly redactionPatterns: readonly string[]
}

export interface CassetteHeader extends CassetteHeaderBody {
  readonly hash: string
}

export interface NormalizedSubagentRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly agentOptions?: JsonValue
  readonly outputSchema?: JsonValue
  readonly maxDepth?: number
  readonly toolFilter?: JsonValue
  readonly persona?: string
}

export interface NormalizedParentContext {
  readonly options: JsonValue
  readonly session: {
    readonly cwd?: string
    readonly origin?: string
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly composition?: {
    readonly agentPreset?: string
    readonly system?: string
    readonly tools?: JsonValue
    readonly sandboxMode?: JsonValue
    readonly approvalPolicy?: 'never'
  }
  readonly inheritedMessages?: JsonValue[]
}

export interface RequestMetadata {
  readonly label?: string
  readonly promptBlocks: number
  readonly promptBytes: number
  readonly hasOutputSchema: boolean
  readonly maxDepth?: number
  readonly childProvider?: string
  readonly childModel?: string
  readonly toolFilter?: JsonValue
  readonly hasPersona: boolean
}

export type StoredRequest =
  | { readonly storage: 'metadata'; readonly metadata: RequestMetadata }
  | {
    readonly storage: 'full'
    readonly value: NormalizedSubagentRequest
    readonly redactions: number
  }

export interface RecordedError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

export type CassetteOutcome =
  | {
    readonly kind: 'result'
    readonly result: SubagentResult
    readonly redactions: number
  }
  | { readonly kind: 'start-error'; readonly error: RecordedError }
  | { readonly kind: 'result-error'; readonly error: RecordedError }

export interface CassetteTiming {
  readonly startedAt: string
  readonly startLatencyMs: number
  readonly durationMs: number
  readonly signalAbortedAtMs?: number
  readonly disposeCalledAtMs?: number
}

export interface CassetteInteractionBody {
  readonly kind: 'cassette/interaction'
  readonly sequence: number
  readonly callKey: string
  readonly parentKey: string
  readonly parentContextFingerprint: string
  readonly occurrence: number
  readonly requestFingerprint: string
  readonly request: StoredRequest
  readonly timing: CassetteTiming
  readonly published: boolean
  readonly local: boolean
  readonly outcome: CassetteOutcome
}

export interface CassetteInteraction extends CassetteInteractionBody {
  readonly previousHash: string
  readonly hash: string
}

export interface CassetteFile {
  readonly header: CassetteHeader
  readonly interactions: CassetteInteraction[]
  readonly source?: string
}

export interface CassetteSummary {
  readonly file?: string
  readonly cassetteId: string
  readonly provider: CassetteProviderFacts
  readonly interactions: number
  readonly completed: number
  readonly failed: number
  readonly aborted: number
  readonly ambiguousGroups: number
  readonly redactedResults: number
  readonly durationMs: number
}

export interface CommonConfig {
  readonly provider?: string
  readonly file: string
  readonly redactSecrets?: boolean
  readonly redactionPatterns?: string[]
}

export interface RecordConfig extends CommonConfig {
  readonly mode: 'record'
  readonly upstreamProvider?: string
  readonly writeMode?: CassetteWriteMode
  readonly requestStorage?: RequestStorage
}

export interface ReplayConfig extends CommonConfig {
  readonly mode: 'replay'
  readonly timing?: ReplayTiming
  readonly speed?: number
  readonly duplicatePolicy?: DuplicatePolicy
  readonly allowRedactedReplay?: boolean
  readonly assertConsumed?: boolean
}

export type InstallConfig = RecordConfig | ReplayConfig
