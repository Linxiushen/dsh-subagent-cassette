# Cassette format

`dsh-subagent-cassette` uses a versioned, newline-delimited JSON format. Format version `1` targets `@deepseek-ai/dsh-subagent` exactly at `0.1.0-rc.7`.

## Media and layout

- Encoding: UTF-8 JSON text.
- Layout: one JSON object per non-empty line.
- Line 1: exactly one `cassette/header` record.
- Remaining lines: zero or more `cassette/interaction` records.
- Blank lines are ignored by the parser.

The file suffix `.cassette.jsonl` is conventional, not part of validation.

## Canonical JSON and digests

Record hashes and request/parent-context fingerprints use the project's canonical serializer:

- object keys are sorted lexicographically;
- array order is preserved;
- strings, booleans, and `null` use JSON encoding;
- numbers must be finite and must not be negative zero;
- undefined and non-lossless values are rejected.

Digest strings use this shape:

```text
sha256:<64 lowercase hexadecimal characters>
```

SHA-256 input is the UTF-8 encoding of canonical JSON.

## Header

A conceptual header is:

```json
{
  "kind": "cassette/header",
  "format": "dsh-subagent-cassette",
  "version": 1,
  "cassetteId": "0f70b758-74cc-4ae2-b278-fd32a2adfc48",
  "createdAt": "2026-08-18T03:00:00.000Z",
  "target": { "dshSubagent": "0.1.0-rc.7" },
  "provider": {
    "cassette": "cassette",
    "upstream": "spawn",
    "capabilities": {
      "outputSchema": true,
      "depthLimit": true,
      "toolFilter": true,
      "persona": true
    },
    "inheritsParentContext": false
  },
  "requestStorage": "metadata",
  "redactSecrets": true,
  "redactionPatterns": [],
  "hash": "sha256:..."
}
```

| Field | Meaning |
|---|---|
| `format`, `version` | Exact format identity. Unknown values are rejected, not best-effort parsed. |
| `cassetteId` | Random UUID-shaped writer identity. The parser requires a non-empty string but does not use it for matching. |
| `createdAt` | Parseable creation timestamp. |
| `target.dshSubagent` | Exact service contract target, currently `0.1.0-rc.7`. |
| `provider` | Cassette/upstream names and the upstream facts exposed during replay. |
| `requestStorage` | Persistence policy used for all interaction request views. |
| `redactSecrets`, `redactionPatterns` | Persistence redaction policy used when recording. |
| `hash` | Hash of the complete header body with `hash` omitted. |

## Interaction

Each terminal boundary writes one interaction:

```json
{
  "kind": "cassette/interaction",
  "sequence": 1,
  "callKey": "root/audit-8c676fdd50f5~1",
  "parentKey": "root",
  "parentContextFingerprint": "sha256:...",
  "occurrence": 1,
  "requestFingerprint": "sha256:...",
  "request": {
    "storage": "metadata",
    "metadata": {
      "label": "audit",
      "promptBlocks": 1,
      "promptBytes": 96,
      "hasOutputSchema": false,
      "hasPersona": false
    }
  },
  "timing": {
    "startedAt": "2026-08-18T03:00:01.000Z",
    "startLatencyMs": 14.22,
    "durationMs": 829.17
  },
  "published": true,
  "local": true,
  "outcome": {
    "kind": "result",
    "result": { "output": [], "stopReason": "completed" },
    "redactions": 0
  },
  "previousHash": "sha256:...",
  "hash": "sha256:..."
}
```

### Identity fields

| Field | Constraint and use |
|---|---|
| `sequence` | Positive safe integer, globally unique and contiguous from 1 through interaction count. Reserved at call admission. |
| `callKey` | Globally unique diagnostic topology path for this file. |
| `parentKey` | Stable topology path used in matching. |
| `parentContextFingerprint` | SHA-256 of observable parent state normalized for stable cross-Session matching. |
| `occurrence` | Positive, unique, contiguous integer within one parent-context/request group. |
| `requestFingerprint` | SHA-256 of the unredacted normalized request snapshot. |

The file can physically contain sequence `2` before sequence `1` because persistence follows terminal completion. The hash chain follows physical line order.

### Request views

Metadata storage has this union arm:

```json
{
  "storage": "metadata",
  "metadata": {
    "label": "optional",
    "promptBlocks": 1,
    "promptBytes": 96,
    "hasOutputSchema": false,
    "maxDepth": 2,
    "childProvider": "optional",
    "childModel": "optional",
    "toolFilter": {},
    "hasPersona": false
  }
}
```

Optional keys are omitted when absent. Metadata mode does not write prompt content, `agentOptions` in full, `outputSchema` in full, or the persona string.

Full storage has this shape:

```json
{
  "storage": "full",
  "value": {
    "label": "audit",
    "prompt": [{ "type": "text", "text": "..." }]
  },
  "redactions": 0
}
```

`value` is the redacted normalized request. `requestFingerprint` is computed before redaction, so redacting stored request text does not change matching identity.

