import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = await import(new URL('../dist/index.js', import.meta.url))

assert.equal(entry.CASSETTE_FORMAT, 'dsh-subagent-cassette')
assert.equal(entry.CASSETTE_VERSION, 1)
assert.equal(typeof entry.installCassette, 'function')
assert.equal(typeof entry.apply, 'function')
assert.equal('default' in entry, false)

const result = spawnSync(process.execPath, ['dist/cli.js', '--version'], {
  cwd: packageRoot,
  encoding: 'utf8',
})
assert.equal(result.status, 0, result.stderr)
assert.equal(result.stdout.trim(), '0.1.0')
