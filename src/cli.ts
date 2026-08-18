#!/usr/bin/env node

import { diffCassettes, type CassetteCallSummary, type CassetteDiff } from './diff.ts'
import { loadCassette, summarizeCassette } from './format.ts'

const VERSION = '0.2.0'

export interface CliIo {
  out(message: string): void
  err(message: string): void
}

const defaultIo: CliIo = {
  out: message => { process.stdout.write(`${message}\n`) },
  err: message => { process.stderr.write(`${message}\n`) },
}

function usage(): string {
  return [
    'Usage:',
    '  dsh-cassette verify <file> [--json]',
    '  dsh-cassette inspect <file> [--json] [--show-calls]',
    '  dsh-cassette diff <expected> <actual> [--json] [--show-calls]',
    '  dsh-cassette --version',
    '',
    'verify checks the schema, exact DSH target, and the complete SHA-256 hash chain.',
    'inspect prints only metadata; it never prints recorded prompts or results.',
    'diff compares stable call identities and outcomes; exit code 2 means they differ.',
  ].join('\n')
}

function formatSummary(summary: ReturnType<typeof summarizeCassette>): string {
  return [
    `Cassette: ${summary.cassetteId}`,
    `File: ${summary.file ?? '<memory>'}`,
    `Provider: ${summary.provider.cassette} -> ${summary.provider.upstream}`,
    `Interactions: ${summary.interactions}`,
    `Completed / failed / aborted: ${summary.completed} / ${summary.failed} / ${summary.aborted}`,
    `Ambiguous duplicate groups: ${summary.ambiguousGroups}`,
    `Redacted results: ${summary.redactedResults}`,
  ].join('\n')
}

function terminal(summary: CassetteCallSummary): string {
  return summary.outcomeKind === 'result'
    ? (summary.stopReason ?? summary.outcomeKind)
    : summary.outcomeKind
}

function formatDiff(diff: CassetteDiff, expected: string, actual: string, showCalls: boolean): string[] {
  const changedTiming = diff.timing.filter(
    item => item.startLatencyDeltaMs !== 0 || item.deltaMs !== 0,
  )
  const lines = [
    `Expected: ${expected}`,
    `Actual: ${actual}`,
    `Comparable / equivalent: ${diff.comparable ? 'yes' : 'no'} / ${diff.equivalent ? 'yes' : 'no'}`,
    `Interactions: ${diff.expectedInteractions} -> ${diff.actualInteractions}`,
    `Added / removed / outcome / boundary: ${diff.added.length} / ${diff.removed.length} / `
      + `${diff.outcomeChanged.length} / ${diff.boundaryChanged.length}`,
    `Policy changes: ${diff.policyChanges.join(', ') || 'none'}`,
    `Comparison issues: ${diff.issues.join(', ') || 'none'}`,
    `Timing changes (informational): ${changedTiming.length}`,
  ]
  if (!showCalls) return lines
  for (const call of diff.added) lines.push(`+ ${call.callKey}  ${terminal(call)}`)
  for (const call of diff.removed) lines.push(`- ${call.callKey}  ${terminal(call)}`)
  for (const change of diff.outcomeChanged) {
    lines.push(`~ ${change.expected.callKey}  outcome ${terminal(change.expected)} -> ${terminal(change.actual)}`)
  }
  for (const change of diff.boundaryChanged) {
    lines.push(`~ ${change.expected.callKey}  boundary ${change.fields.join(', ')}`)
  }
  for (const timing of changedTiming) {
    lines.push(
      `= ${timing.expectedCallKey}  timing start ${timing.startLatencyDeltaMs >= 0 ? '+' : ''}`
      + `${timing.startLatencyDeltaMs.toFixed(1)}ms, duration ${timing.deltaMs >= 0 ? '+' : ''}`
      + `${timing.deltaMs.toFixed(1)}ms`,
    )
  }
  return lines
}

interface ParsedCommand {
  readonly positionals: string[]
  readonly json: boolean
  readonly showCalls: boolean
}

function parseCommandArgs(
  command: 'verify' | 'inspect' | 'diff',
  args: readonly string[],
): ParsedCommand {
  const positionals: string[] = []
  let json = false
  let showCalls = false
  for (const arg of args) {
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--show-calls') {
      showCalls = true
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option for ${command}: ${arg}`)
    positionals.push(arg)
  }
  const expected = command === 'diff' ? 2 : 1
  if (positionals.length !== expected) {
    const noun = command === 'diff' ? 'cassette files' : 'cassette file'
    throw new Error(`Expected ${expected} ${noun} for ${command}, received ${positionals.length}`)
  }
  return { positionals, json, showCalls }
}

/** Execute the dependency-free cassette CLI. */
export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (args.length === 1 && args[0] === '--version') {
    io.out(VERSION)
    return 0
  }
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h' || args.includes('--help')) {
    io.out(usage())
    return command === undefined ? 1 : 0
  }
  if (command !== 'verify' && command !== 'inspect' && command !== 'diff') {
    io.err(`Unknown command: ${command}\n\n${usage()}`)
    return 1
  }
  let parsed: ParsedCommand
  try {
    parsed = parseCommandArgs(command, args.slice(1))
  } catch (error: unknown) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    return 1
  }
  try {
    if (command === 'diff') {
      const expectedPath = parsed.positionals[0]
      const actualPath = parsed.positionals[1]
      if (expectedPath === undefined || actualPath === undefined) throw new Error('diff paths are unavailable')
      const [expected, actual] = await Promise.all([
        loadCassette(expectedPath),
        loadCassette(actualPath),
      ])
      const diff = diffCassettes(expected, actual)
      if (parsed.json) io.out(JSON.stringify(diff, null, 2))
      else for (const line of formatDiff(diff, expectedPath, actualPath, parsed.showCalls)) io.out(line)
      return diff.equivalent ? 0 : 2
    }
    const file = parsed.positionals[0]
    if (file === undefined) throw new Error('cassette path is unavailable')
    const cassette = await loadCassette(file)
    const summary = summarizeCassette(cassette)
    if (parsed.json) {
      const document = command === 'inspect' && parsed.showCalls
        ? {
            ...summary,
            calls: [...cassette.interactions]
              .sort((a, b) => a.sequence - b.sequence)
              .map(interaction => ({
                sequence: interaction.sequence,
                callKey: interaction.callKey,
                parentContextFingerprint: interaction.parentContextFingerprint,
                requestFingerprint: interaction.requestFingerprint,
                outcome: interaction.outcome.kind,
                stopReason: interaction.outcome.kind === 'result'
                  ? interaction.outcome.result.stopReason
                  : undefined,
                durationMs: interaction.timing.durationMs,
              })),
          }
        : summary
      io.out(JSON.stringify(document, null, 2))
    } else if (command === 'verify') {
      io.out(`OK: ${summary.interactions} interaction(s), hash chain verified (${summary.cassetteId})`)
    } else {
      io.out(formatSummary(summary))
      if (parsed.showCalls) {
        for (const interaction of [...cassette.interactions].sort((a, b) => a.sequence - b.sequence)) {
          const stop = interaction.outcome.kind === 'result'
            ? interaction.outcome.result.stopReason
            : interaction.outcome.kind
          io.out(
            `${interaction.sequence.toString().padStart(4)}  ${interaction.callKey}  ${stop}  `
            + `${interaction.timing.durationMs.toFixed(1)}ms`,
          )
        }
      }
    }
    return 0
  } catch (error: unknown) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2))
}
