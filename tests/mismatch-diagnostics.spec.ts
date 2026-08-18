import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  fingerprintParentContext,
  fingerprintRequest,
  normalizeParentContext,
  normalizeRequest,
  requestMetadata,
} from '../src/canonical.ts'
import { CassetteMismatchError } from '../src/errors.ts'
import { CassetteWriter, createHeader, loadCassette } from '../src/format.ts'
import { InteractionMatcher } from '../src/topology.ts'
import type {
  CassetteFile,
  CassetteOutcome,
  RequestStorage,
  StoredRequest,
} from '../src/types.ts'
import {
  fakeAgent,
  request,
  tempWorkspace,
  textResult,
  type TempWorkspace,
} from './helpers.ts'

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

interface FixtureInteraction {
  readonly sequence: number
  readonly request: ResolvedSubagentStartRequest
  readonly parentKey?: string
  readonly callKey?: string
  readonly occurrence?: number
  readonly outcome?: CassetteOutcome
}

function withPrompt(
  label: string,
  parent: ResolvedSubagentStartRequest['parent'],
  prompt: string,
): ResolvedSubagentStartRequest {
  return {
    ...request(label, parent),
    prompt: [{ type: 'text', text: prompt }],
  }
}

async function fixture(
  requestStorage: RequestStorage,
  interactions: readonly FixtureInteraction[],
): Promise<CassetteFile> {
  const temp = await tempWorkspace()
  workspaces.push(temp)
  const writer = await CassetteWriter.open(temp.path(), createHeader({
    cassette: 'cassette',
    upstream: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    requestStorage,
    redactSecrets: false,
  }), 'create')
  const occurrences = new Map<string, number>()
  for (const item of interactions) {
    const normalized = normalizeRequest(item.request)
    const parentKey = item.parentKey ?? 'root'
    const parentContextFingerprint = fingerprintParentContext(
      normalizeParentContext(item.request.parent, false),
    )
    const requestFingerprint = fingerprintRequest(normalized)
    const group = `${parentKey}\0${parentContextFingerprint}\0${requestFingerprint}`
    const occurrence = item.occurrence ?? ((occurrences.get(group) ?? 0) + 1)
    occurrences.set(group, occurrence)
    const storedRequest: StoredRequest = requestStorage === 'metadata'
      ? { storage: 'metadata', metadata: requestMetadata(normalized) }
      : { storage: 'full', value: normalized, redactions: 0 }
    await writer.append({
      kind: 'cassette/interaction',
      sequence: item.sequence,
      callKey: item.callKey ?? `${parentKey}/${normalized.label ?? 'agent'}~${occurrence}`,
      parentKey,
      parentContextFingerprint,
      occurrence,
      requestFingerprint,
      request: storedRequest,
      timing: { startedAt: new Date(0).toISOString(), startLatencyMs: 0, durationMs: 1 },
      published: true,
      local: false,
      outcome: item.outcome ?? { kind: 'result', result: textResult('fixture result'), redactions: 0 },
    })
  }
  await writer.close()
  return loadCassette(temp.path())
}

function caughtMismatch(callback: () => unknown): CassetteMismatchError {
  try {
    callback()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CassetteMismatchError)
    return error as CassetteMismatchError
  }
  throw new Error('expected CassetteMismatchError')
}

