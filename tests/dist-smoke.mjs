import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = await import(new URL('../dist/index.js', import.meta.url))

assert.equal(entry.CASSETTE_FORMAT, 'dsh-subagent-cassette')
assert.equal(entry.CASSETTE_VERSION, 1)
assert.equal(typeof entry.installCassette, 'function')
assert.equal(typeof entry.apply, 'function')
assert.equal(typeof entry.diffCassettes, 'function')
assert.equal('default' in entry, false)

const diffEntry = await import(new URL('../dist/diff.js', import.meta.url))
assert.equal(typeof diffEntry.diffCassettes, 'function')

const result = spawnSync(process.execPath, ['dist/cli.js', '--version'], {
  cwd: packageRoot,
  encoding: 'utf8',
})
assert.equal(result.status, 0, result.stderr)
assert.equal(result.stdout.trim(), '0.2.0')

const formatEntry = await import(new URL('../dist/format.js', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'dsh-cassette-dist-'))
try {
  const file = join(temp, 'fixture.cassette.jsonl')
  const candidateFile = join(temp, 'candidate.cassette.jsonl')
  const headerOptions = {
    cassette: 'cassette',
    upstream: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    requestStorage: 'metadata',
    redactSecrets: false,
  }
  const interaction = {
    kind: 'cassette/interaction',
    sequence: 1,
    callKey: 'root/smoke~1',
    parentKey: 'root',
    parentContextFingerprint: `sha256:${'a'.repeat(64)}`,
    occurrence: 1,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    request: {
      storage: 'metadata',
      metadata: { promptBlocks: 1, promptBytes: 5, hasOutputSchema: false, hasPersona: false },
    },
    timing: { startedAt: new Date(0).toISOString(), startLatencyMs: 0, durationMs: 1 },
    published: true,
    local: false,
    outcome: { kind: 'result', result: { output: [], stopReason: 'completed' }, redactions: 0 },
  }
  const writer = await formatEntry.CassetteWriter.open(
    file,
    formatEntry.createHeader(headerOptions),
    'create',
  )
  await writer.append(interaction)
  await writer.close()

  const candidateWriter = await formatEntry.CassetteWriter.open(
    candidateFile,
    formatEntry.createHeader(headerOptions),
    'create',
  )
  await candidateWriter.append({
    ...interaction,
    outcome: {
      kind: 'result',
      result: { output: [{ type: 'text', text: 'DIST_PRIVATE_SENTINEL' }], stopReason: 'completed' },
      redactions: 0,
    },
  })
  await candidateWriter.close()

  const diff = spawnSync(process.execPath, ['dist/cli.js', 'diff', file, file, '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  assert.equal(diff.status, 0, diff.stderr)
  assert.equal(JSON.parse(diff.stdout).equivalent, true)

  const changed = spawnSync(process.execPath, ['dist/cli.js', 'diff', file, candidateFile, '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  assert.equal(changed.status, 2, changed.stderr)
  assert.equal(JSON.parse(changed.stdout).equivalent, false)
  assert.equal(changed.stdout.includes('DIST_PRIVATE_SENTINEL'), false)

  const linkedDist = join(temp, 'linked-dist')
  await symlink(join(packageRoot, 'dist'), linkedDist, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const linkedCli = spawnSync(process.execPath, [join(linkedDist, 'cli.js'), '--version'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    assert.equal(linkedCli.status, 0, linkedCli.stderr)
    assert.equal(linkedCli.stdout.trim(), '0.2.0')
  } finally {
    await unlink(linkedDist)
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
