import { describe, expect, it } from 'vitest'
import { diffCassettes } from '../src/diff.ts'
import { createHeader } from '../src/format.ts'
import type {
  CassetteFile,
  CassetteHeader,
  CassetteInteraction,
  CassetteOutcome,
  RequestStorage,
} from '../src/types.ts'
import { textResult } from './helpers.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

function header(options: {
  inheritsParentContext?: boolean
  requestStorage?: RequestStorage
  upstream?: string
} = {}): CassetteHeader {
  return createHeader({
    cassette: 'cassette',
    upstream: options.upstream ?? 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: options.inheritsParentContext ?? false,
    requestStorage: options.requestStorage ?? 'metadata',
    redactSecrets: true,
  })
}

function interaction(options: {
  key: string
  sequence?: number
  occurrence?: number
  parentContext?: string
  request?: string
  durationMs?: number
  local?: boolean
  outcome?: CassetteOutcome
  secretPrompt?: string
}): CassetteInteraction {
  const sequence = options.sequence ?? 1
  const occurrence = options.occurrence ?? 1
  return {
    kind: 'cassette/interaction',
    sequence,
    callKey: `root/${options.key}~${occurrence}`,
    parentKey: 'root',
    parentContextFingerprint: options.parentContext ?? digest('c'),
    occurrence,
    requestFingerprint: options.request ?? digest(options.key.slice(0, 1)),
    request: options.secretPrompt === undefined
      ? {
          storage: 'metadata',
          metadata: { promptBlocks: 1, promptBytes: 10, hasOutputSchema: false, hasPersona: false },
        }
      : {
          storage: 'full',
          value: { prompt: [{ type: 'text', text: options.secretPrompt }] },
          redactions: 0,
        },
    timing: {
      startedAt: new Date(sequence * 1_000).toISOString(),
      startLatencyMs: 1,
      durationMs: options.durationMs ?? 10,
    },
    published: options.outcome?.kind === 'start-error' ? false : true,
    local: options.local ?? false,
    outcome: options.outcome ?? { kind: 'result', result: textResult(`result-${options.key}`), redactions: 0 },
    previousHash: digest('0'),
    hash: digest('f'),
  }
}

function cassette(interactions: CassetteInteraction[], cassetteHeader = header()): CassetteFile {
  return { header: cassetteHeader, interactions }
}

