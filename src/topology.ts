import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  canonicalStringify,
  fingerprintJson,
  fingerprintParentContext,
  fingerprintRequest,
  normalizeParentContext,
  normalizeRequest,
  requestMetadata,
} from './canonical.ts'
import { CassetteAmbiguityError, CassetteMismatchError } from './errors.ts'
import { ambiguousGroups } from './format.ts'
import type {
  CassetteDiagnostic,
  CassetteDiagnosticCandidate,
  CassetteDiagnosticRequest,
  CassetteFile,
  CassetteInteraction,
  CassetteMismatchDiagnostic,
  DuplicatePolicy,
  JsonValue,
  NormalizedSubagentRequest,
} from './types.ts'

function readableLabel(label: string | undefined): string {
  if (label === undefined) return 'agent'
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return normalized.slice(0, 32) || 'agent'
}

export interface ReservedCall {
  readonly parentKey: string
  readonly callKey: string
  readonly parentContextFingerprint: string
  readonly occurrence: number
  readonly request: NormalizedSubagentRequest
  readonly requestFingerprint: string
}

/** Maps volatile live Agent ids to stable cassette topology paths. */
export class TopologyTracker {
  private readonly parentKeys = new Map<string, string>()
  private readonly occurrences = new Map<string, number>()
  private rootId: string | undefined

  constructor(
    private readonly inheritsParentContext: boolean = false,
    existing: readonly CassetteInteraction[] = [],
  ) {
    for (const interaction of existing) {
      const group = interactionGroup(
        interaction.parentKey,
        interaction.parentContextFingerprint,
        interaction.requestFingerprint,
      )
      this.occurrences.set(group, Math.max(this.occurrences.get(group) ?? 0, interaction.occurrence))
    }
  }

  parentKey(parent: Agent): string {
    const id = String(parent.id)
    const known = this.parentKeys.get(id)
    if (known !== undefined) return known
    const parentKey = this.peekParentKey(parent)
    this.rootId = id
    this.parentKeys.set(id, parentKey)
    return parentKey
  }

  /** Resolve a live parent without reserving it as this matcher's root. */
  peekParentKey(parent: Agent): string {
    const id = String(parent.id)
    const known = this.parentKeys.get(id)
    if (known !== undefined) return known
    if (parent.session.header.origin === 'subagent') {
      throw new CassetteAmbiguityError(
        `subagent parent "${id}" was not created through this cassette provider; `
        + 'its stable topology path is unavailable',
      )
    }
    if (this.rootId === undefined) {
      return 'root'
    }
    if (this.rootId !== id) {
      throw new CassetteAmbiguityError(
        `cassette observed more than one top-level parent ("${this.rootId}" and "${id}"); `
        + 'record each root in a separate cassette',
      )
    }
    return 'root'
  }

  reserve(request: ResolvedSubagentStartRequest): ReservedCall {
    const parentKey = this.parentKey(request.parent)
    const parentContextFingerprint = fingerprintParentContext(
      normalizeParentContext(request.parent, this.inheritsParentContext),
    )
    const normalized = normalizeRequest(request)
    const requestFingerprint = fingerprintRequest(normalized)
    const group = interactionGroup(parentKey, parentContextFingerprint, requestFingerprint)
    const occurrence = (this.occurrences.get(group) ?? 0) + 1
    this.occurrences.set(group, occurrence)
    const identityFingerprint = fingerprintJson({ parentContextFingerprint, requestFingerprint })
    const hash = identityFingerprint.slice('sha256:'.length, 'sha256:'.length + 12)
    const callKey = `${parentKey}/${readableLabel(normalized.label)}-${hash}~${occurrence}`
    return {
      parentKey,
      callKey,
      parentContextFingerprint,
      occurrence,
      request: normalized,
      requestFingerprint,
    }
  }

  registerLocalChild(child: Agent, callKey: string): void {
    const id = String(child.id)
    const existing = this.parentKeys.get(id)
    if (existing !== undefined && existing !== callKey) {
      throw new CassetteAmbiguityError(
        `local child "${id}" was already mapped to "${existing}", cannot remap it to "${callKey}"`,
      )
    }
    this.parentKeys.set(id, callKey)
  }
}

