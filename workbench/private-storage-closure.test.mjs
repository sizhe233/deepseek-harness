import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as tar from 'tar'
import yaml from 'js-yaml'
import { collectPrivateStorageNativeClosure, inspectArchiveEntries, materializePrivateStorageConsumer, privateStorageClosurePlan, verifyArchiveIntegrity, verifyConsumerDependencies } from './private-storage-closure.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const platforms = [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']]

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'private-storage-closure-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function archive(root, manifest, files = {}) {
  const source = mkdtempSync(join(root, 'package-source-'))
  const directory = join(source, 'package')
  mkdirSync(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), value)
  }
  const file = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  const path = join(root, file)
  tar.c({ file: path, cwd: source, gzip: true, sync: true, portable: true }, ['package'])
  const bytes = readFileSync(path)
  return { name: manifest.name, version: manifest.version, file, sha256: hash(bytes), integrity: integrity(bytes), bytes }
}

function nativeFixtures(root, changeEntry = manifest => manifest) {
  const optionalDependencies = Object.fromEntries(platforms.map(([platform, arch]) => [`@koromix/koffi-${platform}-${arch}`, '3.1.1']))
  const entry = archive(root, changeEntry({ name: 'koffi', version: '3.1.1', optionalDependencies,
    scripts: { install: 'node -e "throw new Error(\'INSTALL MUST NEVER EXECUTE\')"' } }), { 'index.cjs': 'module.exports = {}\n' })
  const binaries = platforms.map(([platform, arch]) => archive(root, { name: `@koromix/koffi-${platform}-${arch}`, version: '3.1.1', os: [platform], cpu: [arch] },
    { [`${platform}_${arch}/koffi.node`]: Buffer.from(`synthetic archive bytes for ${platform}/${arch}, not executable`) }))
  const all = [entry, ...binaries]
  writeFileSync(join(root, 'pnpm-lock.yaml'), yaml.dump({ packages: Object.fromEntries(all.map(item => [`${item.name}@${item.version}`, { resolution: { integrity: item.integrity } }])) }))
  return new Map(all.map(item => [item.name, item]))
}

async function closureFixture(root) {
  const fixtures = nativeFixtures(root)
  const destination = join(root, 'candidate')
  const calls = []
  const closure = await collectPrivateStorageNativeClosure(root, destination, { fetchArchive: async pin => {
    calls.push(pin.name)
    return fixtures.get(pin.name).bytes
  } })
  return { fixtures, destination, calls, closure }
}

