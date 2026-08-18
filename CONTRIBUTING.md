# Contributing

Contributions are welcome when they preserve the strict, narrow semantics of one-shot Subagent boundary replay.

## Development environment

- Node.js `22.19.x` or `24.x`
- pnpm `>=11.7.0 <12`
- `@deepseek-ai/cordis@4.0.1` and the DSH peer package family at exactly `0.1.0-rc.7`

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs linting, strict TypeScript checking, coverage-gated Vitest, the production build, a distribution smoke test, and `publint`.

During development, the focused commands are:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm test:dist
```

## Change expectations

- Add focused tests for new behavior and regressions.
- Keep request matching fail-closed. Do not add silent fuzzy fallbacks.
- Preserve one-shot ownership: pre-publication cleanup belongs to the provider; a published run belongs to its caller.
- Exercise concurrent sibling cases with reversed completion and replay order when touching topology or matching.
- Test abort and disposal paths when changing provider lifecycle code.
- Keep record-mode teardown durable for already admitted work.
- Avoid logging prompt or result bodies from library and CLI paths.
- Update both README files and focused docs when changing public behavior.

## Persisted-format changes

The JSONL format is a public compatibility surface. Before changing a stored field, canonicalization, hashing, occurrence semantics, or validation:

1. Decide whether existing version-1 cassettes retain exactly the same meaning.
2. Increment the format version for incompatible changes.
3. Add parser rejection and round-trip tests.
4. Document migration or regeneration requirements.
5. Recheck append compatibility and suffix/integrity claims.

Never weaken an exact DSH target check merely because a later package currently looks shape-compatible.

## Security-sensitive changes

Redaction, parsing, path handling, hash validation, and recorded-output delivery are security-sensitive. Include the threat being addressed and the remaining limits in the pull request. Use only synthetic secrets in tests and fixtures.

Do not commit real cassettes unless they contain reviewed synthetic data. `.dsh-cassettes/` should normally remain ignored.

## Pull requests

Keep pull requests scoped and explain:

- the observable problem;
- why the chosen matching or lifecycle semantics are unambiguous;
- test coverage, including relevant concurrency/failure cases;
- compatibility and security impact.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
