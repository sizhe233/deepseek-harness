import { runPackedPosixStorage } from './private-storage-posix-native.mjs'
/** Test-only artifact consumer. It imports no repository modules after the once-built toolkit is bundled. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializePrivateStorageConsumer, smokePrivateStorageConsumer } from './private-storage-closure.mjs'
import { runPackedNativeSuite } from './private-storage-native-suite.mjs'

import { validatePrivateStorageClaim } from './private-storage-applicability.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Verify fixed source identity and every published archive before any consumer is materialized. */
export function verifyPackedCandidate(directory, { commit, manifestSha256, repository }) {
  assert.match(commit, /^[0-9a-f]{40}$/)
  assert.match(manifestSha256, /^[0-9a-f]{64}$/)
  const root = realpathSync(directory)
  assert.equal(basename(root), commit, 'Candidate directory must identify its source')
  const raw = readFileSync(join(root, 'candidate.json'))
  assert.equal(sha256(raw), manifestSha256, 'Candidate manifest differs from locator digest')
  const candidate = JSON.parse(raw)
  assert.equal(candidate.commit, commit)
  assert.equal(candidate.source?.commit, commit)
  assert.equal(candidate.source?.repository, repository)
  assert.match(candidate.source?.tree ?? '', /^[0-9a-f]{40}$/)
  assert.equal(candidate.build?.platform, 'linux', 'All platforms must consume the Linux-built archives')
  assert.equal(candidate.productionApproved, false)
  assert.ok(Array.isArray(candidate.packages) && candidate.packages.length > 0)
  const descriptor = candidate.privateStorageAcceptance
  assert.equal(descriptor?.schemaVersion, 1)
  validatePrivateStorageClaim(descriptor.claim)
  assert.equal(descriptor.sourcePackage?.name, '@deepseek-ai/dsh-private-storage')
  const names = new Set(), files = new Map()
  for (const item of candidate.packages) {
    assert.ok(!names.has(item.name), 'Duplicate candidate package identity')
    names.add(item.name)
    assert.ok(!files.has(item.file), 'Duplicate candidate archive path')
    files.set(item.file, item.sha256)
  }
  assert.deepEqual(candidate.packages.find(item => item.name === descriptor.sourcePackage.name), descriptor.sourcePackage)
  for (const peer of descriptor.peerPackages) assert.deepEqual(candidate.packages.find(item => item.name === peer.name), peer)
  if (descriptor.candidateNative !== undefined) {
    const native = descriptor.candidateNative
    assert.equal(native.schemaVersion, 2); assert.equal(native.kind, 'candidate-native-packages-v1')
    assert.deepEqual(native.source, { repository, commit, tree: candidate.source.tree })
    assert.deepEqual(native, candidate.externalNativeDependencies, 'Packed storage native selection differs from the Host')
    assert.deepEqual(native.platformPackages.map(row => row.platform).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
    for (const item of [native.package, ...native.platformPackages]) {
      const row = candidate.packages.find(row => row.name === item.name)
      assert.ok(row, 'Native archive is absent from the Host package set')
      for (const key of ['name', 'version', 'file', 'bytes', 'sha256']) assert.equal(row[key], item[key], 'Native archive identity differs')
    }
  }
  for (const item of [...candidate.packages, ...descriptor.nativeClosure.packages, ...descriptor.ordinaryDependencies]) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/)
    // oxlint-disable-next-line no-control-regex -- Artifact paths must reject control bytes before filesystem access.
    assert.ok(typeof item.file === 'string' && !isAbsolute(item.file) && !/[\\:\u0000-\u001f]/u.test(item.file))
    assert.ok(!item.file.split('/').some(part => !part || part === '.' || part === '..'))
    if (files.has(item.file)) assert.equal(files.get(item.file), item.sha256, 'Conflicting archive identity')
    files.set(item.file, item.sha256)
    const file = join(root, item.file)
    assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink())
    assert.ok(realpathSync(file).startsWith(root + sep))
    const bytes = readFileSync(file)
    assert.equal(bytes.length, item.bytes)
    assert.equal(sha256(bytes), item.sha256, `Archive bytes differ: ${item.name}`)
  }
  return { root, candidate, descriptor }
}

