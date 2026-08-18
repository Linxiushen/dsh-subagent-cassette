import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    format: 'src/format.ts',
    diff: 'src/diff.ts',
    cli: 'src/cli.ts',
  },
  clean: true,
  dts: true,
  fixedExtension: false,
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/schemastery',
    ],
  },
})
