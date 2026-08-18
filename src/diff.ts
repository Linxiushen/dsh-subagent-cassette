import { canonicalStringify, fingerprintJson } from './canonical.ts'
import { ambiguousGroups } from './format.ts'
import type {
  CassetteFile,
  CassetteInteraction,
  CassetteOutcome,
  JsonValue,
} from './types.ts'

export type CassettePolicyField =
  | 'provider.cassette'
  | 'provider.upstream'
  | 'provider.capabilities'
  | 'provider.inheritsParentContext'
  | 'requestStorage'
  | 'redactSecrets'
  | 'redactionPatterns'

export type CassetteComparisonIssue =
  | 'expected-ambiguous-duplicate-groups'
  | 'actual-ambiguous-duplicate-groups'
  | 'parent-context-semantics-changed'

export interface CassetteCallIdentity {
  readonly parentKey: string
  readonly parentContextFingerprint: string
  readonly requestFingerprint: string
  readonly occurrence: number
}

export interface CassetteCallSummary extends CassetteCallIdentity {
  readonly callKey: string
  readonly outcomeKind: CassetteOutcome['kind']
  readonly stopReason?: string
  readonly outcomeFingerprint: string
  readonly published: boolean
  readonly local: boolean
  readonly durationMs: number
}

export interface CassetteChangedCall {
  readonly expected: CassetteCallSummary
  readonly actual: CassetteCallSummary
}

export interface CassetteBoundaryChangedCall extends CassetteChangedCall {
  readonly fields: readonly ('published' | 'local')[]
}

export interface CassetteTimingDelta extends CassetteCallIdentity {
  readonly expectedCallKey: string
  readonly actualCallKey: string
  readonly expectedStartLatencyMs: number
  readonly actualStartLatencyMs: number
  readonly startLatencyDeltaMs: number
  readonly expectedDurationMs: number
  readonly actualDurationMs: number
  readonly deltaMs: number
}

export interface CassetteDiff {
  readonly schemaVersion: 1
  readonly comparable: boolean
  readonly equivalent: boolean
  readonly expectedInteractions: number
  readonly actualInteractions: number
  readonly policyChanges: readonly CassettePolicyField[]
  readonly issues: readonly CassetteComparisonIssue[]
  readonly expectedAmbiguousGroups: number
  readonly actualAmbiguousGroups: number
  readonly added: readonly CassetteCallSummary[]
  readonly removed: readonly CassetteCallSummary[]
  readonly outcomeChanged: readonly CassetteChangedCall[]
  readonly boundaryChanged: readonly CassetteBoundaryChangedCall[]
  readonly timing: readonly CassetteTimingDelta[]
}

function identityOf(interaction: CassetteInteraction): CassetteCallIdentity {
  return {
    parentKey: interaction.parentKey,
    parentContextFingerprint: interaction.parentContextFingerprint,
    requestFingerprint: interaction.requestFingerprint,
    occurrence: interaction.occurrence,
  }
}