function interactionGroup(
  parentKey: string,
  parentContextFingerprint: string,
  requestFingerprint: string,
): string {
  return `${parentKey}\0${parentContextFingerprint}\0${requestFingerprint}`
}

/** Strict request matcher whose sibling selection is independent of completion order. */
export class InteractionMatcher {
  private readonly topology: TopologyTracker
  private readonly groups = new Map<string, CassetteInteraction[]>()
  private readonly consumed = new Set<string>()
  private readonly interactions: readonly CassetteInteraction[]

  constructor(
    private readonly cassette: CassetteFile,
    duplicatePolicy: DuplicatePolicy,
    allowRedactedReplay: boolean,
  ) {
    this.topology = new TopologyTracker(cassette.header.provider.inheritsParentContext)
    this.interactions = [...cassette.interactions].sort((a, b) => a.sequence - b.sequence)
    const ambiguous = ambiguousGroups(cassette)
    if (duplicatePolicy === 'reject' && ambiguous.length > 0) {
      throw new CassetteAmbiguityError(
        `cassette has ${ambiguous.length} duplicate request group(s) with different outcomes; `
        + 'add stable labels/prompts or set duplicatePolicy to "sequence" explicitly',
      )
    }
    if (!allowRedactedReplay) {
      const redacted = cassette.interactions.find(
        interaction => interaction.outcome.kind === 'result' && interaction.outcome.redactions > 0,
      )
      if (redacted !== undefined) {
        throw new CassetteMismatchError(
          `interaction "${redacted.callKey}" contains a redacted result; `
          + 'set allowRedactedReplay only if substituted output is acceptable',
        )
      }
    }
    for (const interaction of this.interactions) {
      const key = interactionGroup(
        interaction.parentKey,
        interaction.parentContextFingerprint,
        interaction.requestFingerprint,
      )
      const group = this.groups.get(key) ?? []
      group.push(interaction)
      this.groups.set(key, group)
    }
    for (const group of this.groups.values()) {
      group.sort((a, b) => a.occurrence - b.occurrence)
    }
  }

  match(request: ResolvedSubagentStartRequest): CassetteInteraction {
    const normalized = normalizeRequest(request)
    const parentKey = this.topology.parentKey(request.parent)
    const actual = this.describeActual(request, parentKey, normalized)
    const key = interactionGroup(
      actual.parentKey,
      actual.parentContextFingerprint,
      actual.requestFingerprint,
    )
    const interaction = this.groups.get(key)?.shift()
    if (interaction === undefined) {
      const diagnostic = this.mismatchDiagnostic(actual)
      throw new CassetteMismatchError(this.mismatchMessage(diagnostic), { diagnostic })
    }
    this.consumed.add(interaction.callKey)
    return interaction
  }

  /** Explain whether a request can match without consuming an interaction. */
  diagnose(request: ResolvedSubagentStartRequest): CassetteDiagnostic {
    const normalized = normalizeRequest(request)
    const parentKey = this.topology.peekParentKey(request.parent)
    const actual = this.describeActual(request, parentKey, normalized)
    const key = interactionGroup(
      actual.parentKey,
      actual.parentContextFingerprint,
      actual.requestFingerprint,
    )
    const interaction = this.groups.get(key)?.[0]
    if (interaction === undefined) return this.mismatchDiagnostic(actual)
    return {
      status: 'match',
      actual,
      candidate: this.diagnosticCandidate(interaction),
    }
  }

  assertConsumed(): void {
    const remaining = this.cassette.interactions.filter(item => !this.consumed.has(item.callKey))
    if (remaining.length === 0) return
    const sample = remaining.slice(0, 5).map(item => item.callKey).join(', ')
    throw new CassetteMismatchError(
      `${remaining.length} cassette interaction(s) were not consumed: ${sample}`,
    )
  }