test('exact lock-bound five-package collection records all native bytes without lifecycle execution', async t => {
  const root = fixtureRoot(t)
  const { closure, calls, destination } = await closureFixture(root)
  assert.equal(calls.length, 5)
  assert.equal(new Set(calls).size, 5)
  assert.equal(closure.lifecycleScriptsExecuted, false)
  assert.equal(closure.archivesRepacked, false)
  assert.equal(closure.packages[0].nativeBinaries.length, 0)
  for (const item of closure.packages.slice(1)) {
    assert.equal(item.nativeBinaries.length, 1)
    assert.match(item.nativeBinaries[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(hash(readFileSync(join(destination, item.file))), item.sha256)
  }
  assert.ok(closure.platformSlices.every(slice => slice.acceptance === 'not-run'))
  assert.equal(closure.excludedArchitectures[0].architecture, 'arm64')
  await assert.rejects(collectPrivateStorageNativeClosure(root, destination, { fetchArchive: async () => { throw new Error('must not fetch twice') } }), /already exists/)
})

test('integrity rejects changed bytes, non-SHA512 declarations and oversize archives', () => {
  const bytes = Buffer.from('synthetic archive')
  verifyArchiveIntegrity(bytes, integrity(bytes))
  assert.throws(() => verifyArchiveIntegrity(Buffer.from('changed'), integrity(bytes)), /differs/)
  assert.throws(() => verifyArchiveIntegrity(bytes, 'sha256-incorrect'), /SHA512/)
  assert.throws(() => verifyArchiveIntegrity(Buffer.alloc(16 * 1024 * 1024 + 1), integrity(bytes)), /byte limit/)
})

test('a missing lock pin and a corrupt fetched archive cannot enter the candidate', async t => {
  const root = fixtureRoot(t)
  nativeFixtures(root)
  const destination = join(root, 'candidate')
  await assert.rejects(collectPrivateStorageNativeClosure(root, destination, { fetchArchive: async () => Buffer.from('corrupt') }), /differs/)
  assert.equal(existsSync(destination), false)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'packages: {}\n')
  assert.throws(() => privateStorageClosurePlan(root), /Missing exact lockfile integrity/)
})

test('unexpected native runtime dependencies require a new pinned closure', async t => {
  const root = fixtureRoot(t)
  const fixtures = nativeFixtures(root, manifest => ({ ...manifest, dependencies: { unexpected: '1.0.0' } }))
  await assert.rejects(collectPrivateStorageNativeClosure(root, join(root, 'candidate'), { fetchArchive: async pin => fixtures.get(pin.name).bytes }), /Unexpected Koffi runtime dependency/)
})

function unsafeArchive(root, entries) {
  const chunks = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = new tar.Header({ path: entry.path, type: entry.type ?? 'File', size: entry.size ?? body.length, mode: 0o644,
      mtime: new Date(0), uid: 0, gid: 0, linkpath: entry.linkpath ?? '' })
    header.encode()
    chunks.push(header.block, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  const path = join(root, 'unsafe.tgz')
  writeFileSync(path, gzipSync(Buffer.concat(chunks)))
  return path
}

for (const path of ['package/../escape', '/package/absolute', 'package/a:stream', 'package/name.', 'package/CON.txt', 'package/naïve', 'other/file']) {
  test(`extractor rejects unsafe archive name ${JSON.stringify(path)}`, t => {
    const root = fixtureRoot(t)
    const file = unsafeArchive(root, [{ path, body: 'x' }])
    assert.throws(() => inspectArchiveEntries(file), /Unsafe|package root|ASCII/)
    assert.equal(existsSync(join(root, 'escape')), false)
  })
}

test('extractor rejects links, case collisions and oversized entries', t => {
  const root = fixtureRoot(t)
  assert.throws(() => inspectArchiveEntries(unsafeArchive(root, [{ path: 'package/link', type: 'SymbolicLink', linkpath: '../outside' }])), /regular files/)
  assert.throws(() => inspectArchiveEntries(unsafeArchive(root, [{ path: 'package/A', body: 'a' }, { path: 'package/a', body: 'b' }])), /case-colliding/)
  assert.throws(() => inspectArchiveEntries(unsafeArchive(root, [{ path: 'package/large', size: 64 * 1024 * 1024 + 1 }])), /size limit/)
})

test('materializer requires the complete declared peer graph and leaves scripts unexecuted', async t => {
  const root = fixtureRoot(t)
  const { destination, closure } = await closureFixture(root)
  const storage = archive(destination, { name: '@deepseek-ai/dsh-private-storage', version: '0.2.1-alpha.1', type: 'module', dependencies: { koffi: '3.1.1' },
    peerDependencies: { '@deepseek-ai/cordis': '~4.0.5-alpha.1' }, scripts: { install: 'node fail-if-executed.js' } }, { 'lib/index.js': 'export const syntheticFixture = true\n' })
  const cordis = archive(destination, { name: '@deepseek-ai/cordis', version: '4.0.5-alpha.1', dependencies: { '@deepseek-ai/cosmokit': '~1.8.6-alpha.1' } })
  const cosmokit = archive(destination, { name: '@deepseek-ai/cosmokit', version: '1.8.6-alpha.1' })
  const options = { artifactDirectory: destination, storagePackage: storage, closure, platform: 'linux', architecture: 'x64' }
  assert.throws(() => materializePrivateStorageConsumer({ ...options, destination: join(root, 'missing-peer') }), /Missing required peer/)
  assert.throws(() => materializePrivateStorageConsumer({ ...options, destination: join(root, 'missing-transitive'), additionalPackages: [cordis] }), /Missing declared dependency/)
  const consumer = materializePrivateStorageConsumer({ ...options, destination: join(root, 'complete-consumer'), additionalPackages: [cordis, cosmokit] })
  assert.equal(consumer.lifecycleScriptsExecuted, false)
  assert.equal(consumer.networkUsedForMaterialization, false)
  assert.equal(consumer.checkoutDependencyLinks, false)
  assert.equal(consumer.packages.length, 5)
  assert.ok(existsSync(consumer.entry))
  assert.equal(readdirSync(join(consumer.root, 'node_modules', '@koromix')).length, 1)
  assert.throws(() => materializePrivateStorageConsumer({ ...options, destination: join(root, 'unlisted-architecture'), platform: 'win32', architecture: 'arm64' }), /absent/)
})

test('dependency verification refuses missing peers and version substitutions', () => {
  assert.throws(() => verifyConsumerDependencies([{ name: 'consumer', dependencies: { library: '^2.0.0' } }, { name: 'library', version: '1.0.0' }]), /version mismatch/)
  assert.throws(() => verifyConsumerDependencies([{ name: 'consumer', peerDependencies: { library: '^2.0.0' } }]), /Missing required peer/)
  verifyConsumerDependencies([{ name: 'consumer', peerDependencies: { library: '^2.0.0' }, peerDependenciesMeta: { library: { optional: true } } }])
  assert.throws(() => verifyConsumerDependencies([{ name: 'consumer', optionalDependencies: { library: '2.0.0' } }, { name: 'library', version: '1.0.0' }]), /Optional dependency version mismatch/)
})

test('candidate archive substitution and native inventory tampering are rejected', async t => {
  const root = fixtureRoot(t)
  const { destination, closure } = await closureFixture(root)
  const storage = archive(destination, { name: '@deepseek-ai/dsh-private-storage', version: '0.2.1-alpha.1', dependencies: { koffi: '3.1.1' } }, { 'lib/index.js': 'export {}\n' })
  const options = { artifactDirectory: destination, storagePackage: storage, closure, platform: 'linux', architecture: 'x64' }
  const tampered = structuredClone(closure)
  tampered.packages.find(item => item.name === '@koromix/koffi-linux-x64').nativeBinaries[0].sha256 = '0'.repeat(64)
  assert.throws(() => materializePrivateStorageConsumer({ ...options, closure: tampered, destination: join(root, 'tampered-inventory') }), /inventory differs/)
  writeFileSync(join(destination, storage.file), 'substituted')
  assert.throws(() => materializePrivateStorageConsumer({ ...options, destination: join(root, 'tampered-archive') }), /hash mismatch/)
})
