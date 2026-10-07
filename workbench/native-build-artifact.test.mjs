/** Synthetic source/artifact identity tests; fixtures are not executable native binaries. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assembleNativeBuildArtifacts, prepareNativeBuildArtifact } from './native-build-artifact.mjs'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-build-artifact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), scripts = join(repo, 'native/system/scripts'), platform = `${process.platform}-${process.arch}`
  const pkg = join(repo, 'native/system/packages', platform)
  mkdirSync(scripts, { recursive: true }); mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'native/system/packages/*/bin/\n')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@fixture/native-${platform}`, version: '0.1.3' }))
  writeFileSync(join(pkg, 'prebuilds.json'), JSON.stringify({ platform, binaries: [{ path: 'bin/synthetic.node', kind: 'node-api' }] }))
  writeFileSync(join(pkg, 'bin/synthetic.node'), 'synthetic non-executable test payload')
  writeFileSync(join(scripts, 'repo.mjs'), 'export function verifyPlatformBinaries() { return { synthetic: true } }\n')
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic native artifact fixture')
  const previousSha = process.env.CANDIDATE_SHA
  process.env.CANDIDATE_SHA = git('rev-parse', 'HEAD')
  t.after(() => { if (previousSha === undefined) delete process.env.CANDIDATE_SHA; else process.env.CANDIDATE_SHA = previousSha })
  const output = join(root, 'output'), downloads = join(root, 'downloads')
  mkdirSync(downloads)
  const input = join(downloads, `candidate-native-${platform}`)
  return { root, repo, pkg, platform, output, downloads, input, git }
}
async function prepared(t) { const f = fixture(t); const descriptor = await prepareNativeBuildArtifact(f.repo, f.output); cpSync(f.output, f.input, { recursive: true }); return { ...f, descriptor } }
function change(f, mutate) { const path = join(f.input, 'native-build.json'), value = JSON.parse(readFileSync(path)); mutate(value); writeFileSync(path, JSON.stringify(value)) }
test('assembles one exact source-bound complete platform payload', async t => {
  const f = await prepared(t)
  assert.equal(f.descriptor.source.commit, f.git('rev-parse', 'HEAD'))
  assert.equal(f.descriptor.source.tree, f.git('rev-parse', 'HEAD^{tree}'))
  writeFileSync(join(f.pkg, 'bin/synthetic.node'), 'earlier disposable build output')
  const result = await assembleNativeBuildArtifacts(f.repo, f.downloads)
  assert.deepEqual(result.platforms, [f.platform]); assert.equal(result.binaries, 1)
  assert.equal(readFileSync(join(f.pkg, 'bin/synthetic.node'), 'utf8'), 'synthetic non-executable test payload')
})
for (const [name, mutate] of [
  ['another source commit', value => { value.source.commit = '0'.repeat(40) }],
  ['another source tree', value => { value.source.tree = '0'.repeat(40) }],
  ['another package version', value => { value.version = '0.1.2' }],
  ['another platform', value => { value.platform = 'foreign' }],
  ['altered metadata', value => { value.prebuildsSha256 = '0'.repeat(64) }],
  ['altered bytes', value => { value.binaries[0].sha256 = '0'.repeat(64) }],
  ['incomplete inventory', value => { value.binaries = [] }],
  ['duplicate inventory', value => { value.binaries.push(value.binaries[0]) }],
  ['changed executable semantics', value => { value.binaries[0].executable = true }],
]) test(`refuses ${name} before copying payloads`, async t => {
  const f = await prepared(t); change(f, mutate)
  writeFileSync(join(f.pkg, 'bin/synthetic.node'), 'prior build retained')
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads))
  assert.equal(readFileSync(join(f.pkg, 'bin/synthetic.node'), 'utf8'), 'prior build retained')
})
test('refuses dirty native source and reusing artifact output', async t => {
  const f = await prepared(t)
  await assert.rejects(prepareNativeBuildArtifact(f.repo, f.output), /already exists/)
  writeFileSync(join(f.pkg, 'package.json'), '{}')
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads), /source must match/)
})
test('refuses missing or extra platforms and undeclared payloads', async t => {
  const f = await prepared(t)
  mkdirSync(join(f.downloads, 'foreign'))
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads), /Complete native platform/)
  rmSync(join(f.downloads, 'foreign'), { recursive: true })
  writeFileSync(join(f.input, 'extra'), 'undeclared')
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads), /undeclared files/)
})
test('refuses symlinked native artifact bytes', { skip: process.platform === 'win32' }, async t => {
  const f = await prepared(t), target = join(f.input, 'bin/synthetic.node')
  rmSync(target); symlinkSync(join(f.pkg, 'bin/synthetic.node'), target)
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads), /link/)
})

test('refuses missing platform artifacts and a workflow/source mismatch', async t => {
  const f = fixture(t)
  await assert.rejects(assembleNativeBuildArtifacts(f.repo, f.downloads), /Complete native platform/)
  process.env.CANDIDATE_SHA = '0'.repeat(40)
  await assert.rejects(prepareNativeBuildArtifact(f.repo, f.output), /another workflow source/)
})
