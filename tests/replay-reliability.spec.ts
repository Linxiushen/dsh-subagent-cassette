import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fingerprintParentContext,
  fingerprintRequest,
  normalizeParentContext,
  normalizeRequest,
  requestMetadata,
} from '../src/canonical.ts'
import { CassetteWriter, createHeader, loadCassette } from '../src/format.ts'
import { ReplaySubagentProvider } from '../src/provider.ts'
import { InteractionMatcher } from '../src/topology.ts'
import type { CassetteInteractionBody, CassetteTiming } from '../src/types.ts'
import {
  fakeAgent,
  QueueProvider,
  request,
  tempWorkspace,
  textResult,
  type TempWorkspace,
} from './helpers.ts'

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

async function cassetteWithTiming(label: string, timing: CassetteTiming) {
  const temp = await tempWorkspace()
  workspaces.push(temp)
  const upstream = new QueueProvider()
  const writer = await CassetteWriter.open(temp.path(), createHeader({
    cassette: 'cassette',
    upstream: upstream.name,
    capabilities: upstream.capabilities,
    inheritsParentContext: false,
    requestStorage: 'metadata',
    redactSecrets: false,
  }), 'create')
  const liveRequest = request(label)
  const normalized = normalizeRequest(liveRequest)
  const interaction: CassetteInteractionBody = {
    kind: 'cassette/interaction',
    sequence: 1,
    callKey: `root/${label}~1`,
    parentKey: 'root',
    parentContextFingerprint: fingerprintParentContext(normalizeParentContext(liveRequest.parent, false)),
    occurrence: 1,
    requestFingerprint: fingerprintRequest(normalized),
    request: { storage: 'metadata', metadata: requestMetadata(normalized) },
    timing,
    published: true,
    local: false,
    outcome: { kind: 'result', result: textResult('replayed'), redactions: 0 },
  }
  await writer.append(interaction)
  await writer.close()
  return loadCassette(temp.path())
}

describe('replay reliability boundaries', () => {
  it('mints unique remote run ids for separate replay providers in one parent namespace', async () => {
    const cassette = await cassetteWithTiming('unique-id', {
      startedAt: new Date(0).toISOString(),
      startLatencyMs: 0,
      durationMs: 0,
    })
    const firstProvider = new ReplaySubagentProvider(
      'cassette-a',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'instant', speed: 1 },
    )
    const secondProvider = new ReplaySubagentProvider(
      'cassette-b',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'instant', speed: 1 },
    )
    const parent = fakeAgent('shared-parent')
    const first = await firstProvider.start(request('unique-id', parent))
    const second = await secondProvider.start(request('unique-id', parent))

    expect(String(first.id)).not.toBe(String(second.id))
    await expect(first.result).resolves.toEqual(textResult('replayed'))
    await expect(second.result).resolves.toEqual(textResult('replayed'))
    await Promise.all([first.dispose(), second.dispose()])
  })

  it('chunks recorded delays at the maximum delay accepted by Node timers', async () => {
    const maximumTimerDelayMs = 2_147_483_647
    const cassette = await cassetteWithTiming('long-delay', {
      startedAt: new Date(0).toISOString(),
      startLatencyMs: maximumTimerDelayMs + 1_000,
      durationMs: maximumTimerDelayMs + 1_000,
    })
    const replay = new ReplaySubagentProvider(
      'cassette',
      new InteractionMatcher(cassette, 'reject', false),
      cassette.header.provider,
      { timing: 'recorded', speed: 1 },
    )
    vi.useFakeTimers()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const controller = new AbortController()

    const publication = replay.start(request('long-delay', fakeAgent('fresh'), controller.signal))
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), maximumTimerDelayMs)
    controller.abort(new Error('cancel long replay'))
    await expect(publication).rejects.toMatchObject({ recordedName: 'AbortError', code: 'ABORTED' })
  })
})
