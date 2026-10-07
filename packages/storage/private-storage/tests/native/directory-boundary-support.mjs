/** Test-only inventory and validation for packed native directory/cleanup observations. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, fileDigest, summary } from './boundary-support.mjs'

export const queryBudget = 64
export const cases = Object.freeze([
  'directory-enumeration-baseline',
  ...['truncated-header', 'overlong-buffer', 'odd-name-length', 'zero-name-length', 'name-overruns-page',
    'next-record-truncated', 'next-offset-overlap', 'next-offset-unaligned', 'next-offset-overlong',
    'native-failure', 'warning-return', 'pending-settled', 'pending-unsettled', 'pending-wait-error',
    'entry-ceiling', 'total-query-ceiling'].map(name => `directory-enumeration-${name}`),
  ...['token-close', 'file-close', 'directory-close', 'unlock', 'local-free', 'staging-close',
    'staging-disposition'].map(name => `cleanup-real-${name}-return-failure`),
])
export const blockedCases = Object.freeze([
  { name: 'cleanup-genuine-kernel-release-failure', reason: 'No safe deterministic OS fixture makes release of an owned live handle or descriptor fail. Invalid, already-freed or reused resources are never passed to native cleanup.' },
  { name: 'cleanup-koffi-free-failure', reason: 'Koffi free has no failure return. Throwing around a real free cannot establish allocator failure; retaining or re-freeing an uncertain pointer is not used as evidence.' },
])
export const sourceFiles = Object.freeze(['directory-boundary-matrix.mjs', 'directory-boundary-worker.mjs',
  'directory-boundary-support.mjs', 'boundary-support.mjs', 'windows-oracle.c'])

/** Hash the actual fixture inputs; the candidate commit is bound separately by the artifact runner. */
export function sourceBinding() {
  const files = Object.fromEntries(sourceFiles.map(name => [name, fileDigest(fileURLToPath(new URL(name, import.meta.url)))]))
  return { files, sha256: digest(JSON.stringify(files)) }
}

/** Require the installed offline consumer, matching native payload and exact package version. */
export function installedBinding(entry) {
  const actual = realpathSync(entry)
  const packageRoot = dirname(dirname(actual))
  assert.equal(basename(actual), 'index.js')
  assert.equal(basename(dirname(actual)), 'lib', 'Only the public built package entry may be imported')
  const consumer = dirname(dirname(dirname(packageRoot)))
  assert.equal(actual, realpathSync(join(consumer, 'node_modules', '@deepseek-ai', 'dsh-private-storage', 'lib', 'index.js')))
  const inventoryPath = join(consumer, 'consumer-inventory.json')
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  assert.equal(realpathSync(inventory.root), realpathSync(consumer))
  assert.equal(realpathSync(inventory.entry), actual)
  assert.equal(inventory.platform, 'win32')
  assert.equal(inventory.architecture, 'x64')
  assert.equal(inventory.checkoutDependencyLinks, false)
  assert.equal(inventory.lifecycleScriptsExecuted, false)
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh-private-storage')
  assert.equal(manifest.dependencies.koffi, '3.1.1')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  const require = createRequire(actual)
  assert.equal(realpathSync(require.resolve('@deepseek-ai/dsh-private-storage')), actual)
  const storageRecords = inventory.packages.filter(item => item.name === manifest.name)
  assert.equal(storageRecords.length, 1)
  assert.equal(storageRecords[0].version, manifest.version)
  assert.match(storageRecords[0].sha256, /^[0-9a-f]{64}$/u)
  const koffi = require('koffi')
  assert.equal(koffi.version, '3.1.1')
  const nativePackage = '@koromix/koffi-win32-x64'
  assert.equal(inventory.selectedPlatformPackage, nativePackage)
  const selected = inventory.packages.filter(item => item.name === nativePackage)
  assert.equal(selected.length, 1)
  assert.equal(selected[0].version, '3.1.1')
  const packageDirectory = realpathSync(join(consumer, 'node_modules', nativePackage))
  const binaries = Object.keys(require.cache).filter(path => path.endsWith('.node'))
  assert.equal(binaries.length, 1, 'Exactly one installed native payload must load')
  const binary = realpathSync(binaries[0])
  assert.ok(binary.startsWith(packageDirectory + sep))
  const relative = binary.slice(packageDirectory.length + 1).split(sep).join('/')
  const expected = selected[0].nativeBinaries.filter(item => item.path === relative)
  assert.equal(expected.length, 1)
  const nativeBinarySha256 = fileDigest(binary)
  assert.equal(nativeBinarySha256, expected[0].sha256)
  return { entrySha256: fileDigest(actual), nativeBinarySha256, koffiVersion: koffi.version,
    nativePackage, packageManifestSha256: fileDigest(manifestPath), inventorySha256: fileDigest(inventoryPath),
    candidateArchiveSha256: storageRecords[0].sha256 }
}

