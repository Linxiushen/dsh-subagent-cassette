import type { Context } from '@deepseek-ai/cordis'
import {
  installCassette,
  type CassetteHandle,
  type DuplicatePolicy,
} from 'dsh-subagent-cassette'

/**
 * The context must already have SubagentRuntime and the `spawn` provider mounted.
 * Route the scenario's one-shot calls to the returned providerName.
 */
export async function installRecording(
  ctx: Context,
  file: string,
): Promise<CassetteHandle> {
  return installCassette(ctx, {
    mode: 'record',
    provider: 'cassette',
    upstreamProvider: 'spawn',
    file,
    writeMode: 'create',
    requestStorage: 'metadata',
    redactSecrets: true,
  })
}

/**
 * Replay is offline at the cassette provider boundary and needs no upstream.
 * Keep duplicatePolicy at `reject` unless occurrence order is intentional.
 */
export async function installReplay(
  ctx: Context,
  file: string,
  duplicatePolicy: DuplicatePolicy = 'reject',
): Promise<CassetteHandle> {
  return installCassette(ctx, {
    mode: 'replay',
    provider: 'cassette',
    file,
    timing: 'instant',
    speed: 1,
    duplicatePolicy,
    allowRedactedReplay: false,
    assertConsumed: true,
  })
}

/**
 * Disposal flushes admitted recording outcomes. During replay it also asserts
 * that every interaction was consumed, so its rejection should reach the test.
 */
export async function withCassette<T>(
  handle: CassetteHandle,
  runScenario: (providerName: string) => Promise<T>,
): Promise<T> {
  try {
    return await runScenario(handle.providerName)
  } finally {
    await handle.dispose()
  }
}
