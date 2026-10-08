import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { collectDependencyPatches, installedPatchedPackage, patchTargets } from './dependency-patches.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-recipe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const selector = '@example/tool@1.2.3'
  const patch = 'diff --git a/lib/index.js b/lib/index.js\n--- a/lib/index.js\n+++ b/lib/index.js\n@@ -1 +1 @@\n-original\n+patched\n'
  const relative = 'patches/tool.patch'
  mkdirSync(join(root, 'patches'))
  writeFileSync(join(root, relative), patch)
  const lock = { patchedDependencies: { [selector]: sha(patch) }, packages: { [selector]: { resolution: { integrity: 'sha512-' + 'A'.repeat(86) + '==' } } } }
  writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml.dump({ patchedDependencies: { [selector]: relative } }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), yaml.dump(lock))
  const directory = join(root, 'node_modules/.pnpm/@example+tool@1.2.3_patch_hash=' + sha(patch), 'node_modules/@example/tool')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@example/tool', version: '1.2.3' }))
  writeFileSync(join(directory, 'lib/index.js'), 'patched\n')
  return { root, selector, patch, lock, directory, usage: { [selector]: 'runtime' }, destination: join(root, 'artifacts') }
}

test('portable recipes bind original integrity, exact patch, installed target and copied bytes', t => {
  const f = fixture(t)
  const [record] = collectDependencyPatches(f.root, f.destination, f.usage)
  assert.deepEqual(record, {
    selector: f.selector, name: '@example/tool', version: '1.2.3',
    sourceIntegrity: f.lock.packages[f.selector].resolution.integrity,
    patchFile: 'dependency-patches/tool.patch', patchSha256: sha(f.patch), patchBytes: Buffer.byteLength(f.patch), usage: 'runtime',
    files: [{ path: 'lib/index.js', sha256: sha('patched\n') }],
  })
  assert.equal(readFileSync(join(f.destination, record.patchFile), 'utf8'), f.patch)
})

test('recipe export refuses a stale patch lock and pristine installed payload', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'patches/tool.patch'), f.patch + '\n')
  assert.throws(() => collectDependencyPatches(f.root, f.destination, f.usage), /differs from the frozen lockfile/)
  writeFileSync(join(f.root, 'patches/tool.patch'), f.patch)
  writeFileSync(join(f.directory, 'lib/index.js'), 'original\n')
  assert.throws(() => collectDependencyPatches(f.root, f.destination, f.usage), /Command failed/)
})

test('recipe export refuses inventory, unreviewed usage and original integrity gaps', t => {
  const f = fixture(t)
  assert.throws(() => collectDependencyPatches(f.root, f.destination, {}), /patch use must be reviewed/)
  delete f.lock.packages[f.selector].resolution.integrity
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), yaml.dump(f.lock))
  assert.throws(() => collectDependencyPatches(f.root, f.destination, f.usage), /integrity|argument/)
  f.lock.patchedDependencies = {}
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), yaml.dump(f.lock))
  assert.throws(() => collectDependencyPatches(f.root, f.destination, f.usage), /inventories differ/)
})

test('installed patch selection rejects missing, wrong-version and ambiguous payloads', t => {
  const f = fixture(t)
  assert.throws(() => installedPatchedPackage(f.root, '@example/missing', '1.2.3'), /expected one/)
  writeFileSync(join(f.directory, 'package.json'), JSON.stringify({ name: '@example/tool', version: '1.2.4' }))
  assert.throws(() => installedPatchedPackage(f.root, '@example/tool', '1.2.3'), /version mismatch/)
  cpSync(f.directory, join(f.root, 'node_modules/.pnpm/@example+tool@1.2.3_patch_hash=other/node_modules/@example/tool'), { recursive: true })
  assert.throws(() => installedPatchedPackage(f.root, '@example/tool', '1.2.3'), /expected one/)
})

test('patch targets reject traversal, deletion, ambiguity and empty recipes', () => {
  for (const path of ['../escape', '/absolute', 'lib/../escape', 'lib\\escape', './lib.js', 'C:/escape', 'lib/has space.js', 'lib/a\0.js']) {
    assert.throws(() => patchTargets(`+++ b/${path}\n`), /unsafe/)
  }
  assert.throws(() => patchTargets('+++ /dev/null\n'), /regular target/)
  assert.throws(() => patchTargets('+++ b/a.js\n+++ b/a.js\n'), /duplicate/)
  assert.throws(() => patchTargets(''), /no target/)
})

test('every frozen source patch has an exact portable recipe and installed post-state', t => {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-real-dependency-recipes-'))
  t.after(() => rmSync(destination, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../', import.meta.url))
  const recipes = collectDependencyPatches(root, destination)
  assert.equal(recipes.length, 7)
  assert.deepEqual(recipes.filter(row => row.usage === 'runtime').map(row => row.name).sort(), ['@earendil-works/pi-ai', 'node-pty'])
  assert.equal(recipes.find(row => row.name === '@earendil-works/pi-ai').files.length, 7)
  assert.equal(recipes.filter(row => row.usage === 'bundled').length, 3)
  assert.equal(recipes.filter(row => row.usage === 'build-only').length, 2)
})


test('recipe verification refuses linked targets outside the dependency payload', t => {
  const f = fixture(t)
  const target = join(f.directory, 'lib/index.js')
  rmSync(target)
  writeFileSync(join(f.root, 'unrelated.txt'), 'patched\n')
  symlinkSync(join(f.root, 'unrelated.txt'), target)
  assert.throws(() => collectDependencyPatches(f.root, f.destination, f.usage), /regular package file/)
})
