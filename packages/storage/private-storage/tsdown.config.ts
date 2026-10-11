import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/streams.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  deps: { neverBundle: ['@deepseek-ai/dsh-private-storage'] },
})
