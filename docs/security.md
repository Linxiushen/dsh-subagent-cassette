# Security model

Cassettes cross a trust boundary: they persist agent requests, outputs, and error facts and later feed saved outputs back into an application. Treat them as sensitive test artifacts and as untrusted input unless their provenance is controlled.

## Threat model

This project aims to reduce these risks:

- accidental secret persistence in common fields and credential-like strings;
- silent replay against a changed or incomplete request set;
- accidental file modification, middle deletion, reordering, or partial writes;
- unintentionally accepting substituted redacted output as the original result;
- network or credential use during replay.

This project does not defend against:

- an attacker who can edit the cassette and recompute its unkeyed hashes;
- deletion of a complete valid file suffix without an external tail commitment;
- disclosure through filesystem permissions, backups, logs, source control, or artifact services;
- secrets that do not match built-in keys/patterns or configured patterns;
- denial of service from very large trusted-input files or expensive user-supplied regular expressions;
- malicious instructions or data contained in a valid recorded result;
- compromise of the record-time upstream provider, model, or host process.

The cassette parser performs structural validation. It rejects duplicate JSON object members before trusting the parsed value, so an overwritten raw member cannot sit outside the canonical record hash. It is not a sandbox or a content-safety engine.

## Data written during recording

Even with the default `requestStorage: metadata`, a cassette contains:

- a SHA-256 fingerprint of the complete normalized request, including prompt text;
- a SHA-256 fingerprint of observable parent context, including inherited completed-turn messages for fork-style providers;
- prompt block and byte counts;
- optional label, child provider/model, tool filter, and depth metadata;
- complete terminal `SubagentResult` data after configured redaction;
- error names, messages, and optional codes after configured redaction;
- timestamps, timing, topology keys, and provider facts.

An unsalted fingerprint is not encryption. If a prompt, parent history, system prompt, tool set, or other context has low entropy or comes from a known candidate set, another party can hash guesses and compare them. Labels and call keys can also disclose scenario names.

`requestStorage: full` additionally writes the normalized request after redaction. Use it only when prompt inspection is required and repository/artifact access is appropriate.

## Redaction behavior

Redaction is enabled by default while recording. It recursively:

- normalizes structured keys by removing punctuation and case, then replaces exact credential keys and common suffixes such as `apiKey`, `accessToken`, `refreshToken`, `idToken`, and `clientSecret`;
- replaces common bearer tokens, `sk-`/`sk_` and GitHub token prefixes, AWS access key ids, and normalized credential assignment strings;
- applies each configured regular-expression source globally and case-insensitively to strings.

The replacement value is `[REDACTED]`.

Redaction applies to persisted full requests, successful results, and the selected fields of recorded errors. For request `prompt` and result `output` content trees, it is schema-aware: every content block's `type` discriminator and every image attachment's `mediaType` are protected from substitution. If any built-in or configured pattern would alter one of those structural strings, recording fails with `INVALID_CONFIG` instead of silently bypassing the pattern or writing an unloadable record. Other strings, including image names and block payloads, remain eligible for redaction. Redaction does not mutate a successful result returned to the record-mode caller when persistence succeeds. Raw request and parent-context fingerprints are computed before redaction; their source text is not written, but dictionary testing remains possible.

### Redaction limitations

- Key matching uses a finite normalized-key/suffix list, not a semantic secret classifier.
- Encoded, fragmented, novel, binary, or context-specific credentials can be missed.
- Overbroad patterns can destroy valid payload semantics or reject a recording when they match a protected structural field.
- Custom regexes execute in the recording process. Treat configuration as trusted and avoid catastrophic-backtracking expressions.
- Error outcomes do not carry a redaction count in format version 1.
- Disabling redaction stores snapshots as supplied and should be restricted to synthetic fixtures.

Inspect generated cassettes with an appropriate secret scanner before committing or uploading them. Do not paste a raw cassette into a public issue.

## Redacted-result replay policy

Every successful interaction records a redaction count. If any count is greater than zero, replay construction fails by default. This prevents a test from silently treating `[REDACTED]` as the original model or tool output.

`allowRedactedReplay: true` is an explicit data-substitution decision. Use it only when:

- the substituted field is irrelevant to the assertion;
- downstream code safely handles the literal placeholder;
- no test is intended to validate the original secret-bearing value.

This guard applies to successful results. Redacted request views are not replay outputs, and format version 1 cannot make the same count-based decision for redacted error messages.

## Offline replay boundary

Replay mode does not look up or call the recorded upstream provider. It loads the local cassette and serves matches from memory. This removes model/network activity from the cassette provider itself.

It does not guarantee that the rest of the Harness deployment is offline. Other providers, tools, plugins, hooks, or application code can still use the network. Enforce offline testing with the host sandbox, network policy, and test configuration as needed.

## File integrity

