import { defineConfig } from 'tsdown'

/** Separate business entries prevent application imports from entering the installed wrappers. */
export default defineConfig({
  entry: ['index', 'cli', 'cli-main', 'host-main'].map(name => 'lib/types/' + name + '.js'),
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