describe('cassette diff', () => {
  it('ignores cassette identity, physical order, sequence, timestamps, and timing', () => {
    const first = interaction({ key: 'a', sequence: 1, request: digest('a'), durationMs: 10 })
    const second = interaction({ key: 'b', sequence: 2, request: digest('b'), durationMs: 20 })
    const expected = cassette([first, second])
    const actual = cassette([
      {
        ...second,
        sequence: 1,
        timing: { ...second.timing, startedAt: new Date(9_000).toISOString(), startLatencyMs: 2, durationMs: 5 },
      },
      {
        ...first,
        sequence: 2,
        timing: { ...first.timing, startedAt: new Date(8_000).toISOString(), startLatencyMs: 3, durationMs: 40 },
      },
    ])

    const result = diffCassettes(expected, actual)
    expect(result).toMatchObject({ comparable: true, equivalent: true, added: [], removed: [] })
    expect(result.timing.map(item => item.deltaMs)).toEqual([30, -15])
    expect(result.timing.map(item => item.startLatencyDeltaMs)).toEqual([2, 1])
  })

  it('classifies added, removed, outcome, and boundary changes independently', () => {
    const expected = cassette([
      interaction({ key: 'a', sequence: 1, request: digest('a') }),
      interaction({ key: 'b', sequence: 2, request: digest('b') }),
      interaction({ key: 'c', sequence: 3, request: digest('c') }),
    ])
    const actual = cassette([
      interaction({
        key: 'a', sequence: 1, request: digest('a'),
        outcome: { kind: 'result', result: textResult('changed'), redactions: 0 },
      }),
      interaction({ key: 'c', sequence: 2, request: digest('c'), local: true }),
      interaction({ key: 'd', sequence: 3, request: digest('d') }),
    ])

    const result = diffCassettes(expected, actual)
    expect(result.equivalent).toBe(false)
    expect(result.added.map(item => item.callKey)).toEqual(['root/d~1'])
    expect(result.removed.map(item => item.callKey)).toEqual(['root/b~1'])
    expect(result.outcomeChanged).toHaveLength(1)
    expect(result.boundaryChanged).toMatchObject([{ fields: ['local'] }])
  })

  it('reports policy drift and refuses changed parent-context semantics', () => {
    const expected = cassette([], header({ upstream: 'spawn' }))
    const actual = cassette([], header({ upstream: 'fork', inheritsParentContext: true }))

    expect(diffCassettes(expected, actual)).toMatchObject({
      comparable: false,
      equivalent: false,
      policyChanges: ['provider.upstream', 'provider.inheritsParentContext'],
      issues: ['parent-context-semantics-changed'],
    })
  })

  it('fails closed for ambiguous duplicate outcome groups', () => {
    const first = interaction({ key: 'repeat', sequence: 1, request: digest('a'), occurrence: 1 })
    const second = interaction({
      key: 'repeat', sequence: 2, request: digest('a'), occurrence: 2,
      outcome: { kind: 'result', result: textResult('different'), redactions: 0 },
    })
    const result = diffCassettes(cassette([first, second]), cassette([first, second]))

    expect(result).toMatchObject({
      comparable: false,
      equivalent: false,
      expectedAmbiguousGroups: 1,
      actualAmbiguousGroups: 1,
      issues: ['expected-ambiguous-duplicate-groups', 'actual-ambiguous-duplicate-groups'],
    })
  })

  it('never exposes full prompts, result bodies, or error messages', () => {
    const promptSecret = 'private-prompt-sentinel'
    const expectedSecret = 'private-result-sentinel'
    const actualSecret = 'private-error-sentinel'
    const expected = cassette([interaction({
      key: 'secret', request: digest('e'), secretPrompt: promptSecret,
      outcome: { kind: 'result', result: textResult(expectedSecret), redactions: 0 },
    })], header({ requestStorage: 'full' }))
    const actual = cassette([interaction({
      key: 'secret', request: digest('e'), secretPrompt: promptSecret,
      outcome: { kind: 'result-error', error: { name: 'Error', message: actualSecret } },
    })], header({ requestStorage: 'full' }))

    const serialized = JSON.stringify(diffCassettes(expected, actual))
    expect(serialized).not.toContain(promptSecret)
    expect(serialized).not.toContain(expectedSecret)
    expect(serialized).not.toContain(actualSecret)
    expect(serialized).toContain('outcomeFingerprint')
  })

  it('maps private extensible stop reasons to a bounded category', () => {
    const expectedReason = 'PRIVATE_EXPECTED_REASON'
    const actualReason = 'PRIVATE_ACTUAL_REASON'
    const expected = cassette([interaction({
      key: 'private-reason',
      outcome: {
        kind: 'result',
        result: { ...textResult('same'), stopReason: expectedReason },
        redactions: 0,
      } as unknown as CassetteOutcome,
    })])
    const actual = cassette([interaction({
      key: 'private-reason',
      outcome: {
        kind: 'result',
        result: { ...textResult('same'), stopReason: actualReason },
        redactions: 0,
      } as unknown as CassetteOutcome,
    })])

    const result = diffCassettes(expected, actual)
    const serialized = JSON.stringify(result)
    expect(result.outcomeChanged[0]).toMatchObject({
      expected: { stopReason: 'other' },
      actual: { stopReason: 'other' },
    })
    expect(serialized).not.toContain(expectedReason)
    expect(serialized).not.toContain(actualReason)
  })
})