The forward SHA-256 chain is designed for corruption detection, not adversarial authenticity. It validates the content and order of all records that are present. Since it is unkeyed and has no trusted trailer, it cannot establish who produced the file or whether a complete suffix was removed.

For higher-assurance fixtures:

1. Run `dsh-cassette verify` before use.
2. Store the file under source control and pin the expected commit.
3. Review cassette changes like source code.
4. For distributed artifacts, publish a signed manifest containing the file digest and expected size or record count.
5. Restrict write access to the recording job and read access to the tests that need it.

Do not use the internal record hashes as a substitute for artifact signing.

## Untrusted cassette input

Loading performs synchronous JSON parsing and canonical hashing over the whole file content after an asynchronous read. Only load cassettes from bounded, trusted storage in production-like processes. Large files can consume memory and CPU even when structurally valid.

Cassette-owned wrappers are closed schemas: unknown fields are rejected on headers, provider facts and capabilities, interactions, timing, request views, outcomes, and recorded errors. DSH result bodies and unknown typed content blocks remain deliberate extension points. Content-block traversal and persistence redaction use iterative worklists; the format regression suite exercises 20,000 nested `tool-result` blocks without recursive or quadratic path construction. This removes a stack-depth failure mode but does not remove the overall size-based denial-of-service limit above.

Recorded results should be treated as untrusted external data at the application boundary, just like live provider output. Replay intentionally returns them; it does not sanitize commands, URLs, markup, tool arguments, or prompt-injection content.

## Diagnostic and diff output

Structured mismatch diagnostics project only parent/call keys, request and parent-context fingerprints, occurrences, consumption state, and the request metadata already used by metadata-mode cassettes. `InteractionMatcher` rebuilds candidate metadata from an explicit allowlist rather than returning a stored object directly. This is defense in depth for programmatically constructed or forged cassette objects and for fields a future format may add. Diagnostics do not include live or stored prompt bodies, result bodies, recorded error messages, or unapproved metadata fields. Cassette diff reports use the same boundary and represent outcomes only by terminal metadata and unsalted SHA-256 fingerprints.

Inspect and diff expose stop reasons through the bounded categories `completed`, `aborted`, `error`, `max-tokens`, `refusal`, and `other`. An unknown future DSH string maps to `other`; its raw value is not included in human or JSON diagnostic output. The raw string remains inside the persisted result, is returned by replay, and contributes to exact outcome fingerprint comparison. Treat it as sensitive cassette content even though metadata-facing reports suppress it.

This output is metadata-safe, not anonymous or cryptographically private. Labels, tool filters, provider/model names, topology paths, byte counts, filesystem paths printed by the human CLI, and low-entropy fingerprints can still disclose or confirm sensitive facts. Outcome fingerprints can likewise be checked against guessed low-entropy results or errors. Apply the same log access and retention controls used for cassette metadata.

Human CLI output and CLI errors escape Unicode control, format, line-separator, and paragraph-separator characters as visible `\u{...}` sequences before writing to a terminal. JSON mode encodes the same characters inside string literals with valid JSON escapes, including surrogate pairs for non-BMP characters. This prevents cassette-derived call keys, provider facts, paths, or errors from injecting forged lines, ANSI control sequences, or invisible formatting while keeping JSON output parseable.

`InteractionMatcher.describe()` is a legacy low-level debugging API that returns a canonical representation containing the normalized live request, including prompt content. Do not log or publish its result. Prefer `diagnose()` and `CassetteMismatchError.diagnostic` for metadata-safe failure reporting.

## Operational recommendations

- Keep `.dsh-cassettes/` out of source control by default; add only reviewed synthetic fixtures intentionally.
- Prefer `writeMode: create` to avoid accidentally combining runs.
- Use one explicit file per logical root scenario.
- Keep `requestStorage: metadata`, `redactSecrets: true`, `duplicatePolicy: reject`, `allowRedactedReplay: false`, and `assertConsumed: true` unless a reviewed test requires otherwise.
- Use fixed filenames for replay and collision-resistant `{timestamp}`/`{pid}` filenames for ad hoc recording.
- Verify after abnormal shutdown; append mode also validates before writing. A crashed writer can leave a fail-closed `.writer.lock` directory that must be removed only after confirming no writer is active.
- Delete or rotate captures according to the sensitivity and retention policy of the underlying prompts and outputs.

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for `Linxiushen/dsh-subagent-cassette` rather than opening a public issue. Include:

- the project version and exact DSH package versions;
- record/replay configuration with secrets removed;
- expected and observed impact;
- a minimal synthetic reproducer when possible.

Do not attach real cassettes, credentials, private prompts, or model outputs. Ordinary correctness bugs without sensitive impact can use the public issue tracker.

## Supported versions

Until the first stable release, security fixes are provided on the latest `0.2.x` source release only. The current implementation target remains DSH `0.1.0-rc.7`; using another DSH version is unsupported even if dependency resolution is forced.
