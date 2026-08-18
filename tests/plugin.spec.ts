import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { CassetteError } from '../src/errors.ts'
import { apply, installCassette } from '../src/index.ts'
import type { CassetteHandle } from '../src/index.ts'
import { fakeAgent, QueueProvider, tempWorkspace, textResult, type TempWorkspace } from './helpers.ts'

const contexts: Context[] = []
const workspaces: TempWorkspace[] = []
const handles: CassetteHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.dispose().catch(() => {})))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

async function context(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  return ctx
}

async function workspace(): Promise<TempWorkspace> {
  const temp = await tempWorkspace()
  workspaces.push(temp)
  return temp
}

describe('DSH plugin integration', () => {
  it('installs and cleans up record and replay modes through the Cordis apply entry point', async () => {
    const temp = await workspace()
    const recordCtx = await context()
    const upstream = new QueueProvider('spawn')
    recordCtx.subagents.registerProvider(upstream)
    const disposeRecord = await apply(recordCtx, {
      mode: 'record',
      provider: 'cassette',
      upstreamProvider: 'spawn',
      file: temp.path(),
      writeMode: 'truncate',
      requestStorage: 'full',
      redactSecrets: false,
      redactionPatterns: [],
    })
    const recorded = await recordCtx.subagents.start('cassette', {
      label: 'via-apply', prompt: [{ type: 'text', text: 'record through apply' }], parent: fakeAgent(),
      signal: new AbortController().signal,
    })
    upstream.pending[0]?.resolve(textResult('apply-result'))
    await recorded.result
    await recorded.dispose()
    await disposeRecord()
    expect(recordCtx.subagents.list()).not.toContain('cassette')

    const replayCtx = await context()
    const disposeReplay = await apply(replayCtx, {
      mode: 'replay',
      provider: 'cassette',
      file: temp.path(),
      timing: 'instant',
      speed: 2,
      duplicatePolicy: 'sequence',
      allowRedactedReplay: false,
      assertConsumed: true,
    })
    const replayed = await replayCtx.subagents.start('cassette', {
      label: 'via-apply', prompt: [{ type: 'text', text: 'record through apply' }], parent: fakeAgent('fresh'),
      signal: new AbortController().signal,
    })
    await expect(replayed.result).resolves.toEqual(textResult('apply-result'))
    await replayed.dispose()
    await disposeReplay()
    expect(replayCtx.subagents.list()).not.toContain('cassette')
  })

  it('registers a wrapper provider and records through the real SubagentRuntime seam', async () => {
    const ctx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    ctx.subagents.registerProvider(upstream)
    const handle = await installCassette(ctx, {
      mode: 'record',
      file: temp.path(),
      upstreamProvider: 'spawn',
      redactSecrets: false,
    })
    handles.push(handle)
    expect(ctx.subagents.list()).toContain('cassette')
    const starts: string[] = []
    const ends: string[] = []
    ctx.on('subagent/start', info => { starts.push(String(info.id)) })
    ctx.on('subagent/end', info => { ends.push(info.stopReason) })
    const run = await ctx.subagents.start('cassette', {
      label: 'audit',
      prompt: [{ type: 'text', text: 'inspect the repository' }],
      parent: fakeAgent(),
      signal: new AbortController().signal,
    })
    upstream.pending[0]?.resolve(textResult('clean'))
    await expect(run.result).resolves.toEqual(textResult('clean'))
    await run.dispose()
    expect(starts).toEqual(['child-1'])
    expect(ends).toEqual(['completed'])
    await handle.dispose()
    expect(ctx.subagents.list()).not.toContain('cassette')
  })

  it('replays offline with the capabilities captured from the upstream provider', async () => {
    const recordCtx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    recordCtx.subagents.registerProvider(upstream)
    const record = await installCassette(recordCtx, {
      mode: 'record', file: temp.path(), upstreamProvider: 'spawn', redactSecrets: false,
    })
    handles.push(record)
    const recordedRun = await recordCtx.subagents.start('cassette', {
      label: 'audit', prompt: [{ type: 'text', text: 'inspect' }], parent: fakeAgent(),
      signal: new AbortController().signal,
    })
    upstream.pending[0]?.resolve(textResult('offline-result'))
    await recordedRun.result
    await recordedRun.dispose()
    await record.dispose()

    const replayCtx = await context()
    const replay = await installCassette(replayCtx, {
      mode: 'replay', file: temp.path(), assertConsumed: true,
    })
    handles.push(replay)
    expect(replayCtx.subagents.getProvider('cassette')?.capabilities).toEqual(upstream.capabilities)
    const run = await replayCtx.subagents.start('cassette', {
      label: 'audit', prompt: [{ type: 'text', text: 'inspect' }], parent: fakeAgent('fresh'),
      signal: new AbortController().signal,
    })
    expect(run.localAgent).toBeUndefined()
    await expect(run.result).resolves.toEqual(textResult('offline-result'))
    replay.assertConsumed()
    await replay.dispose()
  })

  it('rejects a missing upstream before creating a provider', async () => {
    const ctx = await context()
    const temp = await workspace()
    await expect(installCassette(ctx, {
      mode: 'record', file: temp.path(), upstreamProvider: 'missing',
    })).rejects.toMatchObject({ code: 'NO_UPSTREAM' })
    expect(ctx.subagents.list()).not.toContain('cassette')
  })

  it('does not create a cassette when a custom redaction expression is invalid', async () => {
    const ctx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    ctx.subagents.registerProvider(upstream)

    await expect(installCassette(ctx, {
      mode: 'record',
      file: temp.path(),
      upstreamProvider: 'spawn',
      redactionPatterns: ['['],
    })).rejects.toThrow(/invalid cassette redaction pattern/)
    await expect(readFile(temp.path())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.subagents.list()).not.toContain('cassette')
  })

  it('blocks new wrapper starts after its upstream registration is removed', async () => {
    const ctx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    const unregisterUpstream = ctx.subagents.registerProvider(upstream)
    const handle = await installCassette(ctx, {
      mode: 'record', file: temp.path(), upstreamProvider: 'spawn', redactSecrets: false,
    })
    handles.push(handle)

    unregisterUpstream()
    await expect(ctx.subagents.start('cassette', {
      label: 'stale', prompt: [{ type: 'text', text: 'must not start' }], parent: fakeAgent(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NO_UPSTREAM' })
    expect(upstream.pending).toHaveLength(0)
  })

  it('waits for admitted recording runs before closing the writer', async () => {
    const ctx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    ctx.subagents.registerProvider(upstream)
    const handle = await installCassette(ctx, {
      mode: 'record', file: temp.path(), upstreamProvider: 'spawn', redactSecrets: false,
    })
    const run = await ctx.subagents.start('cassette', {
      label: 'slow', prompt: [{ type: 'text', text: 'slow' }], parent: fakeAgent(),
      signal: new AbortController().signal,
    })
    let disposed = false
    const firstDisposal = handle.dispose()
    const secondDisposal = handle.dispose()
    expect(secondDisposal).toBe(firstDisposal)
    const disposal = firstDisposal.then(() => { disposed = true })
    await new Promise(resolve => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    expect(ctx.subagents.list()).not.toContain('cassette')
    upstream.pending[0]?.resolve(textResult('done'))
    await run.result
    await run.dispose()
    await disposal
    expect(disposed).toBe(true)
  })

  it('rejects recursive provider configuration', async () => {
    const ctx = await context()
    const temp = await workspace()
    const provider = new QueueProvider('cassette')
    ctx.subagents.registerProvider(provider)
    await expect(installCassette(ctx, {
      mode: 'record', file: temp.path(), provider: 'cassette', upstreamProvider: 'cassette',
    })).rejects.toBeInstanceOf(CassetteError)
  })

  it('asserts unconsumed replay calls during explicit disposal', async () => {
    const recordCtx = await context()
    const temp = await workspace()
    const upstream = new QueueProvider('spawn')
    recordCtx.subagents.registerProvider(upstream)
    const record = await installCassette(recordCtx, {
      mode: 'record', file: temp.path(), upstreamProvider: 'spawn', redactSecrets: false,
    })
    handles.push(record)
    const run = await recordCtx.subagents.start('cassette', {
      label: 'unused', prompt: [{ type: 'text', text: 'unused' }], parent: fakeAgent(),
      signal: new AbortController().signal,
    })
    upstream.pending[0]?.resolve(textResult('unused'))
    await run.result
    await run.dispose()
    await record.dispose()

    const replayCtx = await context()
    const replay = await installCassette(replayCtx, {
      mode: 'replay', file: temp.path(), assertConsumed: true,
    })
    const firstDisposal = replay.dispose()
    const secondDisposal = replay.dispose()
    expect(secondDisposal).toBe(firstDisposal)
    await expect(firstDisposal).rejects.toThrow(/not consumed/)
    await expect(secondDisposal).rejects.toThrow(/not consumed/)
  })
})