describe('structured mismatch diagnostics', () => {
  it('diagnoses without consuming an interaction or reserving the probe parent', async () => {
    const cassette = await fixture('metadata', [{ sequence: 1, request: request('known') }])
    const matcher = new InteractionMatcher(cassette, 'reject', false)

    const first = matcher.diagnose(request('known', fakeAgent('probe-one')))
    const second = matcher.diagnose(request('known', fakeAgent('probe-two')))
    expect(first).toMatchObject({ status: 'match', candidate: { consumed: false } })
    expect(second).toMatchObject({ status: 'match', candidate: { consumed: false } })

    const liveParent = fakeAgent('actual-root')
    expect(matcher.match(request('known', liveParent)).callKey).toContain('known')
    const exhausted = matcher.diagnose(request('known', liveParent))
    expect(exhausted).toMatchObject({
      status: 'mismatch',
      reason: 'group-exhausted',
      candidates: [{ consumed: true, occurrence: 1 }],
    })

    const error = caughtMismatch(() => matcher.match(request('known', liveParent)))
    expect(error.diagnostic).toMatchObject({
      status: 'mismatch',
      reason: 'group-exhausted',
      candidates: [{ consumed: true }],
    })
    expect(error.message).toMatch(/exhausted all 1 recorded occurrence/)
  })

  it('does not reserve a root when request normalization fails', async () => {
    const cassette = await fixture('metadata', [{ sequence: 1, request: request('known') }])
    const matcher = new InteractionMatcher(cassette, 'reject', false)
    const invalid = {
      ...request('known', fakeAgent('invalid-root')),
      prompt: [{ type: 'text', text: 1n }],
    } as unknown as ResolvedSubagentStartRequest

    expect(() => matcher.match(invalid)).toThrow()
    expect(matcher.match(request('known', fakeAgent('valid-root'))).callKey).toContain('known')
  })

  it('distinguishes parent context drift from request drift', async () => {
    const recordedParent = { ...fakeAgent('recorded'), options: { model: 'deepseek-chat' } }
    const cassette = await fixture('metadata', [{
      sequence: 1,
      request: request('audit', recordedParent),
    }])

    const changedParent = { ...fakeAgent('changed-parent'), options: { model: 'deepseek-reasoner' } }
    const parentDiagnostic = new InteractionMatcher(cassette, 'reject', false)
      .diagnose(request('audit', changedParent))
    expect(parentDiagnostic).toMatchObject({
      status: 'mismatch',
      reason: 'parent-context-changed',
      candidates: [{ callKey: 'root/audit~1', consumed: false }],
    })

    const sameContext = { ...fakeAgent('same-context'), options: { model: 'deepseek-chat' } }
    const requestDiagnostic = new InteractionMatcher(cassette, 'reject', false)
      .diagnose(withPrompt('audit', sameContext, 'changed request body'))
    expect(requestDiagnostic).toMatchObject({
      status: 'mismatch',
      reason: 'request-changed',
      candidates: [{ callKey: 'root/audit~1', consumed: false }],
    })
  })

  it('reports combined drift and a missing parent topology separately', async () => {
    const recordedParent = { ...fakeAgent('recorded'), options: { model: 'deepseek-chat' } }
    const rootCassette = await fixture('metadata', [{
      sequence: 1,
      request: request('audit', recordedParent),
    }])
    const changedParent = { ...fakeAgent('changed'), options: { model: 'deepseek-reasoner' } }
    expect(new InteractionMatcher(rootCassette, 'reject', false)
      .diagnose(withPrompt('audit', changedParent, 'changed request body'))).toMatchObject({
      status: 'mismatch',
      reason: 'parent-and-request-changed',
      candidates: [{ parentKey: 'root' }],
    })

    const nestedCassette = await fixture('metadata', [{
      sequence: 1,
      parentKey: 'root/outer~1',
      request: request('nested', recordedParent),
    }])
    expect(new InteractionMatcher(nestedCassette, 'reject', false)
      .diagnose(request('nested', fakeAgent('live-root')))).toMatchObject({
      status: 'mismatch',
      reason: 'parent-not-found',
      candidates: [{ parentKey: 'root/outer~1' }],
    })
  })

  it('sorts candidates by sequence independent of physical completion order and marks consumption', async () => {
    const recordedParent = fakeAgent('recorded')
    const cassette = await fixture('metadata', [
      { sequence: 2, request: request('beta', recordedParent) },
      { sequence: 1, request: request('alpha', recordedParent) },
    ])
    const matcher = new InteractionMatcher(cassette, 'reject', false)
    const liveParent = fakeAgent('live')
    matcher.match(request('alpha', liveParent))

    const diagnostic = matcher.diagnose(withPrompt('gamma', liveParent, 'new request'))
    expect(diagnostic.status).toBe('mismatch')
    if (diagnostic.status !== 'mismatch') throw new Error('expected mismatch diagnostic')
    expect(diagnostic.reason).toBe('request-changed')
    expect(diagnostic.candidates.map(candidate => candidate.sequence)).toEqual([1, 2])
    expect(diagnostic.candidates.map(candidate => candidate.consumed)).toEqual([true, false])
  })

  it.each<RequestStorage>(['metadata', 'full'])(
    'does not expose prompt, result, or error bodies from %s storage',
    async (requestStorage) => {
      const parent = fakeAgent('recorded')
      const cassette = await fixture(requestStorage, [
        {
          sequence: 1,
          request: withPrompt('success', parent, 'PROMPT_SECRET_SUCCESS'),
          outcome: { kind: 'result', result: textResult('RESULT_SECRET'), redactions: 0 },
        },
        {
          sequence: 2,
          request: withPrompt('failure', parent, 'PROMPT_SECRET_FAILURE'),
          outcome: {
            kind: 'result-error',
            error: { name: 'Error', message: 'ERROR_BODY_SECRET' },
          },
        },
      ])
      const matcher = new InteractionMatcher(cassette, 'reject', false)
      const live = withPrompt('probe', fakeAgent('live'), 'LIVE_PROMPT_SECRET')
      const diagnostic = matcher.diagnose(live)
      const diagnosticText = JSON.stringify(diagnostic)
      for (const secret of [
        'PROMPT_SECRET_SUCCESS',
        'PROMPT_SECRET_FAILURE',
        'RESULT_SECRET',
        'ERROR_BODY_SECRET',
        'LIVE_PROMPT_SECRET',
      ]) {
        expect(diagnosticText).not.toContain(secret)
      }

      const error = caughtMismatch(() => matcher.match(live))
      const errorText = `${error.message}\n${JSON.stringify(error.diagnostic)}`
      expect(errorText).not.toContain('PROMPT_SECRET_SUCCESS')
      expect(errorText).not.toContain('RESULT_SECRET')
      expect(errorText).not.toContain('ERROR_BODY_SECRET')
      expect(errorText).not.toContain('LIVE_PROMPT_SECRET')
    },
  )

  it('keeps the existing ErrorOptions second argument compatible', () => {
    const cause = new Error('root cause')
    const error = new CassetteMismatchError('mismatch', { cause })
    expect(error.cause).toBe(cause)
    expect(error.diagnostic).toBeUndefined()
  })
})
