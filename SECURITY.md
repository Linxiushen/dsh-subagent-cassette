# Security policy

## Supported versions

Until a stable release, fixes are made on the latest `0.1.x` source release only.

| Project line | DSH target | Security support |
|---|---|---|
| `0.1.x` | `0.1.0-rc.7` | Current |
| other versions | any | Unsupported |

The exact DSH target is part of the cassette header and parser validation. Forcing a different peer-dependency version is outside the supported configuration.

## Reporting

Report suspected vulnerabilities through the repository's private GitHub Security Advisory flow. Do not open a public issue until the report has been triaged and disclosure coordinated.

Include the affected project version, exact DSH versions, a secret-free configuration, impact, and a minimal synthetic reproducer where possible. Do not upload real cassette files, credentials, private prompts, or model outputs.

For non-sensitive correctness issues, use the public issue tracker.

## Artifact warning

A cassette can contain request fingerprints, metadata, complete result data, and error messages. Built-in redaction is defense in depth, not a guarantee that all secrets are removed. Treat cassette files as sensitive artifacts, review them before sharing, and use appropriate filesystem and repository permissions.

The SHA-256 record chain detects many accidental modifications to the available file. It is unkeyed: it does not authenticate the producer, prevent recomputation, or prove that a complete valid suffix was not removed. See [`docs/security.md`](docs/security.md) for the full threat model and operational guidance.
