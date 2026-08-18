import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.ts'
import { CassetteWriter, createHeader } from '../src/format.ts'
import type { CliIo } from '../src/cli.ts'
import type { CassetteOutcome } from '../src/types.ts'
import { tempWorkspace, textResult, type TempWorkspace } from './helpers.ts'

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup()))
})

async function fixture(
  firstOutput = 'private output',
  stopReason = 'completed',
  firstCallKey = 'root/audit~1',
): Promise<string> {
  const temp = await tempWorkspace()
  workspaces.push(temp)
  const writer = await CassetteWriter.open(temp.path(), createHeader({
    cassette: 'cassette', upstream: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false, requestStorage: 'metadata', redactSecrets: false,
  }), 'create')
  await writer.append({
    kind: 'cassette/interaction', sequence: 1, callKey: firstCallKey, parentKey: 'root', occurrence: 1,
    parentContextFingerprint: `sha256:${'f'.repeat(64)}`,
    requestFingerprint: `sha256:${'a'.repeat(64)}`,
    request: { storage: 'metadata', metadata: { promptBlocks: 1, promptBytes: 20, hasOutputSchema: false, hasPersona: false } },
    timing: { startedAt: new Date().toISOString(), startLatencyMs: 1, durationMs: 12 },
    published: true, local: false,
    outcome: {
      kind: 'result',
      result: { ...textResult(firstOutput), stopReason },
      redactions: 0,
    } as unknown as CassetteOutcome,
  })
  await writer.append({
    kind: 'cassette/interaction', sequence: 2, callKey: 'root/failure~1', parentKey: 'root', occurrence: 1,
    parentContextFingerprint: `sha256:${'f'.repeat(64)}`,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    request: { storage: 'metadata', metadata: { promptBlocks: 1, promptBytes: 10, hasOutputSchema: false, hasPersona: false } },
    timing: { startedAt: new Date().toISOString(), startLatencyMs: 2, durationMs: 8 },
    published: true, local: false,
    outcome: { kind: 'result-error', error: { name: 'Error', message: 'private failure' } },
  })
  await writer.close()
  return temp.path()
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: value => { out.push(value) }, err: value => { err.push(value) } }, out, err }
}

