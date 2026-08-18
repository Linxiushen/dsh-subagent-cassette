# Examples

These examples assume the package has been built and added to a DeepSeek Harness `0.1.0-rc.7` deployment. They register a provider named `cassette` beside the deployment's existing providers.

## Bundle patches

- [`record.patch.yml`](record.patch.yml) records one scenario through the existing `spawn` provider.
- [`replay.patch.yml`](replay.patch.yml) serves the same scenario from a fixed cassette file.

The package ships a default [`../cordis.patch.yml`](../cordis.patch.yml) through its `dsh.bundle.patch` metadata. The record and replay files here are explicit variants for deployments that manage their Cordis bundle layers directly.

After applying the record patch, make sure the one-shot descriptor or caller selects provider `cassette`. The real `spawn` provider remains registered; selecting it directly bypasses recording.

Run the scenario to completion and shut the plugin down normally. Then validate the artifact:

```bash
pnpm exec dsh-cassette verify .dsh-cassettes/repository-audit.cassette.jsonl
pnpm exec dsh-cassette inspect .dsh-cassettes/repository-audit.cassette.jsonl --show-calls
```

Replace the record patch with the replay patch and run the same request-producing scenario. Replay parent context and request fields must match exactly. The default consumption assertion fails teardown if the scenario makes fewer matching calls than the file contains.

## Programmatic installation

[`programmatic.ts`](programmatic.ts) provides small wrappers around `installCassette()`. The supplied `Context` must already have `@deepseek-ai/dsh-subagent` mounted; record mode also requires the named upstream provider to be registered.

The returned handle owns the provider registration and cassette resource. Always dispose it:

```ts
const cassette = await installRecording(ctx, '.dsh-cassettes/test.cassette.jsonl')
try {
  await runScenarioUsingProvider(cassette.providerName)
} finally {
  await cassette.dispose()
}
```

In replay mode, disposal also performs the configured `assertConsumed` check and can reject. Let that rejection fail the test.

## Fixture hygiene

- Prefer synthetic prompts and outputs for committed fixtures.
- Keep metadata-only request storage unless prompt bodies are required.
- Review `redactedResults` in `inspect` output before enabling substituted replay.
- Use one file per logical top-level root.
- Do not use `duplicatePolicy: sequence` unless identical requests are intentionally ordered and that order is stable.
