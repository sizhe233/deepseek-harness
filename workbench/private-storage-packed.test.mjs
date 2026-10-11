/** Artifact identity and failure-report tests; none claim Windows-native acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackedCandidate } from './private-storage-packed.mjs'

import { PRIVATE_STORAGE_CLAIM } from './private-storage-applicability.mjs'

const commit = 'a'.repeat(40)
const repository = 'synthetic/public-host'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'private-storage-packed-test-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, commit)
  mkdirSync(root)
  const archive = (name, file) => {
    const bytes = Buffer.from(`synthetic non-executable archive: ${name}`)
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), bytes)
    return { name, version: '1.0.0', file, bytes: bytes.length, sha256: hash(bytes) }
  }
  const storage = archive('@deepseek-ai/dsh-private-storage', 'storage.tgz')
  const peer = archive('@deepseek-ai/cordis', 'cordis.tgz')
  const native = archive('koffi', 'private-storage-native/koffi.tgz')
  const ordinary = archive('@standard-schema/spec', 'support.tgz')
  const candidate = { commit, source: { commit, tree: 'b'.repeat(40), repository }, build: { platform: 'linux' },
    productionApproved: false, packages: [storage, peer], privateStorageAcceptance: {
      schemaVersion: 1, claim: PRIVATE_STORAGE_CLAIM, sourcePackage: storage, peerPackages: [peer], nativeClosure: { packages: [native] }, ordinaryDependencies: [ordinary],
    } }
  const seal = () => {
    const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`)
    writeFileSync(join(root, 'candidate.json'), bytes)
    return { commit, repository, manifestSha256: hash(bytes) }
  }
  return { scratch, root, candidate, seal }
}

test('verifies one fixed source and every ordinary and native archive without executing it', t => {
  const f = fixture(t)
  const result = verifyPackedCandidate(f.root, f.seal())
  assert.equal(result.root, f.root)
  assert.deepEqual(result.candidate, f.candidate)
})

test('requires externally supplied manifest digest and source directory identity', t => {
  const f = fixture(t)
  const options = f.seal()
  assert.throws(() => verifyPackedCandidate(f.root, { ...options, manifestSha256: '0'.repeat(64) }), /locator digest/)
  assert.throws(() => verifyPackedCandidate(f.root, { ...options, commit: 'c'.repeat(40) }), /directory must identify/)
  assert.throws(() => verifyPackedCandidate(f.root, { ...options, repository: 'different/repository' }))
})

for (const [name, change] of [
  ['commit', c => { c.commit = 'c'.repeat(40) }],
  ['source commit', c => { c.source.commit = 'c'.repeat(40) }],
  ['tree', c => { c.source.tree = 'not-a-tree' }],
  ['builder platform', c => { c.build.platform = 'win32' }],
  ['production approval', c => { c.productionApproved = true }],
  ['missing claim', c => { delete c.privateStorageAcceptance.claim }],
  ['undeclared claim exclusions', c => { c.privateStorageAcceptance.claim = { ...PRIVATE_STORAGE_CLAIM, exclude: ['mandatory-row'] } }],
  ['unknown claim condition', c => { c.privateStorageAcceptance.claim = { ...PRIVATE_STORAGE_CLAIM, requiredConditions: ['primary/token-classification'] } }],
  ['descriptor schema', c => { c.privateStorageAcceptance.schemaVersion = 2 }],
  ['storage selection', c => { c.privateStorageAcceptance.sourcePackage = { ...c.packages[0], version: '2.0.0' } }],
  ['peer selection', c => { c.privateStorageAcceptance.peerPackages = [{ ...c.packages[1], version: '2.0.0' }] }],
  ['duplicate package', c => { c.packages.push({ ...c.packages[0], file: 'other.tgz' }) }],
  ['duplicate archive', c => { c.packages.push({ ...c.packages[0], name: 'other-package' }) }],
]) {
  test(`rejects inconsistent ${name} even when the manifest hash matches`, t => {
    const f = fixture(t); change(f.candidate)
    assert.throws(() => verifyPackedCandidate(f.root, f.seal()))
  })
}

for (const path of ['../outside.tgz', '/absolute.tgz', 'C:/drive.tgz', 'private-storage-native/../escape.tgz', 'bad\\name.tgz', 'bad\0name.tgz']) {
  test(`rejects unsafe archive path ${JSON.stringify(path)}`, t => {
    const f = fixture(t)
    f.candidate.privateStorageAcceptance.nativeClosure.packages[0].file = path
    assert.throws(() => verifyPackedCandidate(f.root, f.seal()))
  })
}

for (const selection of ['packages', 'ordinaryDependencies', 'nativeClosure']) {
  test(`verifies ${selection} byte length and digest before extraction`, t => {
    const f = fixture(t)
    const record = selection === 'packages' ? f.candidate.packages[0]
      : selection === 'ordinaryDependencies' ? f.candidate.privateStorageAcceptance.ordinaryDependencies[0]
        : f.candidate.privateStorageAcceptance.nativeClosure.packages[0]
    const options = f.seal()
    writeFileSync(join(f.root, record.file), Buffer.alloc(record.bytes, 42))
    assert.throws(() => verifyPackedCandidate(f.root, options), /Archive bytes differ/)
    writeFileSync(join(f.root, record.file), 'short')
    assert.throws(() => verifyPackedCandidate(f.root, options))
  })
}

test('rejects symlinked archives and directories escaping the artifact root', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const options = f.seal()
  const record = f.candidate.packages[0]
  const target = join(f.scratch, 'outside.tgz')
  writeFileSync(target, readFileSync(join(f.root, record.file)))
  rmSync(join(f.root, record.file))
  symlinkSync(target, join(f.root, record.file))
  assert.throws(() => verifyPackedCandidate(f.root, options))
  const native = f.candidate.privateStorageAcceptance.nativeClosure.packages[0]
  const outside = join(f.scratch, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'koffi.tgz'), readFileSync(join(f.root, native.file)))
  rmSync(join(f.root, 'private-storage-native'), { recursive: true })
  symlinkSync(outside, join(f.root, 'private-storage-native'))
  rmSync(join(f.root, record.file)); writeFileSync(join(f.root, record.file), readFileSync(target))
  assert.throws(() => verifyPackedCandidate(f.root, options))
})

test('local execution reports its exact blocked stage and never claims source isolation', t => {
  const f = fixture(t)
  f.seal()
  const evidence = join(f.scratch, 'evidence')
  const script = fileURLToPath(new URL('./private-storage-packed.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [script, f.root, evidence], {
    cwd: f.scratch, env: { ...process.env, GITHUB_ACTIONS: 'false', NODE_OPTIONS: '', NODE_PATH: '' },
    encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.notEqual(child.status, 0)
  const report = JSON.parse(readFileSync(join(evidence, 'acceptance.json'), 'utf8'))
  assert.equal(report.complete, false)
  assert.equal(report.physicalSourceIsolation, false)
  assert.equal(report.stage, 'source-and-archive-verification')
  assert.match(report.error, /fresh CI job/)
})
