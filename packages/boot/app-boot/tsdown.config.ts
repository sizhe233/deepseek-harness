import { defineConfig } from 'tsdown'

/**
 * Embed Include while keeping Loader external so the built include tree and
 * app host bind to one Loader peer.
 */
export default defineConfig([
  {
    entry: ['lib/types/runtime-admission.js'], outDir: 'lib', format: ['esm'],
    platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  },
  {
    entry: { 'profile-documents': 'lib/types/profile-document-view.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/runtime-version.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: ['@deepseek-ai/cordis-plugin-include'],
    },
  },
  {
    entry: { 'worker/profile-resolution-bootstrap': 'lib/types/profile-resolution/worker-bootstrap.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: ['resolve.exports'],
    },
  },
])