  /** Canonical request debugging view, including prompt content. Prefer diagnose() for safe metadata. */
  describe(request: ResolvedSubagentStartRequest): string {
    const normalized = normalizeRequest(request)
    const parentContextFingerprint = fingerprintParentContext(
      normalizeParentContext(request.parent, this.cassette.header.provider.inheritsParentContext),
    )
    return canonicalStringify({
      parentContextFingerprint,
      request: normalized as unknown as JsonValue,
    })
  }

  private describeActual(
    request: ResolvedSubagentStartRequest,
    parentKey: string,
    normalized: NormalizedSubagentRequest,
  ): CassetteDiagnosticRequest {
    return {
      parentKey,
      parentContextFingerprint: fingerprintParentContext(
        normalizeParentContext(request.parent, this.cassette.header.provider.inheritsParentContext),
      ),
      requestFingerprint: fingerprintRequest(normalized),
      requestMetadata: requestMetadata(normalized),
    }
  }

  private diagnosticCandidate(interaction: CassetteInteraction): CassetteDiagnosticCandidate {
    const metadata = interaction.request.storage === 'metadata'
      ? interaction.request.metadata
      : requestMetadata(interaction.request.value)
    return {
      sequence: interaction.sequence,
      callKey: interaction.callKey,
      parentKey: interaction.parentKey,
      parentContextFingerprint: interaction.parentContextFingerprint,
      occurrence: interaction.occurrence,
      requestFingerprint: interaction.requestFingerprint,
      requestMetadata: metadata,
      consumed: this.consumed.has(interaction.callKey),
    }
  }

  private mismatchDiagnostic(actual: CassetteDiagnosticRequest): CassetteMismatchDiagnostic {
    const sameParent = this.interactions.filter(item => item.parentKey === actual.parentKey)
    const exact = sameParent.filter(item => (
      item.parentContextFingerprint === actual.parentContextFingerprint
      && item.requestFingerprint === actual.requestFingerprint
    ))
    if (exact.length > 0) {
      return {
        status: 'mismatch',
        reason: 'group-exhausted',
        actual,
        candidates: exact.map(item => this.diagnosticCandidate(item)),
      }
    }
    if (sameParent.length === 0) {
      return {
        status: 'mismatch',
        reason: 'parent-not-found',
        actual,
        candidates: this.interactions.map(item => this.diagnosticCandidate(item)),
      }
    }
    const sameRequest = sameParent.filter(
      item => item.requestFingerprint === actual.requestFingerprint,
    )
    if (sameRequest.length > 0) {
      return {
        status: 'mismatch',
        reason: 'parent-context-changed',
        actual,
        candidates: sameRequest.map(item => this.diagnosticCandidate(item)),
      }
    }
    const sameContext = sameParent.filter(
      item => item.parentContextFingerprint === actual.parentContextFingerprint,
    )
    if (sameContext.length > 0) {
      return {
        status: 'mismatch',
        reason: 'request-changed',
        actual,
        candidates: sameContext.map(item => this.diagnosticCandidate(item)),
      }
    }
    return {
      status: 'mismatch',
      reason: 'parent-and-request-changed',
      actual,
      candidates: sameParent.map(item => this.diagnosticCandidate(item)),
    }
  }

  private mismatchMessage(diagnostic: CassetteMismatchDiagnostic): string {
    const label = diagnostic.actual.requestMetadata.label === undefined
      ? '<unlabelled>'
      : JSON.stringify(diagnostic.actual.requestMetadata.label)
    const sample = diagnostic.candidates.slice(0, 3).map(candidate => (
      `${candidate.callKey} (${candidate.consumed ? 'consumed' : 'available'})`
    )).join(', ')
    if (diagnostic.reason === 'group-exhausted') {
      return `cassette interaction group for parent "${diagnostic.actual.parentKey}", label ${label} `
        + `has exhausted all ${diagnostic.candidates.length} recorded occurrence(s); `
        + `recorded calls: ${sample || 'none'}`
    }
    return `no cassette interaction matches parent "${diagnostic.actual.parentKey}", label ${label}, `
      + `parent context ${diagnostic.actual.parentContextFingerprint}, `
      + `request ${diagnostic.actual.requestFingerprint}; diagnosis: ${diagnostic.reason}; `
      + `candidate calls: ${sample || 'none'}`
  }
}
