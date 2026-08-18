import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { CassetteAmbiguityError, CassetteMismatchError } from '../src/errors.ts'
import { CassetteWriter, createHeader, loadCassette } from '../src/format.ts'
import { RecordingSubagentProvider, ReplaySubagentProvider } from '../src/provider.ts'
import { InteractionMatcher } from '../src/topology.ts'
import type { CassetteInteractionBody } from '../src/types.ts'
import {
  fakeAgent,
  pendingRun,
  QueueProvider,
  request,
  tempWorkspace,
  textResult,
  type TempWorkspace,
} from './helpers.ts'

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

async function setupRecorder(options?: {
  redactSecrets?: boolean
  requestStorage?: 'metadata' | 'full'
  redactionPatterns?: string[]
}) {
  const temp = await tempWorkspace()
  workspaces.push(temp)
  const upstream = new QueueProvider()
  const header = createHeader({
    cassette: 'cassette',
    upstream: upstream.name,
    capabilities: upstream.capabilities,
    inheritsParentContext: upstream.inheritsParentContext,
    requestStorage: options?.requestStorage ?? 'metadata',
    redactSecrets: options?.redactSecrets ?? false,
    ...(options?.redactionPatterns === undefined ? {} : { redactionPatterns: options.redactionPatterns }),
  })
  const writer = await CassetteWriter.open(temp.path(), header, 'create')
  const recorder = new RecordingSubagentProvider('cassette', upstream, writer, {
    requestStorage: options?.requestStorage ?? 'metadata',
    redactSecrets: options?.redactSecrets ?? false,
    ...(options?.redactionPatterns === undefined ? {} : { redactionPatterns: options.redactionPatterns }),
  })
  return { temp, upstream, writer, recorder }
}

