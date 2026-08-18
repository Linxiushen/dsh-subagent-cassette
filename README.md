# dsh-subagent-cassette

[![CI](https://github.com/Linxiushen/dsh-subagent-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/Linxiushen/dsh-subagent-cassette/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

Topology-aware, VCR-style recording and offline replay for DeepSeek Harness one-shot subagent calls.

`dsh-subagent-cassette` installs a separate `SubagentProvider`. In record mode it delegates to a real provider such as `spawn` and persists the terminal boundary outcome. In replay mode it makes no upstream provider or model call: the live topology, observable parent context, and exact request are matched to a recorded interaction, then the saved result or infrastructure error is returned.

> Compatibility: this release intentionally targets `@deepseek-ai/dsh-subagent` **`0.1.0-rc.7`** and the corresponding DSH package family. It is not a compatibility claim for later release candidates.

## Why this exists

Completion order is not a stable identity for concurrent sibling subagents. Two children may start as A/B, finish as B/A, and be scheduled differently on replay. This project matches a call with:

```text
stable parent topology path
+ SHA-256(canonical observable parent context)
+ SHA-256(canonical normalized request)
```

Distinct sibling requests can therefore complete and be replayed in a different order without swapping outcomes. This guarantee is deliberately narrow:

- the observable parent context and normalized request must be exactly reproducible;
- a cassette represents one logical top-level root;
- identical requests under the same parent and parent context are occurrences of one group;
- if identical requests recorded different outcomes, replay rejects the cassette by default;
- `duplicatePolicy: sequence` explicitly accepts occurrence-order matching for that ambiguous case.

This is strict boundary replay, not a general session simulator or a claim that an agent run is globally deterministic.

## Features

- Wraps any registered one-shot provider without replacing it.
- Replays without the upstream provider, model credentials, or network access.
- Matches concurrent siblings by topology, parent context, and request fingerprint, not completion order.
- Captures success, provider startup failure, post-publication infrastructure failure, timing, cancellation observation, and disposal observation.
- Stores request metadata by default; full prompt storage is opt-in.
- Redacts common credential shapes and configurable regular expressions from persisted data.
- Refuses replay of a redacted result by default, because `[REDACTED]` is substituted data.
- Uses a versioned JSONL format with a forward SHA-256 record chain.
- Holds an exclusive cross-process writer lock for create, truncate, and append modes.
- Provides metadata-only `verify`, `inspect`, and strict cassette `diff` CLI commands.
- Returns structured, metadata-safe diagnostics for exact replay mismatches.
- Checks for unmatched cassette interactions at replay teardown by default.

## Non-goals and current limits

- Only the one-shot `SubagentProvider.start()` boundary is supported. Continuable children, follow-ups, cold resume, and continuation management are out of scope.
- Replay returns `localAgent: undefined`; it does not recreate a local child Agent or Session.
- Recording can assign stable paths to nested calls when the upstream run exposes `localAgent` and those calls also use the cassette provider. Offline replay still returns the recorded outer boundary result rather than re-executing that nested child tree. A cassette containing independently expected nested calls may therefore leave interactions unconsumed.
- A recording provider accepts one top-level parent identity during its lifetime. Use a separate cassette for each independent root scenario.
- No fuzzy, semantic, or label-only matching is performed.
- Parent matching covers the stable public state used by DSH's official in-process providers. A third-party provider can consult additional Cordis services or external state that this boundary cannot observe; replay is not proof that such hidden inputs were unchanged.
- The hash chain is an integrity diagnostic, not authentication. It does not prevent a writer from recomputing the chain, and it cannot prove that a valid suffix was not removed.
- No dashboard, benchmark DSL, LLM judge, or generic DSH session replay is included.

## Install from source

The project is currently documented for source or local-tarball installation; these instructions do **not** assume that an npm release exists.

Prerequisites:

- Node.js `22.19.x` or Node.js `24.x`
- pnpm `>=11.7.0 <12`
- `@deepseek-ai/cordis@4.0.1` and a DSH deployment pinned to the `0.1.0-rc.7` package family

```bash
git clone https://github.com/Linxiushen/dsh-subagent-cassette.git
cd dsh-subagent-cassette
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination .artifacts
```

Install the resulting tarball into the DSH profile you use, for example:

```bash
dsh plugin --profile web add ./.artifacts/dsh-subagent-cassette-0.2.0.tgz
dsh --profile web --dump-config
```

The package declares [`cordis.patch.yml`](cordis.patch.yml) as its DSH bundle patch. It registers `cassette` beside the real provider; it does not change the provider selected by existing callers. A deployment with a custom bundle workflow can merge the supplied patch or one of the [`examples`](examples/) explicitly.

## Quick start

### 1. Record

Register `cassette` beside the real provider:

```yaml
# Cordis/DSH bundle patch
- insert:
    - id: subagent-cassette
      name: "dsh-subagent-cassette"
      config:
        mode: record
        provider: cassette
        upstreamProvider: spawn
        file: ".dsh-cassettes/repository-audit.cassette.jsonl"
        writeMode: create
        requestStorage: metadata
        redactSecrets: true
```

Route the one-shot subagent calls being captured to provider `cassette`. Calls that still select `spawn` bypass the recorder. Run one logical root scenario, wait for its subagent runs to settle, and dispose the plugin normally so admitted outcomes are flushed.

The file path is resolved from the process working directory. For repeated ad hoc captures, the bundled default uses `{timestamp}` and `{pid}` tokens. For a reusable fixture, choose an explicit filename as above.

### 2. Verify, inspect, and diff

From this source checkout after `pnpm build`:

```bash
node dist/cli.js verify .dsh-cassettes/repository-audit.cassette.jsonl
node dist/cli.js inspect .dsh-cassettes/repository-audit.cassette.jsonl --show-calls
node dist/cli.js diff baseline.cassette.jsonl candidate.cassette.jsonl --show-calls
```

From a deployment that installed the package:

```bash
pnpm exec dsh-cassette verify .dsh-cassettes/repository-audit.cassette.jsonl
pnpm exec dsh-cassette inspect .dsh-cassettes/repository-audit.cassette.jsonl --json --show-calls
pnpm exec dsh-cassette diff baseline.cassette.jsonl candidate.cassette.jsonl --json
```

`inspect` prints metadata, call keys, fingerprints, outcome kinds, stop-reason categories, and durations. Stop reasons are bounded to `completed`, `aborted`, `error`, `max-tokens`, `refusal`, or `other`; an unknown future DSH value is reported only as `other`. Human output escapes control, format, and line-separator characters from cassette-derived text, and JSON output encodes them with valid JSON escapes. It never prints stored prompts, result bodies, or the raw unknown stop-reason value. Labels can appear inside metadata and readable call keys, so CLI output is not necessarily anonymous.

`diff` aligns only the exact stable identity `(parent key, parent-context fingerprint, request fingerprint, occurrence)`. It reports added, removed, outcome-changed, and boundary-changed calls plus recording-policy drift. Timing deltas are informational and do not affect equivalence. Exit code `0` means equivalent, `2` means different or not safely comparable, and `1` means usage, read, or format failure. Ambiguous duplicate groups and changed parent-context inheritance semantics fail closed instead of being guessed into alignment.

Cassette loading also fails closed at the persisted request boundary. Each metadata or full request view accepts only its documented fields, and every interaction's `request.storage` must match the header's `requestStorage` policy. These checks apply before replay, inspect, diff, or append. This hardening does not change cassette format version `1` or the exact DSH `0.1.0-rc.7` target.

### 3. Replay offline

Use the exact recorded file and run the same request-producing scenario:

```yaml
- insert:
    - id: subagent-cassette
      name: "dsh-subagent-cassette"
      config:
        mode: replay
        provider: cassette
        file: ".dsh-cassettes/repository-audit.cassette.jsonl"
        timing: instant
        duplicatePolicy: reject
        allowRedactedReplay: false
        assertConsumed: true
```

Replay loads and verifies the complete available file before registering the provider. It also rejects ambiguous duplicate groups and redacted successful results according to the policy above. No `spawn` provider is required for the replayed calls.

## Configuration

| Option | Mode | Default | Meaning |
|---|---|---:|---|
| `mode` | both | `record` | `record` or `replay`. |
| `provider` | both | `cassette` | Name registered in `ctx.subagents`. |
| `file` | both | timestamped path | Cassette JSONL path. Replay should always set a fixed path. |
| `redactSecrets` | record | `true` | Enable built-in key and string redaction while recording. Stored in the header and checked for append compatibility; replay uses the recorded file and ignores this setting. |
| `redactionPatterns` | record | `[]` | Extra JavaScript regular-expression sources, compiled globally and case-insensitively. A pattern matching a content-block `type` or image `mediaType` rejects recording because those fields are structural. Replay does not re-redact loaded data. |
| `upstreamProvider` | record | `spawn` | Real provider to delegate to. Must differ from `provider`. |
| `writeMode` | record | `create` | `create` refuses an existing file; `truncate` replaces it; `append` verifies and extends a compatible file. Every mode fails fast when another cassette writer holds the target lock. |
| `requestStorage` | record | `metadata` | `metadata` omits prompt content; `full` persists the normalized request after redaction. |
| `timing` | replay | `instant` | `instant` returns without recorded delays; `recorded` reproduces recorded boundary delays. |
| `speed` | replay | `1` | Finite multiplier of at least `0.001` for `recorded` timing; `2` is twice as fast. Scaled delays must remain finite. |
| `duplicatePolicy` | replay | `reject` | Reject differing outcomes for identical parent-context/request groups, or use explicit `sequence` occurrence matching. |
| `allowRedactedReplay` | replay | `false` | Permit replaying successful results containing redaction substitutions. |
| `assertConsumed` | replay | `true` | Throw during disposal if recorded interactions remain unmatched. |

Programmatic users can call `installCassette(ctx, config)` and retain the returned handle. See [`examples/programmatic.ts`](examples/programmatic.ts).

## What is fingerprinted and stored

The request fingerprint covers the lossless JSON snapshot of:

- `label`
- `prompt`
- `agentOptions`
- `outputSchema`
- `maxDepth`
- `toolFilter`
- `persona`

It excludes the abort signal, volatile parent identity, and generated descriptor fields. Object keys are sorted before SHA-256 hashing; array order remains significant.

The separate parent-context fingerprint covers parent Agent options; stable session `cwd`, `origin`, delegation depth, and preset facts; the live composed preset and delegated sandbox/approval facts when those DSH services are present; and, for a provider whose `inheritsParentContext` flag is true, the completed-turn model-visible message prefix plus its latest system prompt and tool schemas. Volatile Session/message ids are omitted and correlated tool-call ids are deterministically renumbered. The in-flight turn is not part of a fork prefix.

These are the public inputs used by DSH's official `spawn`/`fork` in-process path. An arbitrary provider remains free to read other services, files, clocks, or network state, so exact fingerprint agreement is a strict boundary match rather than a claim of global determinism.

With `requestStorage: metadata`, prompt text and parent history are not written as request fields. The cassette still stores unsalted request and parent-context fingerprints, prompt block/byte counts, selected metadata, and the final output or error. Low-entropy prompts or parent context can be guessed and checked against those fingerprints. Treat every cassette as potentially sensitive.

See [Format](docs/format.md) for the schema and [Security](docs/security.md) for the threat model.

## Replay semantics

| Recorded boundary state | Replay behavior |
|---|---|
| Provider rejected before publishing a run | `start()` rejects with `CassetteRecordedError`. |
| Run result resolved | `result` resolves to a detached snapshot of the persisted result. |
| Run result rejected | `result` rejects with `CassetteRecordedError`. |
| Live signal aborts before replay publication | `start()` rejects with an abort-shaped recorded error. |
| Live signal aborts or `dispose()` occurs after publication | `result` resolves with `{ output: [], stopReason: "aborted" }`. |

Recorded failures preserve the recorded name, message, and optional string code, but not the original error class, stack, cause, or arbitrary properties.

`timing: recorded` waits for recorded start latency and remaining duration divided by `speed`. It reproduces boundary delay, not internal scheduling or token streaming.

## Mismatch diagnostics

`InteractionMatcher.diagnose(request)` performs the same exact analysis as replay without consuming an interaction or reserving a new root parent. It returns either a matching candidate or one of five mismatch reasons:

- `group-exhausted`
- `parent-context-changed`
- `request-changed`
- `parent-and-request-changed`
- `parent-not-found`

When `match()` fails, the same object is available as `CassetteMismatchError.diagnostic`. Candidates are deterministically ordered by recorded admission sequence and identify whether each call is already consumed. Failed normalization, parent fingerprinting, or exact matching does not reserve a new root or occurrence, so a corrected call can retry without poisoned topology state. The matcher constructs candidate metadata from an explicit field allowlist instead of returning a stored metadata object, so forged or future extra fields cannot leak through this path. The diagnostic contains call keys, fingerprints, occurrence data, and approved request metadata only; it never includes stored prompt, result, or error bodies. These candidates explain a failure and are never used for fuzzy matching.

## Integrity model

Each JSONL record includes a canonical SHA-256 hash, and every interaction names the preceding physical record hash. Verification can detect malformed JSON, duplicate object members, non-lossless numeric values, unsupported schema/target versions, changed content, middle-record deletion, reordering, duplicate sequence numbers, call keys or occurrences, many partial writes, and a broken available chain.

It cannot authenticate the file, stop a malicious editor from recomputing hashes, or detect removal of a complete valid suffix when no external expected tail hash/count exists. Keep cassettes in normal source-control or artifact-store integrity controls. See [Format](docs/format.md#integrity-and-validation) for exact guarantees.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm check
```

`pnpm check` runs linting, type checking, coverage-gated tests, build, distribution smoke tests, and `publint`. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing matching or the persisted format.

## Documentation

- [Architecture](docs/architecture.md)
- [Cassette format](docs/format.md)
- [Security model](docs/security.md)
- [Examples](examples/README.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
