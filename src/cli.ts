#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { loadCassette, summarizeCassette } from './format.ts'

const VERSION = '0.1.0'

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
    '  dsh-cassette --version',
    '',
    'verify checks the schema, exact DSH target, and the complete SHA-256 hash chain.',
    'inspect prints only metadata; it never prints recorded prompts or results.',
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

/** Execute the dependency-free cassette CLI. */
export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (args.includes('--version')) {
    io.out(VERSION)
    return 0
  }
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h') {
    io.out(usage())
    return command === undefined ? 1 : 0
  }
  if (command !== 'verify' && command !== 'inspect') {
    io.err(`Unknown command: ${command}\n\n${usage()}`)
    return 1
  }
  const file = args[1]
  if (file === undefined || file.startsWith('-')) {
    io.err(`Missing cassette file.\n\n${usage()}`)
    return 1
  }
  const json = args.includes('--json')
  const showCalls = args.includes('--show-calls')
  try {
    const cassette = await loadCassette(file)
    const summary = summarizeCassette(cassette)
    if (json) {
      const document = command === 'inspect' && showCalls
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
      if (showCalls) {
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

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