describe('record and strict replay', () => {
  it('records metadata by default without storing prompt text', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const run = await recorder.start(request('private'))
    upstream.pending[0]?.resolve(textResult('answer'))
    await expect(run.result).resolves.toEqual(textResult('answer'))
    await run.dispose()
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions[0]?.request.storage).toBe('metadata')
    expect(JSON.stringify(cassette)).not.toContain('prompt:private')
  })

  it('redacts content without changing content-block discriminators or image media types', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder({
      redactSecrets: true,
      requestStorage: 'full',
      redactionPatterns: ['^secret-name$'],
    })
    const run = await recorder.start(request('structure'))
    upstream.pending[0]?.resolve({
      output: [{
        type: 'image',
        attachment: {
          attachmentId: 'attachment-1',
          mediaType: 'image/png',
          bytes: 10,
          width: 1,
          height: 1,
          name: 'secret-name',
        },
      }],
      stopReason: 'completed',
    } as unknown as SubagentResult)
    await run.result
    await run.dispose()
    await writer.close()

    const cassette = await loadCassette(temp.path())
    const interaction = cassette.interactions[0]
    expect(interaction?.request).toMatchObject({
      storage: 'full',
      value: { prompt: [{ type: 'text' }] },
      redactions: 0,
    })
    expect(interaction?.outcome).toMatchObject({
      kind: 'result',
      result: {
        output: [{
          type: 'image',
          attachment: { mediaType: 'image/png', name: '[REDACTED]' },
        }],
      },
      redactions: 1,
    })
  })

  it('rejects redaction patterns that would alter protected content-block fields', async () => {
    const requestFixture = await setupRecorder({
      redactSecrets: true,
      requestStorage: 'full',
      redactionPatterns: ['^secret-structure$'],
    })
    const unsafeRequest = request('structure')
    unsafeRequest.prompt[0] = { type: 'secret-structure' } as never
    await expect(requestFixture.recorder.start(unsafeRequest)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    })
    expect(requestFixture.upstream.pending).toHaveLength(0)
    const validRun = await requestFixture.recorder.start(request('valid-after-rejection'))
    requestFixture.upstream.pending[0]?.resolve(textResult('recorded'))
    await validRun.result
    await validRun.dispose()
    await requestFixture.writer.close()
    expect((await loadCassette(requestFixture.temp.path())).interactions)
      .toMatchObject([{ sequence: 1 }])

    const resultFixture = await setupRecorder({
      redactSecrets: true,
      redactionPatterns: ['^image/png$'],
    })
    const run = await resultFixture.recorder.start(request('structure'))
    resultFixture.upstream.pending[0]?.resolve({
      output: [{
        type: 'image',
        attachment: {
          attachmentId: 'attachment-1',
          mediaType: 'image/png',
          bytes: 10,
          width: 1,
          height: 1,
        },
      }],
      stopReason: 'completed',
    } as unknown as SubagentResult)
    await expect(run.result).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await run.dispose()
    await resultFixture.writer.close()
    expect((await loadCassette(resultFixture.temp.path())).interactions[0]?.outcome)
      .toMatchObject({ kind: 'result-error' })
  })

  it('continues recording after an invalid parent context without topology gaps', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const invalidParent = {
      ...fakeAgent('invalid-root'),
      options: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: Number.NaN },
    }
    await expect(recorder.start(request('invalid-parent', invalidParent))).rejects
      .toThrow(/lossless plain JSON/)
    expect(upstream.pending).toHaveLength(0)

    const run = await recorder.start(request('valid-parent', fakeAgent('valid-root')))
    upstream.pending[0]?.resolve(textResult('recorded'))
    await run.result
    await run.dispose()
    await writer.close()
    expect((await loadCassette(temp.path())).interactions).toMatchObject([{ sequence: 1 }])
  })

  it('continues occurrence numbers when a recording is appended', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const firstUpstream = new QueueProvider()
    const initialHeader = createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: firstUpstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    })
    const firstWriter = await CassetteWriter.open(temp.path(), initialHeader, 'create')
    const firstRecorder = new RecordingSubagentProvider('cassette', firstUpstream, firstWriter, {
      requestStorage: 'metadata', redactSecrets: false,
    })
    const first = await firstRecorder.start(request('repeat'))
    firstUpstream.pending[0]?.resolve(textResult('one'))
    await first.result
    await first.dispose()
    await firstWriter.close()

    const secondUpstream = new QueueProvider()
    const secondWriter = await CassetteWriter.open(temp.path(), initialHeader, 'append')
    const secondRecorder = new RecordingSubagentProvider('cassette', secondUpstream, secondWriter, {
      requestStorage: 'metadata', redactSecrets: false,
    })
    const second = await secondRecorder.start(request('repeat', fakeAgent('new-root')))
    secondUpstream.pending[0]?.resolve(textResult('two'))
    await second.result
    await second.dispose()
    await secondWriter.close()
    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions.map(item => item.occurrence)).toEqual([1, 2])
    expect(new Set(cassette.interactions.map(item => item.callKey)).size).toBe(2)
  })

  it('matches concurrent siblings by request fingerprint when completion and replay order reverse', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const parent = fakeAgent('record-root')
    const runA = await recorder.start(request('alpha', parent))
    const runB = await recorder.start(request('beta', parent))
    upstream.pending[1]?.resolve(textResult('B'))
    await expect(runB.result).resolves.toEqual(textResult('B'))
    upstream.pending[0]?.resolve(textResult('A'))
    await expect(runA.result).resolves.toEqual(textResult('A'))
    await Promise.all([runA.dispose(), runB.dispose()])
    await writer.close()

    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions.map(item => item.sequence)).toEqual([2, 1])
    const matcher = new InteractionMatcher(cassette, 'reject', false)
    const replay = new ReplaySubagentProvider('cassette', matcher, cassette.header.provider, {
      timing: 'instant',
      speed: 1,
    })
    const liveParent = fakeAgent('fresh-root')
    const replayB = await replay.start(request('beta', liveParent))
    const replayA = await replay.start(request('alpha', liveParent))
    await expect(replayB.result).resolves.toEqual(textResult('B'))
    await expect(replayA.result).resolves.toEqual(textResult('A'))
    matcher.assertConsumed()
  })

  it('fails loud when no request fingerprint matches', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const run = await recorder.start(request('known'))
    upstream.pending[0]?.resolve(textResult('answer'))
    await run.result
    await run.dispose()
    await writer.close()
    const cassette = await loadCassette(temp.path())
    const matcher = new InteractionMatcher(cassette, 'reject', false)
    expect(matcher.describe(request('known'))).toContain('prompt:known')
    expect(() => matcher.match(request('unknown'))).toThrow(CassetteMismatchError)
  })

  it('rejects the same request when durable parent context changed', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const recordedParent = { ...fakeAgent('record-root'), options: { model: 'deepseek-chat' } }
    const run = await recorder.start(request('known', recordedParent))
    upstream.pending[0]?.resolve(textResult('answer'))
    await run.result
    await run.dispose()
    await writer.close()

    const cassette = await loadCassette(temp.path())
    const matcher = new InteractionMatcher(cassette, 'reject', false)
    const replayParent = { ...fakeAgent('replay-root'), options: { model: 'deepseek-reasoner' } }
    expect(() => matcher.match(request('known', replayParent))).toThrow(CassetteMismatchError)
  })

  it('reports unconsumed interactions at teardown', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const run = await recorder.start(request('unused'))
    upstream.pending[0]?.resolve(textResult('answer'))
    await run.result
    await run.dispose()
    await writer.close()
    const matcher = new InteractionMatcher(await loadCassette(temp.path()), 'reject', false)
    expect(() => matcher.assertConsumed()).toThrow(/not consumed/)
  })
})