/** Run the immutable generic consumer and native suite, keeping every failed or blocked outcome visible. */
export async function runPackedPrivateStorage(directory, evidenceDirectory) {
  const evidence = resolve(evidenceDirectory)
  mkdirSync(evidence, { recursive: true })
  let stage = 'source-and-archive-verification'
  let report = { complete: false, platform: process.platform, architecture: process.arch, node: process.version,
    candidateCommit: process.env.CANDIDATE_SHA, artifactId: process.env.CANDIDATE_ARTIFACT_ID,
    artifactDigest: process.env.CANDIDATE_ARTIFACT_DIGEST, manifestSha256: process.env.EXPECTED_MANIFEST_SHA256,
    physicalSourceIsolation: false, lifecycleScriptsExecuted: false }
  try {
    assert.equal(existsSync(join(process.cwd(), '.git')), false, 'Artifact-only acceptance cannot run in a checkout')
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Final artifact-only acceptance requires the declared fresh CI job')
    const { root, candidate, descriptor } = verifyPackedCandidate(directory, {
      commit: process.env.CANDIDATE_SHA,
      manifestSha256: process.env.EXPECTED_MANIFEST_SHA256,
      repository: process.env.CANDIDATE_REPOSITORY,
    })
    report = { ...report, source: candidate.source, physicalSourceIsolation: true,
      sourceIsolationBasis: 'Fresh hosted job without checkout; toolkit and runtime come only from the verified candidate artifact' }
    stage = 'offline-materialization'
    const consumer = materializePrivateStorageConsumer({
      artifactDirectory: root, storagePackage: descriptor.sourcePackage, closure: descriptor.nativeClosure,
      destination: join(evidence, 'consumer'), additionalPackages: [...descriptor.peerPackages, ...descriptor.ordinaryDependencies,
        ...descriptor.candidateNative === undefined ? [] : [descriptor.candidateNative.package,
          ...descriptor.candidateNative.platformPackages.filter(row => row.platform === `${process.platform}-${process.arch}`)]],
    })
    stage = 'packed-import-and-native-payload'
    const smoke = smokePrivateStorageConsumer(consumer)
    report = { ...report, consumer: { ...consumer, root: undefined }, smoke }
    writeFileSync(join(evidence, 'packed-import.json'), `${JSON.stringify(smoke, null, 2)}\n`, { flag: 'wx' })
    if (process.platform === 'win32') {
      assert.equal(process.arch, 'x64', 'Untested Windows architecture')
      const toolkit = join(root, descriptor.toolkit.directory)
      const fixtures = join(toolkit, 'packages/storage/private-storage/tests/native')
      const oracleDirectory = join(evidence, 'oracle')
      stage = 'native-preflights-and-adversarial-matrices'
      const native = await runPackedNativeSuite({ toolkit, fixtures, oracleDirectory, evidence, entry: consumer.entry,
        productionBinarySha256: smoke.candidateNative?.platformPackage.sha256,
        consumerRoot: consumer.root, candidateArchive: join(root, descriptor.sourcePackage.file), manifest: join(root, 'candidate.json'),
        sourceSha: candidate.commit, claim: descriptor.claim, abi: join(root, descriptor.toolkit.abi) })
      report = { ...report, nativeConformance: { status: native.complete ? 'passed-declared-profile' : native.acceptance,
        claim: descriptor.claim, expandedComplete: native.expandedComplete,
        report: 'windows-native-suite.json', composite: 'windows-composite.json' } }
      assert.equal(native.complete, true, 'Required native preflights or adversarial subcases failed or remain incomplete')
    } else {
      assert.ok(descriptor.candidateNative, 'POSIX native conformance requires exact candidate-built payloads')
      const native = runPackedPosixStorage({ toolkit: join(root, descriptor.toolkit.directory), consumer, candidateNative: descriptor.candidateNative, evidence: join(evidence, 'posix-native') })
      report = { ...report, nativeConformance: { status: native.status, report: 'posix-native/posix-native.json', passed: native.core.passed, skipped: native.core.skipped } }
    }
    stage = 'complete'
    report = { ...report, complete: true }
    return report
  } catch (error) {
    report = { ...report, error: error instanceof Error ? error.message : 'Unknown acceptance failure' }
    throw error
  } finally {
    writeFileSync(join(evidence, 'acceptance.json'), `${JSON.stringify({ ...report, stage }, null, 2)}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, evidence] = process.argv.slice(2)
  assert.ok(directory && evidence, 'Usage: node private-storage-packed.mjs CANDIDATE_DIRECTORY EVIDENCE_DIRECTORY')
  await runPackedPrivateStorage(directory, evidence)
}
