import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  canonicalStringify,
  fingerprintParentContext,
  fingerprintRequest,
  normalizeParentContext,
  normalizeRequest,
  requestMetadata,
} from '../src/canonical.ts'
import { redactJson } from '../src/redact.ts'
import { TopologyTracker } from '../src/topology.ts'
import type { JsonValue } from '../src/types.ts'
import { fakeAgent, request } from './helpers.ts'

function completedHistory(
  identity: string,
  resultText = 'done',
  rawCallId = `call-${identity}`,
): SessionEvent[] {
  const callId = CallId(rawCallId)
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      surfaceOp: 'append',
      data: {
        id: MessageId(`user-${identity}`),
        role: 'user',
        content: [{ type: 'text', text: 'run the tool' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId(`assistant-${identity}`),
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 4,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId(`tool-${identity}`),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: resultText }],
          }],
          source: { kind: 'tool', callId },
        },
      },
    },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function agentWith(
  id: string,
  options: {
    readonly events?: SessionEvent[]
    readonly agentOptions?: Record<string, unknown>
    readonly header?: Record<string, unknown>
    readonly system?: string
    readonly tools?: unknown[]
    readonly composedPreset?: string
    readonly sandboxMode?: string
    readonly approval?: boolean
  } = {},
): Agent {
  const base = fakeAgent(id)
  const events = [...(options.events ?? [])]
  if (options.system !== undefined || options.tools !== undefined) {
    events.push({
      type: 'request/header',
      seq: events.length,
      time: 10,
      data: {
        reason: 'change',
        header: {
          config: { provider: 'deepseek', model: 'deepseek-chat' },
          ...(options.system === undefined ? {} : { system: options.system }),
          ...(options.tools === undefined ? {} : { tools: options.tools }),
        },
      },
    } as SessionEvent)
  }
  const services: Record<string, unknown> = {
    ...(options.composedPreset === undefined ? {} : {
      agentPresets: { composedPreset: () => options.composedPreset },
    }),
    ...(options.sandboxMode === undefined ? {} : {
      sandboxPolicy: { overrideOf: () => options.sandboxMode },
    }),
    ...(options.approval ? { approval: {} } : {}),
  }
  return {
    ...base,
    options: options.agentOptions ?? {},
    ctx: { get: (name: string) => services[name] } as Agent['ctx'],
    session: {
      ...base.session,
      events,
      header: { ...base.session.header, ...options.header },
    },
  } as unknown as Agent
}

describe('canonical request identity', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: [3, 1] } })).toBe('{"a":{"x":[3,1],"y":2},"z":1}')
  })

  it('excludes volatile parent, signal, and descriptor provider fields', () => {
    const first = request('audit', fakeAgent('root-a'))
    const secondBase = request('audit', fakeAgent('root-b'))
    const second = {
      ...secondBase,
      descriptor: { ...secondBase.descriptor, provider: 'different-live-provider' },
    }
    expect(fingerprintRequest(normalizeRequest(first))).toBe(fingerprintRequest(normalizeRequest(second)))
  })

  it('changes the fingerprint when semantic request content changes', () => {
    const first = normalizeRequest(request('audit'))
    const changed = request('audit')
    changed.prompt[0] = { type: 'text', text: 'different' }
    expect(fingerprintRequest(first)).not.toBe(fingerprintRequest(normalizeRequest(changed)))
  })

  it('summarizes a request without retaining prompt text', () => {
    const live = {
      ...request('private-label'),
      agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
    }
    const metadata = requestMetadata(normalizeRequest(live))
    expect(metadata).toMatchObject({
      label: 'private-label',
      promptBlocks: 1,
      childProvider: 'deepseek',
      childModel: 'deepseek-v4',
    })
    expect(JSON.stringify(metadata)).not.toContain('prompt:private-label')
  })
})