describe('ambiguity and topology', () => {
  it('records nested calls under the stable path of a local child', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const localChild = fakeAgent('local-child', 'subagent')
    const template = new QueueProvider()
    const pending: ReturnType<typeof pendingRun>[] = []
    const upstream: SubagentProvider = {
      name: 'spawn',
      capabilities: template.capabilities,
      inheritsParentContext: false,
      start: async (liveRequest: ResolvedSubagentStartRequest) => {
        const item = pendingRun(
          `child-${pending.length + 1}`,
          liveRequest.label === 'outer' ? localChild : undefined,
        )
        pending.push(item)
        return item.run
      },
    }
    const writer = await CassetteWriter.open(temp.path(), createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: upstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    }), 'create')
    const recorder = new RecordingSubagentProvider('cassette', upstream, writer, {
      requestStorage: 'metadata', redactSecrets: false,
    })

    const outer = await recorder.start(request('outer', fakeAgent('record-root')))
    expect(outer.localAgent).toBe(localChild)
    const nested = await recorder.start(request('nested', localChild))
    pending[1]?.resolve(textResult('nested-result'))
    pending[0]?.resolve(textResult('outer-result'))
    await Promise.all([outer.result, nested.result])
    await Promise.all([outer.dispose(), nested.dispose()])
    await writer.close()

    const cassette = await loadCassette(temp.path())
    const outerInteraction = cassette.interactions.find(item => item.parentKey === 'root')
    const nestedInteraction = cassette.interactions.find(item => item.parentKey !== 'root')
    expect(outerInteraction).toMatchObject({ parentKey: 'root', local: true })
    expect(nestedInteraction?.parentKey).toBe(outerInteraction?.callKey)
  })

  it('rejects identical requests with different recorded outcomes by default', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const parent = fakeAgent()
    const first = await recorder.start(request('same', parent))
    const second = await recorder.start(request('same', parent))
    upstream.pending[0]?.resolve(textResult('first'))
    upstream.pending[1]?.resolve(textResult('second'))
    await Promise.all([first.result, second.result])
    await Promise.all([first.dispose(), second.dispose()])
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(() => new InteractionMatcher(cassette, 'reject', false)).toThrow(CassetteAmbiguityError)
  })

  it('allows explicit sequence matching for duplicate requests', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const parent = fakeAgent()
    const first = await recorder.start(request('same', parent))
    const second = await recorder.start(request('same', parent))
    upstream.pending[1]?.resolve(textResult('second'))
    upstream.pending[0]?.resolve(textResult('first'))
    await Promise.all([first.result, second.result])
    await Promise.all([first.dispose(), second.dispose()])
    await writer.close()
    const cassette = await loadCassette(temp.path())
    const matcher = new InteractionMatcher(cassette, 'sequence', false)
    const replay = new ReplaySubagentProvider('cassette', matcher, cassette.header.provider, {
      timing: 'instant',
      speed: 1,
    })
    const liveParent = fakeAgent('fresh')
    await expect((await replay.start(request('same', liveParent))).result).resolves.toEqual(textResult('first'))
    await expect((await replay.start(request('same', liveParent))).result).resolves.toEqual(textResult('second'))
  })

  it('rejects multiple top-level roots in one recording', async () => {
    const { upstream, writer, recorder } = await setupRecorder()
    const first = await recorder.start(request('one', fakeAgent('root-one')))
    await expect(recorder.start(request('two', fakeAgent('root-two')))).rejects.toThrow(/more than one top-level parent/)
    upstream.pending[0]?.resolve(textResult('done'))
    await first.result
    await first.dispose()
    await writer.close()
  })
})