### Timing

| Field | Meaning |
|---|---|
| `startedAt` | Wall-clock ISO timestamp observed before upstream start. |
| `startLatencyMs` | Monotonic elapsed milliseconds until publication or startup failure. |
| `durationMs` | Monotonic elapsed milliseconds until terminal outcome persistence begins. Must not be less than start latency. |
| `signalAbortedAtMs` | Optional observed live abort offset. It is diagnostic, not automatically reenacted. |
| `disposeCalledAtMs` | Optional observed run disposal offset. It is diagnostic, not automatically reenacted. |

Values are rounded to microsecond-shaped decimal precision but should be treated as ordinary non-negative finite millisecond measurements, not high-accuracy wall-clock evidence.

### Publication and locality

- `published: false` is valid only with `start-error`.
- `published: true` is required for `result` and `result-error`.
- `local: true` requires a published run whose upstream exposed `localAgent`.

Replay preserves captured provider capability facts but always returns `localAgent: undefined`; `local` describes the recording.

### Outcome union

Successful boundary result:

```json
{
  "kind": "result",
  "result": {
    "output": [{ "type": "text", "text": "..." }],
    "stopReason": "completed"
  },
  "redactions": 0
}
```

`result` must at least contain `output` as an array and `stopReason` as a string. Other valid `SubagentResult` data, such as structured output, remains in the snapshot.

Startup failure:

```json
{
  "kind": "start-error",
  "error": { "name": "Error", "message": "provider offline", "code": "OFFLINE" }
}
```

Post-publication infrastructure or serialization failure:

```json
{
  "kind": "result-error",
  "error": { "name": "Error", "message": "transport failed" }
}
```

Only `name`, `message`, and an optional string `code` are persisted for errors. Error messages are redacted when redaction is enabled, but this version does not record an error-redaction count.

## Integrity and validation

The header hash is:

```text
header.hash = SHA256(canonicalJSON(header without hash))
```

For the first interaction, `previousHash` equals `header.hash`. For each later physical line, it equals the preceding interaction's `hash`:

```text
interaction.hash = SHA256(canonicalJSON(interaction without hash))
```

The interaction hash includes `previousHash`. The parser also checks:

- exact format, schema version, and DSH target;
- provider capability field types;
- field types and numeric ranges;
- result minimum shape;
- publication/locality invariants;
- unique sequence and call keys;
- contiguous sequences from 1;
- unique and contiguous occurrences per parent-context/request group;
- every available record hash and chain link.

This catches accidental edits, changed content, middle-record deletion, line reordering, malformed or many partial writes, and structural corruption of the available document.

### What the chain does not prove

There is no secret key, signature, trusted manifest, fixed expected record count, or external tail commitment. Therefore:

- anyone who can edit the file can recompute all hashes;
- removal of a complete valid suffix can remain undetectable when the remaining sequences are contiguous;
- a crash before an interaction is appended leaves no record to detect;
- a hash match says nothing about the truth or safety of recorded model output.

Use source-control commit ids, signed artifacts, or another trusted manifest when provenance or rollback detection matters.

## Write modes

| Mode | Behavior |
|---|---|
| `create` | Opens exclusively and fails if the target exists. This is the safest default for fixtures. |
| `truncate` | Creates or replaces the target with a new header. |
| `append` | Loads and fully validates an existing target, checks compatible header policy, then continues its chain and numbering. A missing target starts a new file. |

Append compatibility checks cassette/upstream names, capabilities, context-inheritance fact, request storage, and redaction policy. The original cassette id and creation time are retained.

All write modes acquire an exclusive `<canonical-cassette-path>.writer.lock` directory before inspecting, creating, or truncating the target. The lock is held until queued writes are synced, the cassette handle is closed, and the lock owner's UUID marker is removed. A concurrent writer fails immediately instead of waiting or risking a forked hash chain.

An abnormal process exit can leave this lock directory behind. The library deliberately does not infer staleness from its recorded PID or age, because PID reuse and suspended processes make automatic deletion unsafe. Remove a leftover lock only after confirming that no writer is still using the cassette. A writer removes only its own UUID marker and never recursively deletes the lock directory or unknown files inside it.

The writer syncs the initialized header and syncs again on close. It does not `fsync` every interaction. An abrupt process or machine failure can leave a missing or partial tail; run `verify` before trusting or replaying a capture.

## Ambiguous groups

An ambiguous group has the same `parentKey`, `parentContextFingerprint`, and `requestFingerprint` more than once, with more than one distinct canonical `outcome`. Timing and request-view differences do not determine ambiguity.

Default replay rejects the entire cassette if any ambiguous group exists. `duplicatePolicy: sequence` consumes that group's interactions in occurrence order. This opt-in resolves selection mechanically; it does not prove that occurrence order is semantically stable.

## Compatibility policy

Format version and DSH target are exact, fail-closed fields. A reader does not silently accept a different target even if its shape appears similar. A future incompatible change should increment `version` and document migration or regeneration rather than weakening validation.
