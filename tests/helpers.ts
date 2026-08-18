import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  snapshotSubagentDescriptor,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'

export function textResult(text: string, stopReason: SubagentResult['stopReason'] = 'completed'): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason }
}

export function fakeAgent(id = 'root', origin?: 'subagent'): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    options: {},
    ctx: { get: () => undefined },
    session: {
      id: sessionId,
      events: [],
      header: {
        version: 0,
        id: sessionId,
        createdAt: 1,
        ...(origin === undefined ? {} : { origin, parentSession: SessionId('parent'), delegationDepth: 1 }),
      },
    },
  } as unknown as Agent
}

export function request(
  label: string,
  parent = fakeAgent(),
  signal = new AbortController().signal,
): ResolvedSubagentStartRequest {
  return {
    label,
    prompt: [{ type: 'text', text: `prompt:${label}` }],
    parent,
    signal,
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'cassette', label }),
  }
}

export interface PendingRun {
  readonly run: SubagentRun
  resolve(result: SubagentResult): void
  reject(error: unknown): void
  readonly disposeCalls: () => number
}

export function pendingRun(id: string, localAgent?: Agent): PendingRun {
  let resolvePromise!: (result: SubagentResult) => void
  let rejectPromise!: (error: unknown) => void
  let disposals = 0
  let settled = false
  const result = new Promise<SubagentResult>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    run: {
      id: SessionId(id),
      localAgent,
      result,
      dispose: async () => {
        disposals++
        if (!settled) {
          settled = true
          resolvePromise({ output: [], stopReason: 'aborted' })
        }
      },
    },
    resolve: (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
    reject: (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    },
    disposeCalls: () => disposals,
  }
}

export class QueueProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false
  readonly pending: PendingRun[] = []
  startError: unknown

  constructor(readonly name = 'spawn') {}

  async start(): Promise<SubagentRun> {
    if (this.startError !== undefined) throw this.startError
    const pending = pendingRun(`child-${this.pending.length + 1}`)
    this.pending.push(pending)
    return pending.run
  }
}

export interface TempWorkspace {
  readonly dir: string
  path(name?: string): string
  cleanup(): Promise<void>
}

export async function tempWorkspace(): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cassette-test-'))
  return {
    dir,
    path: (name = 'test.cassette.jsonl') => join(dir, name),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}
