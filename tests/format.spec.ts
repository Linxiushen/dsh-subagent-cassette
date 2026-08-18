import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintJson } from '../src/canonical.ts'
import { CassetteFormatError } from '../src/errors.ts'
import {
  ambiguousGroups,
  CassetteWriter,
  createHeader,
  loadCassette,
  parseCassette,
  resolveCassettePath,
  summarizeCassette,
} from '../src/format.ts'
import type { CassetteInteractionBody, JsonValue } from '../src/types.ts'
import { tempWorkspace, textResult, type TempWorkspace } from './helpers.ts'

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

function header(requestStorage: 'metadata' | 'full' = 'metadata') {
  return createHeader({
    cassette: 'cassette',
    upstream: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    requestStorage,
    redactSecrets: true,
  })
}

function interaction(
  sequence: number,
  fingerprint = `sha256:${String(sequence).padStart(64, '0')}`,
  occurrence = 1,
): CassetteInteractionBody {
  return {
    kind: 'cassette/interaction',
    sequence,
    callKey: `root/call~${sequence}`,
    parentKey: 'root',
    parentContextFingerprint: `sha256:${'f'.repeat(64)}`,
    occurrence,
    requestFingerprint: fingerprint,
    request: {
      storage: 'metadata',
      metadata: {
        promptBlocks: 1,
        promptBytes: 10,
        hasOutputSchema: false,
        hasPersona: false,
      },
    },
    timing: { startedAt: new Date(0).toISOString(), startLatencyMs: 1, durationMs: sequence * 10 },
    published: true,
    local: false,
    outcome: { kind: 'result', result: textResult(`answer-${sequence}`), redactions: 0 },
  }
}

function signedCassette(
  interactions: readonly CassetteInteractionBody[],
  requestStorage: 'metadata' | 'full' = 'metadata',
): string {
  const cassetteHeader = header(requestStorage)
  let previousHash = cassetteHeader.hash
  const lines = interactions.map((body) => {
    const unhashed = { ...body, previousHash }
    const hash = fingerprintJson(unhashed as unknown as JsonValue)
    previousHash = hash
    return JSON.stringify({ ...unhashed, hash })
  })
  return [JSON.stringify(cassetteHeader), ...lines].join('\n')
}

async function workspace(): Promise<TempWorkspace> {
  const created = await tempWorkspace()
  workspaces.push(created)
  return created
}