function identityKey(interaction: CassetteInteraction): string {
  return [
    interaction.parentKey,
    interaction.parentContextFingerprint,
    interaction.requestFingerprint,
    interaction.occurrence.toString(),
  ].join('\0')
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareIdentity(left: CassetteInteraction, right: CassetteInteraction): number {
  return compareText(left.parentKey, right.parentKey)
    || compareText(left.parentContextFingerprint, right.parentContextFingerprint)
    || compareText(left.requestFingerprint, right.requestFingerprint)
    || left.occurrence - right.occurrence
}

function outcomeFingerprint(interaction: CassetteInteraction): string {
  return fingerprintJson(interaction.outcome as unknown as JsonValue)
}

function summarize(interaction: CassetteInteraction): CassetteCallSummary {
  return {
    ...identityOf(interaction),
    callKey: interaction.callKey,
    outcomeKind: interaction.outcome.kind,
    ...(interaction.outcome.kind === 'result'
      ? { stopReason: interaction.outcome.result.stopReason }
      : {}),
    outcomeFingerprint: outcomeFingerprint(interaction),
    published: interaction.published,
    local: interaction.local,
    durationMs: interaction.timing.durationMs,
  }
}

function policyChanges(expected: CassetteFile, actual: CassetteFile): CassettePolicyField[] {
  const changes: CassettePolicyField[] = []
  const fields: readonly [CassettePolicyField, JsonValue, JsonValue][] = [
    ['provider.cassette', expected.header.provider.cassette, actual.header.provider.cassette],
    ['provider.upstream', expected.header.provider.upstream, actual.header.provider.upstream],
    [
      'provider.capabilities',
      expected.header.provider.capabilities as unknown as JsonValue,
      actual.header.provider.capabilities as unknown as JsonValue,
    ],
    [
      'provider.inheritsParentContext',
      expected.header.provider.inheritsParentContext,
      actual.header.provider.inheritsParentContext,
    ],
    ['requestStorage', expected.header.requestStorage, actual.header.requestStorage],
    ['redactSecrets', expected.header.redactSecrets, actual.header.redactSecrets],
    [
      'redactionPatterns',
      expected.header.redactionPatterns as unknown as JsonValue,
      actual.header.redactionPatterns as unknown as JsonValue,
    ],
  ]
  for (const [field, expectedValue, actualValue] of fields) {
    if (canonicalStringify(expectedValue) !== canonicalStringify(actualValue)) changes.push(field)
  }
  return changes
}

function sortedInteractions(cassette: CassetteFile): CassetteInteraction[] {
  return [...cassette.interactions].sort(compareIdentity)
}

/** Compare two verified cassettes without exposing stored request or outcome bodies. */
export function diffCassettes(expected: CassetteFile, actual: CassetteFile): CassetteDiff {
  const expectedAmbiguousGroups = ambiguousGroups(expected).length
  const actualAmbiguousGroups = ambiguousGroups(actual).length
  const changes = policyChanges(expected, actual)
  const issues: CassetteComparisonIssue[] = []
  if (expectedAmbiguousGroups > 0) issues.push('expected-ambiguous-duplicate-groups')
  if (actualAmbiguousGroups > 0) issues.push('actual-ambiguous-duplicate-groups')
  if (changes.includes('provider.inheritsParentContext')) issues.push('parent-context-semantics-changed')

  const expectedByIdentity = new Map(
    sortedInteractions(expected).map(interaction => [identityKey(interaction), interaction] as const),
  )
  const actualByIdentity = new Map(
    sortedInteractions(actual).map(interaction => [identityKey(interaction), interaction] as const),
  )
  const added: CassetteCallSummary[] = []
  const removed: CassetteCallSummary[] = []
  const outcomeChanged: CassetteChangedCall[] = []
  const boundaryChanged: CassetteBoundaryChangedCall[] = []
  const timing: CassetteTimingDelta[] = []

  for (const [key, expectedInteraction] of expectedByIdentity) {
    const actualInteraction = actualByIdentity.get(key)
    if (actualInteraction === undefined) {
      removed.push(summarize(expectedInteraction))
      continue
    }
    actualByIdentity.delete(key)
    const expectedSummary = summarize(expectedInteraction)
    const actualSummary = summarize(actualInteraction)
    if (expectedSummary.outcomeFingerprint !== actualSummary.outcomeFingerprint) {
      outcomeChanged.push({ expected: expectedSummary, actual: actualSummary })
    }
    const fields: ('published' | 'local')[] = []
    if (expectedInteraction.published !== actualInteraction.published) fields.push('published')
    if (expectedInteraction.local !== actualInteraction.local) fields.push('local')
    if (fields.length > 0) {
      boundaryChanged.push({ expected: expectedSummary, actual: actualSummary, fields })
    }
    timing.push({
      ...identityOf(expectedInteraction),
      expectedCallKey: expectedInteraction.callKey,
      actualCallKey: actualInteraction.callKey,
      expectedStartLatencyMs: expectedInteraction.timing.startLatencyMs,
      actualStartLatencyMs: actualInteraction.timing.startLatencyMs,
      startLatencyDeltaMs:
        actualInteraction.timing.startLatencyMs - expectedInteraction.timing.startLatencyMs,
      expectedDurationMs: expectedInteraction.timing.durationMs,
      actualDurationMs: actualInteraction.timing.durationMs,
      deltaMs: actualInteraction.timing.durationMs - expectedInteraction.timing.durationMs,
    })
  }
  for (const interaction of actualByIdentity.values()) added.push(summarize(interaction))

  const comparable = issues.length === 0
  const equivalent = comparable
    && changes.length === 0
    && added.length === 0
    && removed.length === 0
    && outcomeChanged.length === 0
    && boundaryChanged.length === 0
  return {
    schemaVersion: 1,
    comparable,
    equivalent,
    expectedInteractions: expected.interactions.length,
    actualInteractions: actual.interactions.length,
    policyChanges: changes,
    issues,
    expectedAmbiguousGroups,
    actualAmbiguousGroups,
    added,
    removed,
    outcomeChanged,
    boundaryChanged,
    timing,
  }
}
