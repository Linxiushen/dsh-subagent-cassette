# Changelog

All notable changes to this project are documented in this file. The project follows semantic versioning for its own API; cassette schema compatibility is also gated by the explicit format version and exact DSH target stored in each file.

## [Unreleased]

No changes yet.

## [0.2.0] - 2026-08-18

### Added

- Structured replay mismatch diagnostics with five explicit failure reasons, deterministic candidates, and consumption state.
- Non-consuming `InteractionMatcher.diagnose()` and `CassetteMismatchError.diagnostic` APIs.
- Strict metadata-safe `diffCassettes()` API and `dsh-cassette diff` CLI for cassette regression checks.
- CI-oriented diff exit codes: `0` for equivalent, `2` for different or non-comparable, and `1` for operational errors.
- A public `dsh-subagent-cassette/diff` package export.

### Changed

- CLI parsing now rejects unknown options and unexpected positional arguments.
- Diff treats timing as informational, ignores physical completion order, and fails closed for ambiguous duplicate groups or changed parent-context semantics.

### Fixed

- Installed pnpm bin shims now execute the CLI correctly by using the supported `import.meta.main` entry check.

### Security

- Mismatch and diff reports are limited to call metadata and unsalted fingerprints; prompt, result, and recorded error bodies are covered by regression tests.
- Documented that the legacy `InteractionMatcher.describe()` debugging view includes prompt content.

Cassette format version `1` and the exact DSH `0.1.0-rc.7` compatibility target are unchanged.

## [0.1.0] - 2026-08-18

Initial source release targeting the DeepSeek Harness `0.1.0-rc.7` package family.

### Added

- Record-mode one-shot provider wrapper for any registered upstream provider.
- Fully offline replay provider with captured capability facts.
- Stable parent topology paths, canonical parent-context/request fingerprints, and per-group occurrences.
- Completion-order-independent matching for distinct concurrent sibling requests.
- Fail-closed ambiguity detection, with explicit `duplicatePolicy: sequence` opt-in.
- Metadata-only request persistence by default and opt-in full request storage.
- Built-in normalized credential-key and `sk-`/provider-token redaction, plus configurable regular-expression redaction.
- Default refusal to replay successful results changed by redaction.
- Successful result, startup error, result error, timing, abort, and disposal recording.
- Version-1 JSONL format with exact DSH target validation and a forward SHA-256 record chain.
- Compatible append, exclusive create, and explicit truncate modes protected by a cross-process writer lock.
- Replay consumption assertion and live cancellation/disposal behavior.
- Parent-scoped unique replay run ids and shared quiescence promises for concurrent disposal calls.
- `dsh-cassette verify` and metadata-only `inspect` commands.
- Cordis bundle patch, programmatic installation API, bilingual documentation, security policy, and examples.

### Known limits

- One-shot provider boundary only; continuable children and generic session replay are not supported.
- Replay does not recreate `localAgent` or execute a recorded nested local child tree.
- One logical top-level root per cassette scenario.
- The unkeyed hash chain is not authentication and has no trusted tail commitment.

[Unreleased]: https://github.com/Linxiushen/dsh-subagent-cassette/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Linxiushen/dsh-subagent-cassette/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Linxiushen/dsh-subagent-cassette/releases/tag/v0.1.0