/** Cross-check the compiled SDK record before invoking its executable. */
export function oracleBinding(program) {
  const buildPath = join(dirname(program), 'oracle-build.json')
  const build = JSON.parse(readFileSync(buildPath, 'utf8'))
  const oracleSha256 = fileDigest(program)
  const oracleSourceSha256 = fileDigest(fileURLToPath(new URL('windows-oracle.c', import.meta.url)))
  assert.equal(build.architecture, 'x64')
  assert.equal(build.sourceSha256, oracleSourceSha256)
  assert.equal(build.binarySha256, oracleSha256)
  assert.equal(build.compilerLogSha256, fileDigest(join(dirname(program), 'compiler.log')))
  return { oracleSha256, oracleSourceSha256, oracleBuildSha256: fileDigest(buildPath), compilerLogSha256: build.compilerLogSha256 }
}

/** Encode one controlled FILE_NAMES_INFORMATION page; all writes stay inside allocated buffers. */
export function injectDirectoryRecord(kind, status, data) {
  assert.equal(status.length, 16)
  assert.equal(data.length, 65536)
  data.fill(0)
  Buffer.from('record.bin', 'utf16le').copy(data, 12)
  data.writeUInt32LE(20, 8)
  let length = 32
  if (kind === 'truncated-header') length = 11
  else if (kind === 'overlong-buffer') length = data.length + 1
  else if (kind === 'odd-name-length') data.writeUInt32LE(1, 8)
  else if (kind === 'zero-name-length') data.writeUInt32LE(0, 8)
  else if (kind === 'name-overruns-page') data.writeUInt32LE(22, 8)
  else if (kind === 'next-record-truncated') data.writeUInt32LE(32, 0)
  else if (kind === 'next-offset-overlap') data.writeUInt32LE(12, 0)
  else if (kind === 'next-offset-unaligned') data.writeUInt32LE(33, 0)
  else if (kind === 'next-offset-overlong') data.writeUInt32LE(65532, 0)
  else if (kind === 'total-query-ceiling') {
    data.fill(0); data.writeUInt32LE(2, 8); data.writeUInt16LE(46, 12); length = 14
  } else assert.fail(`Unknown injected directory record: ${kind}`)
  status.writeInt32LE(0, 0)
  status.writeBigUInt64LE(BigInt(length), 8)
}

/** Reject missing, duplicated, simulated or stale report evidence before accepting its counters. */
export function validateReport(report, expected = {}) {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.evidence, 'packed-native-directory-cleanup-matrix')
  assert.ok(Array.isArray(report.results))
  const required = [...cases, ...blockedCases.map(row => row.name)]
  assert.equal(report.results.length, required.length)
  assert.deepEqual(report.results.map(row => row.name), required)
  for (const row of report.results) {
    assert.ok(['passed', 'failed', 'blocked'].includes(row.status))
    if (row.status !== 'passed') assert.ok(typeof row.reason === 'string' && row.reason.length > 0)
  }
  assert.deepEqual(report.summary, summary(report.results))
  assert.equal(report.acceptance, report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete')
  if (!report.nativeExecution) assert.equal(report.summary.passed, 0, 'A non-native report cannot pass a native row')
  else {
    assert.equal(report.platform, 'win32'); assert.equal(report.architecture, 'x64')
    assert.match(report.sourceSha ?? '', /^[0-9a-f]{40}$/u)
    for (const name of ['entrySha256', 'oracleSha256', 'oracleSourceSha256', 'nativeBinarySha256', 'fixtureSourceSha256']) {
      assert.match(report[name] ?? '', /^[0-9a-f]{64}$/u)
    }
    assert.equal(report.fixtureSourceSha256, digest(JSON.stringify(report.fixtureSources)))
    assert.deepEqual(Object.keys(report.fixtureSources), sourceFiles)
    for (const hash of Object.values(report.fixtureSources)) assert.match(hash, /^[0-9a-f]{64}$/u)
  }
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(report[name], value, `Report binding differs: ${name}`)
  for (const row of report.results.filter(row => row.status === 'passed')) {
    validateResult(row.detail, row.name, report, report.fixtureSourceSha256)
    assert.equal(row.detail.realStorageFailureClaimed, false)
    assert.equal(row.detail.actualPendingRequest, false)
    validateObservations(row.detail)
  }
  for (const blocked of blockedCases) assert.equal(report.results.find(row => row.name === blocked.name).status, 'blocked')
  return report.summary.failed ? 1 : report.summary.blocked ? 2 : 0
}