describe('failures, redaction, and cancellation', () => {
  it('stores a redacted full request only when full request storage is explicit', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder({
      requestStorage: 'full',
      redactSecrets: true,
    })
    const liveRequest = request('full-request')
    liveRequest.prompt[0] = { type: 'text', text: 'Bearer abcdefghijklmnop' }
    const run = await recorder.start(liveRequest)
    upstream.pending[0]?.resolve(textResult('done'))
    await run.result
    await run.dispose()
    await writer.close()

    const stored = (await loadCassette(temp.path())).interactions[0]?.request
    expect(stored).toMatchObject({ storage: 'full', redactions: 1 })
    expect(JSON.stringify(stored)).not.toContain('abcdefghijklmnop')
  })

  it('records and replays provider startup rejection before publication', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const failure = Object.assign(new Error('provider offline'), { code: 'OFFLINE' })
    upstream.startError = failure
    await expect(recorder.start(request('fails'))).rejects.toBe(failure)
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions[0]).toMatchObject({ published: false, outcome: { kind: 'start-error' } })
    const replay = new ReplaySubagentProvider(
      'cassette',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'instant', speed: 1 },
    )
    await expect(replay.start(request('fails', fakeAgent('fresh')))).rejects.toMatchObject({ code: 'OFFLINE' })
  })

  it('records and replays infrastructure rejection after publication', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const run = await recorder.start(request('breaks'))
    upstream.pending[0]?.reject(Object.assign(new Error('transport broke'), { code: 'TRANSPORT' }))
    await expect(run.result).rejects.toThrow('transport broke')
    await run.dispose()
    await writer.close()
    const cassette = await loadCassette(temp.path())
    const replay = new ReplaySubagentProvider(
      'cassette',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'instant', speed: 1 },
    )
    await expect((await replay.start(request('breaks', fakeAgent('fresh')))).result)
      .rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('records a non-JSON upstream result as a replayable infrastructure error', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder()
    const run = await recorder.start(request('invalid-result'))
    const invalid = {
      output: [{ type: 'text', text: 'invalid', extra: undefined }],
      stopReason: 'completed',
    } as unknown as SubagentResult
    upstream.pending[0]?.resolve(invalid)
    await expect(run.result).rejects.toThrow(/not lossless plain JSON/)
    await run.dispose()
    await writer.close()

    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions[0]?.outcome).toMatchObject({
      kind: 'result-error',
      error: { name: 'TypeError' },
    })
    const replay = new ReplaySubagentProvider(
      'cassette', new InteractionMatcher(cassette, 'reject', false), cassette.header.provider,
      { timing: 'instant', speed: 1 },
    )
    await expect((await replay.start(request('invalid-result', fakeAgent('fresh')))).result)
      .rejects.toThrow(/not lossless plain JSON/)
  })

  it('records signal and disposal timing while settling an admitted run', async () => {
    const { temp, writer, recorder } = await setupRecorder()
    const controller = new AbortController()
    const run = await recorder.start(request('cancelled', fakeAgent(), controller.signal))
    controller.abort(new Error('caller cancelled'))
    await run.dispose()
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    await writer.close()

    const recorded = (await loadCassette(temp.path())).interactions[0]
    expect(recorded?.timing.signalAbortedAtMs).toBeTypeOf('number')
    expect(recorded?.timing.disposeCalledAtMs).toBeTypeOf('number')
    expect(recorded?.outcome).toMatchObject({
      kind: 'result',
      result: { stopReason: 'aborted' },
    })
  })

  it('shares one quiescence promise across concurrent disposal calls', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const template = new QueueProvider()
    const pending = pendingRun('child-disposal')
    let releaseDisposal!: () => void
    const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve })
    let upstreamDisposals = 0
    const upstream: SubagentProvider = {
      name: 'spawn',
      capabilities: template.capabilities,
      inheritsParentContext: false,
      start: async () => ({
        ...pending.run,
        dispose: async () => {
          upstreamDisposals++
          await disposalGate
          pending.resolve({ output: [], stopReason: 'aborted' })
        },
      }),
    }
    const writer = await CassetteWriter.open(temp.path(), createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: upstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    }), 'create')
    const recorder = new RecordingSubagentProvider('cassette', upstream, writer, {
      requestStorage: 'metadata', redactSecrets: false,
    })
    const run = await recorder.start(request('dispose-once'))

    const first = run.dispose()
    const second = run.dispose()
    expect(second).toBe(first)
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await new Promise(resolve => { setImmediate(resolve) })
    expect(secondSettled).toBe(false)
    expect(upstreamDisposals).toBe(1)

    releaseDisposal()
    await Promise.all([first, second])
    await writer.close()
  })

  it('records deeply nested valid JSON results without recursive redaction failure', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder({ redactSecrets: true })
    let structured: unknown = 'leaf'
    for (let depth = 0; depth < 20_000; depth++) structured = { next: structured }
    const run = await recorder.start(request('deep-result'))
    upstream.pending[0]?.resolve({ output: [], stopReason: 'completed', structured })

    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
    await writer.close()
    expect((await loadCassette(temp.path())).interactions[0]?.outcome.kind).toBe('result')
  })

  it('refuses redacted output unless the caller opts into substituted replay', async () => {
    const { temp, upstream, writer, recorder } = await setupRecorder({ redactSecrets: true })
    const run = await recorder.start(request('secret'))
    upstream.pending[0]?.resolve(textResult('token=abcdefghijklmnop'))
    await expect(run.result).resolves.toEqual(textResult('token=abcdefghijklmnop'))
    await run.dispose()
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions[0]?.outcome).toMatchObject({ kind: 'result', redactions: 1 })
    expect(() => new InteractionMatcher(cassette, 'reject', false)).toThrow(/redacted result/)
    const matcher = new InteractionMatcher(cassette, 'reject', true)
    const replay = new ReplaySubagentProvider('cassette', matcher, cassette.header.provider, {
      timing: 'instant', speed: 1,
    })
    await expect((await replay.start(request('secret', fakeAgent('fresh')))).result)
      .resolves.toEqual(textResult('token=[REDACTED]'))
  })

  it('honors live disposal while replaying recorded timing', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const upstream = new QueueProvider()
    const writer = await CassetteWriter.open(temp.path(), createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: upstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    }), 'create')
    const liveRequest = request('slow')
    const normalized = (await import('../src/canonical.ts')).normalizeRequest(liveRequest)
    const fingerprint = (await import('../src/canonical.ts')).fingerprintRequest(normalized)
    const parentContextFingerprint = (await import('../src/canonical.ts')).fingerprintParentContext(
      (await import('../src/canonical.ts')).normalizeParentContext(liveRequest.parent, false),
    )
    const body: CassetteInteractionBody = {
      kind: 'cassette/interaction', sequence: 1, callKey: 'root/slow~1', parentKey: 'root', occurrence: 1,
      parentContextFingerprint,
      requestFingerprint: fingerprint,
      request: { storage: 'metadata', metadata: { promptBlocks: 1, promptBytes: 10, hasOutputSchema: false, hasPersona: false } },
      timing: { startedAt: new Date().toISOString(), startLatencyMs: 0, durationMs: 5_000 },
      published: true, local: false,
      outcome: { kind: 'result', result: textResult('late'), redactions: 0 },
    }
    await writer.append(body)
    await writer.close()
    const cassette = await loadCassette(temp.path())
    const replay = new ReplaySubagentProvider(
      'cassette', new InteractionMatcher(cassette, 'reject', false), cassette.header.provider,
      { timing: 'recorded', speed: 1 },
    )
    const run = await replay.start(request('slow', fakeAgent('fresh')))
    await run.dispose()
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
  })

  it('rejects underflowing replay speeds and overflowing scaled delays', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const upstream = new QueueProvider()
    const writer = await CassetteWriter.open(temp.path(), createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: upstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    }), 'create')
    const liveRequest = request('extreme-timing')
    const canonical = await import('../src/canonical.ts')
    const normalized = canonical.normalizeRequest(liveRequest)
    await writer.append({
      kind: 'cassette/interaction', sequence: 1, callKey: 'root/extreme~1', parentKey: 'root', occurrence: 1,
      parentContextFingerprint: canonical.fingerprintParentContext(
        canonical.normalizeParentContext(liveRequest.parent, false),
      ),
      requestFingerprint: canonical.fingerprintRequest(normalized),
      request: { storage: 'metadata', metadata: canonical.requestMetadata(normalized) },
      timing: {
        startedAt: new Date().toISOString(),
        startLatencyMs: Number.MAX_VALUE,
        durationMs: Number.MAX_VALUE,
      },
      published: true,
      local: false,
      outcome: { kind: 'result', result: textResult('never delayed'), redactions: 0 },
    })
    await writer.close()
    const cassette = await loadCassette(temp.path())

    expect(() => new ReplaySubagentProvider(
      'cassette',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'recorded', speed: Number.MIN_VALUE },
    )).toThrow(/greater than or equal to 0\.001/)

    const replay = new ReplaySubagentProvider(
      'cassette',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'recorded', speed: 0.001 },
    )
    await expect(replay.start(request('extreme-timing', fakeAgent('fresh'))))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('aborts replay before publication during recorded startup latency', async () => {
    const temp = await tempWorkspace()
    workspaces.push(temp)
    const upstream = new QueueProvider()
    const writer = await CassetteWriter.open(temp.path(), createHeader({
      cassette: 'cassette', upstream: 'spawn', capabilities: upstream.capabilities,
      inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
    }), 'create')
    const liveRequest = request('slow-start')
    const normalized = (await import('../src/canonical.ts')).normalizeRequest(liveRequest)
    const fingerprint = (await import('../src/canonical.ts')).fingerprintRequest(normalized)
    const parentContextFingerprint = (await import('../src/canonical.ts')).fingerprintParentContext(
      (await import('../src/canonical.ts')).normalizeParentContext(liveRequest.parent, false),
    )
    await writer.append({
      kind: 'cassette/interaction', sequence: 1, callKey: 'root/slow-start~1', parentKey: 'root', occurrence: 1,
      parentContextFingerprint,
      requestFingerprint: fingerprint,
      request: { storage: 'metadata', metadata: { promptBlocks: 1, promptBytes: 10, hasOutputSchema: false, hasPersona: false } },
      timing: { startedAt: new Date().toISOString(), startLatencyMs: 5_000, durationMs: 5_000 },
      published: true, local: false,
      outcome: { kind: 'result', result: textResult('late'), redactions: 0 },
    })
    await writer.close()
    const cassette = await loadCassette(temp.path())
    const replay = new ReplaySubagentProvider(
      'cassette', new InteractionMatcher(cassette, 'reject', false), cassette.header.provider,
      { timing: 'recorded', speed: 1 },
    )
    const controller = new AbortController()
    const publication = replay.start(request('slow-start', fakeAgent('fresh'), controller.signal))
    controller.abort(new Error('cancel before publication'))
    await expect(publication).rejects.toMatchObject({ recordedName: 'AbortError', code: 'ABORTED' })
  })
})