describe('canonical parent context identity', () => {
  it('normalizes volatile session, message, and correlated tool-call ids', () => {
    const first = agentWith('session-a', { events: completedHistory('a', 'same', 'random-a') })
    const second = agentWith('session-b', { events: completedHistory('b', 'same', 'random-b') })
    expect(fingerprintParentContext(normalizeParentContext(first, true)))
      .toBe(fingerprintParentContext(normalizeParentContext(second, true)))

    const recorded = new TopologyTracker(true).reserve(request('audit', first))
    const replayed = new TopologyTracker(true).reserve(request('audit', second))
    expect(replayed).toMatchObject({
      parentKey: recorded.parentKey,
      parentContextFingerprint: recorded.parentContextFingerprint,
      requestFingerprint: recorded.requestFingerprint,
      callKey: recorded.callKey,
    })
  })

  it('fingerprints completed model-visible history only for inheriting providers', () => {
    const first = agentWith('first', { events: completedHistory('a', 'first') })
    const second = agentWith('second', { events: completedHistory('b', 'second') })
    expect(fingerprintParentContext(normalizeParentContext(first, true)))
      .not.toBe(fingerprintParentContext(normalizeParentContext(second, true)))
    expect(fingerprintParentContext(normalizeParentContext(first, false)))
      .toBe(fingerprintParentContext(normalizeParentContext(second, false)))
  })

  it('excludes an incomplete live turn from inherited history', () => {
    const completed = completedHistory('a')
    const withInflight = [
      ...completed,
      { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } },
      {
        type: 'user/message', seq: 6, time: 7, surfaceOp: 'append',
        data: {
          id: MessageId('inflight'), role: 'user',
          content: [{ type: 'text', text: 'not inherited' }], source: { kind: 'user' },
        },
      },
    ] as SessionEvent[]
    const first = agentWith('a', { events: completed })
    const second = agentWith('b', {
      events: withInflight,
      system: 'also excluded with the open turn',
    })
    expect(fingerprintParentContext(normalizeParentContext(first, true)))
      .toBe(fingerprintParentContext(normalizeParentContext(second, true)))
  })

  it('captures stable route, workspace, composition, and delegated policy facts', () => {
    const baseline = fingerprintParentContext(normalizeParentContext(agentWith('base'), false))
    const variants = [
      agentWith('options', { agentOptions: { provider: 'deepseek', model: 'reasoner', maxTokens: 4_096 } }),
      agentWith('header', { header: { cwd: 'C:\\workspace', delegationDepth: 2, agentPreset: 'coding' } }),
      agentWith('preset', { composedPreset: 'live-coding' }),
      agentWith('sandbox', { sandboxMode: 'workspace-write' }),
      agentWith('approval', { approval: true }),
    ]
    for (const variant of variants) {
      expect(fingerprintParentContext(normalizeParentContext(variant, false))).not.toBe(baseline)
    }
  })

  it('stores only a digest and keeps call keys unique across context changes', () => {
    const secret = 'customer-secret-value'
    const first = agentWith('same-parent', {
      events: completedHistory('secret-a', secret),
      agentOptions: { provider: 'deepseek', apiKey: secret },
      header: { cwd: `C:\\private\\${secret}` },
    })
    const second = agentWith('same-parent', {
      events: completedHistory('secret-b', secret),
      agentOptions: { provider: 'deepseek' },
      header: { cwd: 'C:\\public' },
    })
    const topology = new TopologyTracker(true)
    const firstCall = topology.reserve(request('same', first))
    const secondCall = topology.reserve(request('same', second))

    expect(firstCall.parentContextFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(firstCall)).not.toContain(secret)
    expect(firstCall.callKey).not.toBe(secondCall.callKey)
    expect(firstCall.occurrence).toBe(1)
    expect(secondCall.occurrence).toBe(1)
  })
})

describe('redaction', () => {
  it('redacts secret keys and common credential forms recursively', () => {
    const redacted = redactJson({
      apiKey: 'top-secret',
      nested: ['Bearer abcdefghijklmnop', 'ghp_abcdefghijklmnop'],
      text: 'token=abcdefghijkl',
    })
    expect(redacted.count).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(redacted.value)).not.toContain('top-secret')
    expect(JSON.stringify(redacted.value)).not.toContain('abcdefghijkl')
  })

  it('can be disabled explicitly', () => {
    const value: JsonValue = { token: 'keep-me' }
    expect(redactJson(value, false)).toEqual({ value, count: 0 })
  })

  it('applies deployment-specific patterns', () => {
    const redacted = redactJson('customer-12345', true, ['customer-[0-9]+'])
    expect(redacted).toEqual({ value: '[REDACTED]', count: 1 })
  })

  it('rejects an invalid custom expression during installation', () => {
    expect(() => redactJson('value', true, ['[unterminated'])).toThrow(/invalid cassette redaction pattern/)
  })
})