/** Validate one bounded child's identity and complete cleanup accounting without trusting its pass label. */
export function validateResult(result, scenario, binding, fixtureHash) {
  assert.ok(cases.includes(scenario))
  assert.equal(result.event, 'result')
  assert.equal(result.scenario, scenario)
  assert.equal(result.entrySha256, binding.entrySha256)
  assert.equal(result.nativeBinarySha256, binding.nativeBinarySha256)
  assert.equal(result.fixtureSourceSha256, fixtureHash)
  assert.equal(result.realNativeCalls, true)
  assert.ok(result.outcome && typeof result.outcome.ok === 'boolean')
  assert.ok(Array.isArray(result.trace) && result.trace.length <= 3000)
  for (const row of result.trace) {
    assert.equal(typeof row.forwarded, 'boolean')
    if (row.forwarded) assert.equal(Object.hasOwn(row, 'actualReturn'), true, 'Forwarded call must record its actual return')
    else assert.equal(row.injected, true, 'An unforwarded call must be explicitly injected')
    if (row.injected) assert.ok(['test-owned-return', 'test-owned-buffer', 'test-owned-exception'].includes(row.injectionOrigin))
  }
  assert.ok(result.trace.some(row => row.forwarded), 'Actual forwarded-call evidence is required')
  assert.equal(result.trace.filter(row => row.name === 'NtQueryDirectoryFile').length, result.queryCalls)
  assert.equal(result.injections, result.trace.filter(row => row.injected).length)
  assert.equal(result.faultInjected, result.injections > 0)
  assert.deepEqual(result.releaseErrors, [])
  assert.deepEqual(result.protocolViolations, [])
  assert.equal(result.remainingStorageHandles, 0)
  assert.equal(result.remainingSecurityDescriptors, 0)
  assert.equal(result.remainingBackingAllocations, /pending-(?:unsettled|wait-error)$/u.test(scenario) ? 2 : 0)
  assert.equal(result.inheritableStorageHandles, 0)
  assert.ok(Number.isSafeInteger(result.queryCalls) && result.queryCalls >= 0 && result.queryCalls <= queryBudget)
  assert.ok(Number.isSafeInteger(result.nativeCalls) && result.nativeCalls > 0)
  validateScenario(result, scenario)
}