describe('cassette CLI', () => {
  it('verifies a cassette without printing recorded content', async () => {
    const file = await fixture()
    const captured = capture()
    expect(await runCli(['verify', file], captured.io)).toBe(0)
    expect(captured.out.join('\n')).toMatch(/hash chain verified/)
    expect(captured.out.join('\n')).not.toContain('private output')
  })

  it('prints machine-readable call metadata only', async () => {
    const file = await fixture()
    const captured = capture()
    expect(await runCli(['inspect', file, '--json', '--show-calls'], captured.io)).toBe(0)
    const output = captured.out.join('\n')
    expect(output).toContain('root/audit~1')
    expect(output).toContain('result-error')
    expect(output).not.toContain('private output')
    expect(output).not.toContain('private failure')
  })

  it('prints a human-readable summary and sorted call list', async () => {
    const file = await fixture()
    const captured = capture()
    expect(await runCli(['inspect', file, '--show-calls'], captured.io)).toBe(0)
    expect(captured.out[0]).toContain('Provider: cassette -> spawn')
    expect(captured.out[1]).toMatch(/^\s*1\s+root\/audit~1\s+completed\s+12\.0ms$/)
    expect(captured.out[2]).toMatch(/^\s*2\s+root\/failure~1\s+result-error\s+8\.0ms$/)
  })

  it('prints a JSON summary without call details for verify', async () => {
    const file = await fixture()
    const captured = capture()
    expect(await runCli(['verify', file, '--json', '--show-calls'], captured.io)).toBe(0)
    const summary = JSON.parse(captured.out.join('\n')) as Record<string, unknown>
    expect(summary).toMatchObject({ interactions: 2, completed: 1, failed: 1 })
    expect(summary).not.toHaveProperty('calls')
  })

  it('returns a nonzero code for invalid input', async () => {
    const captured = capture()
    expect(await runCli(['verify', 'missing.cassette.jsonl'], captured.io)).toBe(1)
    expect(captured.err.join('\n')).toMatch(/cannot read cassette/)
  })

  it('returns CI-friendly diff codes without exposing recorded bodies', async () => {
    const expected = await fixture()
    const equivalent = capture()
    expect(await runCli(['diff', expected, expected], equivalent.io)).toBe(0)
    expect(equivalent.out.join('\n')).toContain('Comparable / equivalent: yes / yes')

    const actual = await fixture('changed-private-output')
    const changed = capture()
    expect(await runCli(['diff', expected, actual, '--json'], changed.io)).toBe(2)
    const output = changed.out.join('\n')
    const report = JSON.parse(output) as Record<string, unknown>
    expect(report).toMatchObject({ comparable: true, equivalent: false })
    expect(output).not.toContain('private output')
    expect(output).not.toContain('changed-private-output')

    const human = capture()
    expect(await runCli(['diff', expected, actual, '--show-calls'], human.io)).toBe(2)
    expect(human.out.join('\n')).toContain('outcome completed -> completed')
    expect(human.out.join('\n')).not.toContain('changed-private-output')
  })

  it('never prints raw unknown stop reasons in inspect or diff output', async () => {
    const expectedReason = 'PRIVATE_EXPECTED_REASON\nINJECTED_LINE'
    const actualReason = 'PRIVATE_ACTUAL_REASON\u001b[31m'
    const expected = await fixture('same output', expectedReason)
    const actual = await fixture('same output', actualReason)

    for (const args of [
      ['inspect', expected, '--json', '--show-calls'],
      ['inspect', expected, '--show-calls'],
      ['diff', expected, actual, '--json'],
      ['diff', expected, actual, '--show-calls'],
    ]) {
      const captured = capture()
      const exitCode = await runCli(args, captured.io)
      expect(exitCode).toBe(args[0] === 'diff' ? 2 : 0)
      const output = [...captured.out, ...captured.err].join('\n')
      expect(output).not.toContain('PRIVATE_EXPECTED_REASON')
      expect(output).not.toContain('PRIVATE_ACTUAL_REASON')
      expect(output).toContain('other')
    }
  })

  it('escapes control characters in cassette-derived human output', async () => {
    const callKey = 'root/legit~1\nComparable / equivalent: yes / yes\u001b[31m'
    const expected = await fixture('first', 'completed', callKey)
    const actual = await fixture('second', 'completed', callKey)

    const inspect = capture()
    expect(await runCli(['inspect', expected, '--show-calls'], inspect.io)).toBe(0)
    expect(inspect.out[1]).toContain('\\u{000a}')
    expect(inspect.out[1]).toContain('\\u{001b}')
    expect(inspect.out[1]).not.toContain('\n')
    expect(inspect.out[1]).not.toContain('\u001b')

    const diff = capture()
    expect(await runCli(['diff', expected, actual, '--show-calls'], diff.io)).toBe(2)
    const callLine = diff.out.find(line => line.startsWith('~ '))
    expect(callLine).toContain('\\u{000a}')
    expect(callLine).toContain('\\u{001b}')
    expect(callLine).not.toContain('\n')
    expect(callLine).not.toContain('\u001b')
  })

  it('escapes terminal-control Unicode while keeping JSON output valid', async () => {
    const callKey = 'root/json\u2028line\u0085control\u200eformat\u{e0001}~1'
    const expected = await fixture('first', 'completed', callKey)
    const actual = await fixture('second', 'completed', callKey)

    for (const args of [
      ['inspect', expected, '--json', '--show-calls'],
      ['diff', expected, actual, '--json'],
    ]) {
      const captured = capture()
      expect(await runCli(args, captured.io)).toBe(args[0] === 'diff' ? 2 : 0)
      const output = captured.out[0]
      expect(output).toBeDefined()
      expect(output).toContain('\\u2028')
      expect(output).toContain('\\u0085')
      expect(output).toContain('\\u200e')
      expect(output).toContain('\\udb40\\udc01')
      expect(output).not.toContain('\u2028')
      expect(output).not.toContain('\u0085')
      expect(output).not.toContain('\u200e')
      expect(output).not.toContain('\u{e0001}')
      expect(() => JSON.parse(output ?? '')).not.toThrow()
    }
  })

  it('supports version and help without filesystem access', async () => {
    const version = capture()
    expect(await runCli(['--version'], version.io)).toBe(0)
    expect(version.out).toEqual(['0.2.0'])
    const help = capture()
    expect(await runCli(['--help'], help.io)).toBe(0)
    expect(help.out.join('\n')).toContain('Usage:')
  })

  it('validates commands and required positional arguments', async () => {
    const empty = capture()
    expect(await runCli([], empty.io)).toBe(1)
    expect(empty.out.join('\n')).toContain('Usage:')

    const shortHelp = capture()
    expect(await runCli(['-h'], shortHelp.io)).toBe(0)

    const unknown = capture()
    expect(await runCli(['rewind'], unknown.io)).toBe(1)
    expect(unknown.err.join('\n')).toContain('Unknown command: rewind')

    const missing = capture()
    expect(await runCli(['inspect', '--json'], missing.io)).toBe(1)
    expect(missing.err.join('\n')).toContain('Expected 1 cassette file')

    const unknownOption = capture()
    expect(await runCli(['verify', 'fixture.jsonl', '--wat'], unknownOption.io)).toBe(1)
    expect(unknownOption.err.join('\n')).toContain('Unknown option for verify: --wat')

    const extra = capture()
    expect(await runCli(['diff', 'one.jsonl', 'two.jsonl', 'three.jsonl'], extra.io)).toBe(1)
    expect(extra.err.join('\n')).toContain('Expected 2 cassette files')
  })
})