describe('cassette format', () => {
  it('round-trips interactions and verifies the complete hash chain', async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    await writer.append(interaction(2))
    await writer.append(interaction(1))
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(cassette.interactions.map(item => item.sequence)).toEqual([2, 1])
    expect(cassette.interactions[1]?.previousHash).toBe(cassette.interactions[0]?.hash)
  })

  it('rejects an invalid writer header before creating a cassette', async () => {
    const temp = await workspace()
    const invalidHeader = { ...header(), privatePrompt: 'TOP_SECRET' }
    await expect(CassetteWriter.open(temp.path(), invalidHeader, 'create'))
      .rejects.toThrow(/header\.privatePrompt is not supported/)
    await expect(readFile(temp.path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not construct a header that its own parser rejects', () => {
    expect(() => createHeader({
      cassette: '',
      upstream: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      requestStorage: 'metadata',
      redactSecrets: true,
    })).toThrow(/header\.provider\.cassette must be a non-empty string/)
  })

  it('detects content tampering even when JSON remains valid', async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    await writer.append(interaction(1))
    await writer.close()
    const text = await readFile(temp.path(), 'utf8')
    await writeFile(temp.path(), text.replace('answer-1', 'answer-X'), 'utf8')
    await expect(loadCassette(temp.path())).rejects.toThrow(/hash mismatch/)
  })

  it('detects record deletion and reordering through previousHash', async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    await writer.append(interaction(1))
    await writer.append(interaction(2))
    await writer.close()
    const lines = (await readFile(temp.path(), 'utf8')).trim().split('\n')
    const first = lines[0]
    const third = lines[2]
    if (first === undefined || third === undefined) throw new Error('fixture missing lines')
    await writeFile(temp.path(), `${first}\n${third}\n`, 'utf8')
    await expect(loadCassette(temp.path())).rejects.toThrow(/wrong previous record/)
  })

  it('rejects empty, malformed, and unsupported documents', () => {
    expect(() => parseCassette('')).toThrow(/empty/)
    expect(() => parseCassette('{bad')).toThrow(/line 1 is not valid JSON/)
    expect(() => parseCassette('{"kind":"cassette/header","format":"other","version":1}'))
      .toThrow(/unsupported cassette format/)
  })

  it('rejects duplicate JSON members, including escaped equivalent keys', () => {
    const [validHeader, validInteraction] = signedCassette([interaction(1)]).split('\n')
    if (validHeader === undefined || validInteraction === undefined) throw new Error('fixture missing records')
    const headerSecret = 'HIDDEN_RAW_HEADER_SECRET'
    const duplicateHeader = validHeader.replace(
      '"cassetteId":',
      `"cassette\\u0049d":"${headerSecret}","cassetteId":`,
    )
    let headerMessage = ''
    try {
      parseCassette(duplicateHeader)
    } catch (error: unknown) {
      headerMessage = error instanceof Error ? error.message : String(error)
    }
    expect(headerMessage).toMatch(/duplicate JSON object member/)
    expect(headerMessage).not.toContain(headerSecret)

    const interactionSecret = 'HIDDEN_RAW_INTERACTION_SECRET'
    const duplicateInteraction = validInteraction.replace(
      '"promptBlocks":1',
      `"promptBlocks":"${interactionSecret}","promptBlocks":1`,
    )
    expect(() => parseCassette(`${validHeader}\n${duplicateInteraction}`))
      .toThrow(/duplicate JSON object member/)
  })

  it('reports non-lossless canonical numbers as cassette format errors', () => {
    const [validHeader, validInteraction] = signedCassette([interaction(1)]).split('\n')
    if (validHeader === undefined || validInteraction === undefined) throw new Error('fixture missing records')
    const negativeZero = validInteraction
      .replace('"startLatencyMs":1', '"startLatencyMs":-0')
      .replace('"durationMs":10', '"durationMs":-0')
    const document = `${validHeader}\n${negativeZero}`
    expect(() => parseCassette(document)).toThrow(CassetteFormatError)
    expect(() => parseCassette(document)).toThrow(/not lossless canonical JSON/)
  })

  it('rejects structurally invalid headers before accepting their hash', () => {
    const [validHeader] = signedCassette([]).split('\n')
    if (validHeader === undefined) throw new Error('fixture missing header')
    const cases: Array<{
      mutate(value: Record<string, unknown>): void
      expected: RegExp
    }> = [
      { mutate: value => { value['kind'] = 'other' }, expected: /not a cassette header/ },
      { mutate: value => { value['version'] = 99 }, expected: /unsupported cassette schema version/ },
      { mutate: value => { value['cassetteId'] = '' }, expected: /cassetteId must be a non-empty string/ },
      { mutate: value => { value['createdAt'] = 'not-a-date' }, expected: /must be an ISO timestamp/ },
      { mutate: value => { value['target'] = null }, expected: /cassette targets/ },
      {
        mutate: value => {
          const target = value['target'] as Record<string, unknown>
          target['privatePrompt'] = 'TOP_SECRET'
        },
        expected: /target\.privatePrompt is not supported/,
      },
      { mutate: value => { value['provider'] = [] }, expected: /provider must be an object/ },
      {
        mutate: value => {
          const provider = value['provider'] as Record<string, unknown>
          provider['privatePrompt'] = 'TOP_SECRET'
        },
        expected: /provider\.privatePrompt is not supported/,
      },
      {
        mutate: value => {
          const provider = value['provider'] as Record<string, unknown>
          provider['capabilities'] = { outputSchema: true }
        },
        expected: /capabilities\.depthLimit must be a boolean/,
      },
      {
        mutate: value => {
          const provider = value['provider'] as Record<string, unknown>
          const capabilities = provider['capabilities'] as Record<string, unknown>
          capabilities['privatePrompt'] = 'TOP_SECRET'
        },
        expected: /capabilities\.privatePrompt is not supported/,
      },
      {
        mutate: value => {
          const provider = value['provider'] as Record<string, unknown>
          provider['inheritsParentContext'] = 'false'
        },
        expected: /inheritsParentContext must be a boolean/,
      },
      { mutate: value => { value['requestStorage'] = 'prompt' }, expected: /requestStorage must be/ },
      { mutate: value => { value['redactSecrets'] = 'yes' }, expected: /redactSecrets must be a boolean/ },
      { mutate: value => { value['redactionPatterns'] = ['ok', 42] }, expected: /array of strings/ },
      { mutate: value => { value['hash'] = 'SHA256:bad' }, expected: /lowercase SHA-256 digest/ },
      { mutate: value => { value['cassetteId'] = 'tampered' }, expected: /header hash mismatch/ },
      { mutate: value => { value['privatePrompt'] = 'TOP_SECRET' }, expected: /privatePrompt is not supported/ },
    ]
    for (const { mutate, expected } of cases) {
      const candidate = JSON.parse(validHeader) as Record<string, unknown>
      mutate(candidate)
      expect(() => parseCassette(JSON.stringify(candidate))).toThrow(expected)
    }
    expect(() => parseCassette('[]')).toThrow(/header object/)
  })

  it('rejects invalid interaction contracts before trusting record hashes', () => {
    const [validHeader, validInteraction] = signedCassette([interaction(1)]).split('\n')
    if (validHeader === undefined || validInteraction === undefined) throw new Error('fixture missing records')
    const cases: Array<{
      mutate(value: Record<string, unknown>): void
      expected: RegExp
    }> = [
      { mutate: value => { value['kind'] = 'other' }, expected: /not a cassette interaction/ },
      { mutate: value => { value['sequence'] = 0 }, expected: /positive safe integer/ },
      { mutate: value => { value['callKey'] = '' }, expected: /callKey must be a non-empty string/ },
      { mutate: value => { delete value['parentContextFingerprint'] }, expected: /parentContextFingerprint/ },
      { mutate: value => { value['requestFingerprint'] = 'sha256:ABC' }, expected: /lowercase SHA-256 digest/ },
      { mutate: value => { value['request'] = { storage: 'metadata' } }, expected: /metadata must be an object/ },
      {
        mutate: value => {
          value['request'] = { storage: 'metadata', metadata: {
            promptBlocks: 1,
            promptBytes: 10,
            hasOutputSchema: false,
            hasPersona: false,
            privatePrompt: 'TOP_SECRET',
          } }
        },
        expected: /privatePrompt is not supported/,
      },
      {
        mutate: value => {
          value['request'] = { storage: 'metadata', metadata: {
            promptBlocks: 1,
            promptBytes: 10,
            hasOutputSchema: false,
            toolFilter: { allow: ['read'], privatePrompt: 'TOP_SECRET' },
            hasPersona: false,
          } }
        },
        expected: /toolFilter\.privatePrompt is not supported/,
      },
      {
        mutate: value => { value['request'] = { storage: 'full', value: {}, redactions: 0 } },
        expected: /value\.prompt must be an array/,
      },
      {
        mutate: value => { value['request'] = { storage: 'full', value: { prompt: [] }, redactions: -1 } },
        expected: /non-negative safe integer/,
      },
      { mutate: value => { value['request'] = { storage: 'unknown' } }, expected: /storage must be/ },
      { mutate: value => { value['timing'] = null }, expected: /timing must be an object/ },
      {
        mutate: value => {
          const timing = value['timing'] as Record<string, unknown>
          timing['privatePrompt'] = 'TOP_SECRET'
        },
        expected: /timing\.privatePrompt is not supported/,
      },
      {
        mutate: value => {
          const timing = value['timing'] as Record<string, unknown>
          timing['durationMs'] = 0
        },
        expected: /cannot be less than startLatencyMs/,
      },
      {
        mutate: value => {
          const timing = value['timing'] as Record<string, unknown>
          timing['signalAbortedAtMs'] = -1
        },
        expected: /signalAbortedAtMs must be a non-negative/,
      },
      { mutate: value => { value['published'] = 'yes' }, expected: /published.*local must be booleans/ },
      { mutate: value => { value['outcome'] = { kind: 'unknown' } }, expected: /outcome\.kind is unsupported/ },
      {
        mutate: value => {
          const outcome = value['outcome'] as Record<string, unknown>
          outcome['privatePrompt'] = 'TOP_SECRET'
        },
        expected: /outcome\.privatePrompt is not supported/,
      },
      {
        mutate: value => {
          value['outcome'] = { kind: 'result', redactions: 0, result: { output: 'bad', stopReason: 'completed' } }
        },
        expected: /result must contain output/,
      },
      {
        mutate: value => {
          value['outcome'] = { kind: 'result', redactions: 0, result: { output: [42], stopReason: 'completed' } }
        },
        expected: /result\.output\[0\] must be a typed content block/,
      },
      {
        mutate: value => {
          value['outcome'] = {
            kind: 'result',
            redactions: 0,
            result: {
              output: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text' }] }],
              stopReason: 'completed',
            },
          }
        },
        expected: /nested content at depth 1, index 0\.text must be a string/,
      },
      {
        mutate: value => {
          value['outcome'] = { kind: 'result-error', error: { name: 'Error', message: '', code: 42 } }
        },
        expected: /code must be a string/,
      },
      {
        mutate: value => {
          value['outcome'] = {
            kind: 'result-error',
            error: { name: 'Error', message: '', privatePrompt: 'TOP_SECRET' },
          }
        },
        expected: /error\.privatePrompt is not supported/,
      },
      {
        mutate: value => {
          value['published'] = true
          value['outcome'] = { kind: 'start-error', error: { name: 'Error', message: 'failed' } }
        },
        expected: /start-error must be unpublished/,
      },
      { mutate: value => { value['published'] = false }, expected: /post-publication outcome must be published/ },
      {
        mutate: value => {
          value['published'] = false
          value['local'] = true
          value['outcome'] = { kind: 'start-error', error: { name: 'Error', message: 'failed' } }
        },
        expected: /unpublished interaction cannot be local/,
      },
      { mutate: value => { value['privatePrompt'] = 'TOP_SECRET' }, expected: /privatePrompt is not supported/ },
    ]
    for (const { mutate, expected } of cases) {
      const candidate = JSON.parse(validInteraction) as Record<string, unknown>
      mutate(candidate)
      expect(() => parseCassette(`${validHeader}\n${JSON.stringify(candidate)}`)).toThrow(expected)
    }
  })

  it('requires every interaction request view to match the header storage policy', () => {
    const fullRequest: CassetteInteractionBody = {
      ...interaction(1),
      request: { storage: 'full', value: { prompt: [] }, redactions: 0 },
    }
    expect(() => parseCassette(signedCassette([fullRequest])))
      .toThrow(/request\.storage must match header\.requestStorage "metadata"/)
    expect(() => parseCassette(signedCassette([interaction(1)], 'full')))
      .toThrow(/request\.storage must match header\.requestStorage "full"/)
  })

  it('rejects hash-valid forged request views before they reach diagnostics', () => {
    const metadataSecret = 'TOP_SECRET_METADATA_VALUE'
    const forgedMetadata = {
      ...interaction(1),
      request: {
        storage: 'metadata',
        metadata: {
          promptBlocks: 1,
          promptBytes: 10,
          hasOutputSchema: false,
          hasPersona: false,
          privatePrompt: metadataSecret,
        },
      },
    } as unknown as CassetteInteractionBody
    let metadataMessage = ''
    try {
      parseCassette(signedCassette([forgedMetadata]))
    } catch (error: unknown) {
      metadataMessage = error instanceof Error ? error.message : String(error)
    }
    expect(metadataMessage).toMatch(/privatePrompt is not supported/)
    expect(metadataMessage).not.toContain(metadataSecret)

    const emptyFullRequest = {
      ...interaction(1),
      request: { storage: 'full', value: {}, redactions: 0 },
    } as unknown as CassetteInteractionBody
    expect(() => parseCassette(signedCassette([emptyFullRequest], 'full')))
      .toThrow(/value\.prompt must be an array/)
  })

  it('rejects a hash-valid result whose output is not ContentBlock data', () => {
    const forged = {
      ...interaction(1),
      outcome: {
        kind: 'result',
        result: { output: [42], stopReason: 'completed' },
        redactions: 0,
      },
    } as unknown as CassetteInteractionBody
    expect(() => parseCassette(signedCassette([forged])))
      .toThrow(/result\.output\[0\] must be a typed content block/)
  })

  it('validates deeply nested tool-result content without recursive or quadratic path work', {
    timeout: 20_000,
  }, async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    let output: JsonValue[] = [{ type: 'text', text: 'leaf' }]
    for (let depth = 0; depth < 20_000; depth++) {
      output = [{ type: 'tool-result', toolCallId: `call-${depth}`, content: output }]
    }
    const deep = {
      ...interaction(1),
      outcome: { kind: 'result', result: { output, stopReason: 'completed' }, redactions: 0 },
    } as unknown as CassetteInteractionBody
    await writer.append(deep)
    await writer.close()
    await expect(loadCassette(temp.path())).resolves.toMatchObject({ interactions: [{ sequence: 1 }] })
  })

  it.each(['metadata', 'full'] as const)(
    'does not write an invalid %s request view',
    async (requestStorage) => {
      const temp = await workspace()
      const writer = await CassetteWriter.open(temp.path(), header(requestStorage), 'create')
      const invalid = {
        ...interaction(1),
        request: requestStorage === 'metadata'
          ? {
              storage: 'metadata',
              metadata: {
                promptBlocks: 1,
                promptBytes: 10,
                hasOutputSchema: false,
                hasPersona: false,
                privatePrompt: 'TOP_SECRET',
              },
            }
          : {
              storage: 'full',
              value: { prompt: [], privatePrompt: 'TOP_SECRET' },
              redactions: 0,
            },
      } as unknown as CassetteInteractionBody
      await expect(writer.append(invalid)).rejects.toThrow(/privatePrompt is not supported/)
      await expect(writer.close()).rejects.toThrow(/privatePrompt is not supported/)
      await expect(loadCassette(temp.path())).resolves.toMatchObject({ interactions: [] })
    },
  )

  it('rejects duplicate and non-contiguous sequence and occurrence identities', () => {
    const fingerprint = `sha256:${'c'.repeat(64)}`
    const duplicateSequence: CassetteInteractionBody = { ...interaction(2), sequence: 1 }
    expect(() => parseCassette(signedCassette([interaction(1), duplicateSequence])))
      .toThrow(/duplicates sequence 1/)

    const duplicateCall: CassetteInteractionBody = { ...interaction(2), callKey: interaction(1).callKey }
    expect(() => parseCassette(signedCassette([interaction(1), duplicateCall])))
      .toThrow(/duplicates call key/)

    expect(() => parseCassette(signedCassette([interaction(2)]))).toThrow(/missing sequence 1/)
    expect(() => parseCassette(signedCassette([
      interaction(1, fingerprint, 1),
      interaction(2, fingerprint, 1),
    ]))).toThrow(/duplicates occurrence 1/)
    expect(() => parseCassette(signedCassette([interaction(1, fingerprint, 2)])))
      .toThrow(/missing occurrence 1/)
  })

  it('keeps occurrences and ambiguity separate across parent contexts', () => {
    const fingerprint = `sha256:${'c'.repeat(64)}`
    const first = interaction(1, fingerprint, 1)
    const second: CassetteInteractionBody = {
      ...interaction(2, fingerprint, 1),
      parentContextFingerprint: `sha256:${'d'.repeat(64)}`,
    }
    const cassette = parseCassette(signedCassette([first, second]))
    expect(cassette.interactions.map(item => item.occurrence)).toEqual([1, 1])
    expect(ambiguousGroups(cassette)).toEqual([])
  })

  it('continues a compatible cassette in append mode', async () => {
    const temp = await workspace()
    const initialHeader = header()
    const first = await CassetteWriter.open(temp.path(), initialHeader, 'create')
    await first.append(interaction(1))
    await first.close()
    const appended = await CassetteWriter.open(temp.path(), header(), 'append')
    expect(appended.nextSequence).toBe(2)
    await appended.append(interaction(2))
    await appended.close()
    expect((await loadCassette(temp.path())).interactions).toHaveLength(2)
  })

  it('excludes concurrent append writers and continues cleanly after the owner closes', async () => {
    const temp = await workspace()
    const seed = await CassetteWriter.open(temp.path(), header(), 'create')
    await seed.close()

    const first = await CassetteWriter.open(temp.path(), header(), 'append')
    await expect(CassetteWriter.open(temp.path(), header(), 'append')).rejects.toThrow(/writer lock/)
    await expect(CassetteWriter.open(temp.path(), header(), 'append')).rejects.toThrow(/writer lock/)
    await first.append(interaction(1))
    await first.close()

    const second = await CassetteWriter.open(temp.path(), header(), 'append')
    expect(second.nextSequence).toBe(2)
    await second.append(interaction(2))
    await second.close()
    expect((await loadCassette(temp.path())).interactions.map(item => item.sequence)).toEqual([1, 2])
  })

  it('inserts a record separator when appending to a file without a trailing newline', async () => {
    const temp = await workspace()
    const first = await CassetteWriter.open(temp.path(), header(), 'create')
    await first.append(interaction(1))
    await first.close()
    await writeFile(temp.path(), (await readFile(temp.path(), 'utf8')).trimEnd(), 'utf8')

    const appended = await CassetteWriter.open(temp.path(), header(), 'append')
    await appended.append(interaction(2))
    await appended.close()

    expect((await loadCassette(temp.path())).interactions.map(item => item.sequence)).toEqual([1, 2])
  })

  it('rejects append when persistence policy differs', async () => {
    const temp = await workspace()
    const first = await CassetteWriter.open(temp.path(), header('metadata'), 'create')
    await first.close()
    await expect(CassetteWriter.open(temp.path(), header('full'), 'append')).rejects.toThrow(/requestStorage differs/)
  })

  it('starts a missing append target as a new cassette', async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'append')
    expect(writer.nextSequence).toBe(1)
    await writer.close()
  })

  it('continues a header-only append target and preserves its identity', async () => {
    const temp = await workspace()
    const original = header()
    const first = await CassetteWriter.open(temp.path(), original, 'create')
    await first.close()
    const appended = await CassetteWriter.open(temp.path(), header(), 'append')
    expect(appended.header.cassetteId).toBe(original.cassetteId)
    expect(appended.nextSequence).toBe(1)
    expect(appended.existingInteractions).toEqual([])
    await appended.append(interaction(1))
    await appended.close()
    expect((await loadCassette(temp.path())).interactions).toHaveLength(1)
  })

  it('enforces create, truncate, closed-writer, and idempotent-close boundaries', async () => {
    const temp = await workspace()
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    await writer.append(interaction(1))
    await expect(CassetteWriter.open(temp.path(), header(), 'truncate')).rejects.toThrow(/writer lock/)
    await writer.close()
    await writer.close()
    await expect(writer.append(interaction(2))).rejects.toThrow(/writer is closed/)
    await expect(CassetteWriter.open(temp.path(), header(), 'create')).rejects.toThrow(/cannot open cassette/)

    const truncated = await CassetteWriter.open(temp.path(), header(), 'truncate')
    await truncated.close()
    expect((await loadCassette(temp.path())).interactions).toEqual([])
  })

  it('does not treat a malformed append target as a missing cassette', async () => {
    const temp = await workspace()
    await writeFile(temp.path(), '{partial', 'utf8')
    await expect(CassetteWriter.open(temp.path(), header(), 'append')).rejects.toThrow(/not valid JSON/)

    const recovered = await CassetteWriter.open(temp.path(), header(), 'truncate')
    await recovered.close()
    expect((await loadCassette(temp.path())).interactions).toEqual([])
  })

  it('fails closed without removing an existing writer lock', async () => {
    const temp = await workspace()
    const canonicalTarget = join(await realpath(temp.dir), basename(temp.path()))
    const lockPath = `${canonicalTarget}.writer.lock`
    const foreignOwner = join(lockPath, 'foreign-owner.json')
    await mkdir(lockPath)
    await writeFile(foreignOwner, '{"pid":123}\n', 'utf8')

    await expect(CassetteWriter.open(temp.path(), header(), 'create')).rejects.toThrow(/another writer may be active/)
    await expect(readFile(foreignOwner, 'utf8')).resolves.toBe('{"pid":123}\n')
  })

  it('reports ambiguous duplicate outcomes and aggregate counts', async () => {
    const temp = await workspace()
    const duplicate = `sha256:${'a'.repeat(64)}`
    const writer = await CassetteWriter.open(temp.path(), header(), 'create')
    await writer.append(interaction(1, duplicate, 1))
    await writer.append(interaction(2, duplicate, 2))
    await writer.close()
    const cassette = await loadCassette(temp.path())
    expect(ambiguousGroups(cassette)).toHaveLength(1)
    expect(summarizeCassette(cassette)).toMatchObject({ interactions: 2, completed: 2, ambiguousGroups: 1 })
  })

  it('summarizes aborted, redacted, and failed terminal outcomes in memory', () => {
    const aborted: CassetteInteractionBody = {
      ...interaction(1),
      outcome: { kind: 'result', result: textResult('', 'aborted'), redactions: 1 },
    }
    const childFailure: CassetteInteractionBody = {
      ...interaction(2),
      outcome: { kind: 'result', result: textResult('', 'error'), redactions: 0 },
    }
    const infrastructureFailure: CassetteInteractionBody = {
      ...interaction(3),
      outcome: {
        kind: 'result-error',
        error: { name: 'Error', message: 'transport failed' },
      },
    }
    const summary = summarizeCassette(parseCassette(signedCassette([
      aborted,
      childFailure,
      infrastructureFailure,
    ])))
    expect(summary).toMatchObject({
      interactions: 3,
      completed: 0,
      failed: 2,
      aborted: 1,
      redactedResults: 1,
      durationMs: 30,
    })
    expect(summary).not.toHaveProperty('file')
  })

  it('expands portable timestamp and pid path tokens', () => {
    const path = resolveCassettePath('traces/{timestamp}-{pid}.jsonl', new Date('2026-08-18T01:02:03.004Z'), 42)
    expect(path).toMatch(/20260818T010203004Z-42\.jsonl$/)
  })
})