/** Recheck every public outcome before a subprocess or persisted row can satisfy its named case. */
function validateScenario(result, scenario) {
  const success = ['directory-enumeration-baseline', 'directory-enumeration-pending-settled'].includes(scenario)
  assert.equal(result.outcome.ok, success)
  if (success) assert.deepEqual(result.outcome.audit, { complete: true, entries: 2 })
  else {
    const code = scenario.endsWith('entry-ceiling') || scenario.endsWith('total-query-ceiling') ? 'limit'
      : /pending-(?:unsettled|wait-error)$/u.test(scenario) ? 'unavailable' : 'native'
    assert.equal(result.outcome.code, code)
    assert.equal(result.outcome.audit, undefined, 'No partial tree may be reported as complete')
  }
  assert.equal(result.faultInjected, !scenario.endsWith('baseline') && !scenario.endsWith('entry-ceiling'))
  if (scenario.startsWith('directory-enumeration-')) {
    assert.ok(result.queryCalls > 0)
    if (scenario.endsWith('native-failure')) assert.equal(result.outcome.nativeStatus, 0xc0000001)
    if (scenario.endsWith('warning-return')) assert.equal(result.outcome.nativeStatus, 0x80000005)
  }
  if (/pending-(?:unsettled|wait-error)$/u.test(scenario)) {
    assert.deepEqual(result.poisonProbe, { rejected: true, code: 'unavailable', nativeCalls: 0, allocationChange: 0 })
  }
  if (scenario.startsWith('cleanup-real-')) {
    const cleanup = result.trace.filter(row => row.cleanupFault)
    assert.equal(cleanup.length, 1)
    assert.equal(cleanup[0].forwarded, true)
    assert.equal(cleanup[0].injected, true)
    assert.equal(cleanup[0].actuallyReleased || cleanup[0].actuallyUnlocked || cleanup[0].actualDeletionDisposition, true)
    const mode = scenario.slice('cleanup-real-'.length, -'-return-failure'.length)
    const role = { 'token-close': 'token', 'file-close': 'file', 'directory-close': 'directory', 'staging-close': 'staging' }[mode]
    if (role) {
      assert.equal(cleanup[0].name, 'CloseHandle'); assert.equal(cleanup[0].role, role)
      assert.equal(cleanup[0].actuallyReleased, true); assert.ok(Number.isInteger(cleanup[0].actualReturn) && cleanup[0].actualReturn !== 0)
      assert.equal(cleanup[0].visibleReturn, 0)
    } else if (mode === 'local-free') {
      assert.equal(cleanup[0].name, 'LocalFree'); assert.equal(cleanup[0].actuallyReleased, true)
      assert.ok(cleanup[0].actualReturn === null || cleanup[0].actualReturn === 0)
      assert.equal(cleanup[0].visibleReturn, 'non-null-pointer')
    } else if (mode === 'unlock') {
      assert.equal(cleanup[0].name, 'UnlockFileEx'); assert.equal(cleanup[0].actuallyUnlocked, true)
      assert.ok(Number.isInteger(cleanup[0].actualReturn) && cleanup[0].actualReturn !== 0); assert.equal(cleanup[0].visibleReturn, 0)
    } else {
      assert.equal(mode, 'staging-disposition'); assert.equal(cleanup[0].name, 'NtSetInformationFile')
      assert.equal(cleanup[0].informationClass, 13); assert.equal(cleanup[0].actualReturn, 0)
      assert.equal(cleanup[0].actualDeletionDisposition, true); assert.equal(cleanup[0].visibleReturn, -1073741823)
    }
    if (/-(?:unlock|directory-close)-return-failure$/u.test(scenario)) assert.deepEqual(result.idempotence, { repeatCloseNativeCalls: 0 })
    if (scenario.includes('staging-')) {
      assert.equal(result.writeFailureInjected, true)
      const writes = result.trace.filter(row => row.name === 'WriteFile' && row.injected)
      assert.equal(writes.length, 1); assert.equal(writes[0].forwarded, false)
      assert.equal(writes[0].injectionOrigin, 'test-owned-return'); assert.equal(writes[0].visibleReturn, 0)
      assert.equal(result.outcome.receipt.publication, 'not-published')
      assert.equal(result.outcome.receipt.durability, 'unconfirmed')
      assert.equal(result.outcome.receipt.phase, 'write')
      assert.equal(result.outcome.receipt.cleanup, 'failed')
    }
  }
}

/** Require independent before/after SDK identity and descriptor observations for every passing row. */
function validateObservations(detail) {
  for (const name of ['originalIdentitiesAndBytesRetained', 'originalPrivateDescriptorsRetained',
    'leaseReacquiredAfterChildExit', 'rootRenamedAfterChildExit', 'releasedResourcesAreNeverRetried']) assert.equal(detail[name], true)
  assert.deepEqual(detail.sdkBefore, detail.sdkAfter)
  assert.deepEqual(Object.keys(detail.sdkBefore).sort(), ['lease', 'record', 'root'])
  for (const [name, facts] of Object.entries(detail.sdkBefore)) {
    assert.match(facts.identity.volumeSerial, /^[0-9a-f]{16}$/u)
    assert.match(facts.identity.fileId, /^[0-9a-f]{32}$/u)
    assert.match(facts.descriptorHex, /^(?:[0-9a-f]{2}){20,65536}$/u)
    assert.match(facts.ownerSid, /^(?:[0-9a-f]{2}){8,68}$/u)
    assert.equal(facts.ownerSid, detail.sdkBefore.root.ownerSid)
    assert.equal(facts.daclProtected, true)
    assert.equal(facts.reparseTag, 0)
    if (name !== 'root') {
      assert.equal(facts.links, 1)
      assert.match(facts.bytesSha256, /^[0-9a-f]{64}$/u)
    }
  }
  if (detail.scenario.includes('staging-')) assert.deepEqual(detail.outcome.receipt.parentIdentity, detail.sdkBefore.root.identity)
  if (detail.scenario.endsWith('total-query-ceiling')) assert.equal(detail.backendBoundObserved, true)
}
