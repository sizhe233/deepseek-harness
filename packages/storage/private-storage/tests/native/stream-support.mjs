/** Test-only inventory, artifact identities and bounded data for native stream/source acceptance. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, openSync, readSync, realpathSync, statfsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Blocked, digest, fileDigest, summary } from './boundary-support.mjs'
import { installedBinding as rootBinding, oracleBinding } from './directory-boundary-support.mjs'

export { oracleBinding }
export const chunkBytes = 1024 * 1024
export const maxBytes = 1024 * chunkBytes
export const largeCases = Object.freeze({
  'stream-large-64mib-plus-one': 64 * chunkBytes + 1,
  'stream-large-257mib': 257 * chunkBytes,
  'stream-large-1gib': maxBytes,
})
export const cases = Object.freeze([
  'stream-manifest-limits', 'stream-chunk-limits', 'stream-legacy-byte-limit',
  'stream-zero-bytes', 'stream-exact-chunk', 'stream-tail-chunk', 'stream-distinct-multiappend',
  'stream-digest-order-mismatch', 'stream-short-manifest', 'stream-overlong-input',
  'stream-preexisting-file-preserved', 'stream-publication-collision-preserved',
  'stream-private-before-first-byte', 'stream-retained-parent-after-close',
  'stream-abort-removes-unpublished', 'stream-close-keeps-unpublished', 'stream-finish-cached',
  'stream-live-staging-denies-delete',
  'stream-root-streams-interoperability', 'stream-foreign-copy-rejected',
  ...Object.keys(largeCases),
  'source-zero-bytes', 'source-exact-chunk', 'source-tail-chunk',
  'source-shared-readable', 'source-readonly-file', 'source-hardlink',
  'source-retained-parent-after-close', 'source-identity-mismatch', 'source-size-mismatch',
  'source-digest-mismatch', 'source-incomplete-finish', 'source-close-preserves',
  'source-manifest-limits', 'source-chunk-limits', 'source-attributes-change-detected',
  'source-live-reader-denies-delete',
  'stream-real-write-return-loss', 'stream-real-rename-return-loss', 'stream-real-postflush-return-loss',
  'stream-real-close-return-loss', 'source-real-read-return-loss', 'source-real-close-return-loss',
])
export const blockedCases = Object.freeze([
  { name: 'stream-live-worker-termination', reason: 'A live Worker retaining its own writer has not yet been terminated and independently observed; process exit and cloned identities are not equivalent.' },
  { name: 'source-live-worker-termination', reason: 'A live Worker retaining its own reader has not yet been terminated and independently observed; process exit and cloned identities are not equivalent.' },
  { name: 'stream-real-gc-release-only', reason: 'Real collection, handle release and unchanged unpublished namespace have not yet been observed in a still-live process.' },
  { name: 'source-real-gc-release-only', reason: 'Real collection and source handle release have not yet been observed in a still-live process.' },
  { name: 'source-readonly-volume', reason: 'An existing readonly local NTFS volume is required; this fixture never creates mounts, volumes or privileged storage fixtures.' },
  { name: 'source-security-change-detected', reason: 'A deterministic owned-file security change fixture with independent before/after SDK evidence is not implemented.' },
  { name: 'source-ancestor-security-change-detected', reason: 'A deterministic retained-ancestor security change fixture with independent SDK evidence is not implemented.' },
  { name: 'source-during-read-change-detected', reason: 'A real mutation synchronized inside a native read is not implemented; between-call attribute changes do not satisfy it.' },
  { name: 'stream-indeterminate-rename-no-delete', reason: 'The rename return-loss fixture reconciles a published identity; a genuinely indeterminate namespace fixture is still required.' },
  { name: 'stream-genuine-kernel-release-failure', reason: 'Return-loss injection after successful close is not an actual OS release failure; no invalid or reused native handle is submitted.' },
  { name: 'stream-partial-native-write-failure', reason: 'The small real-write return-loss fixture does not establish partial native progress followed by an actual storage failure.' },
])
export const sourceFiles = Object.freeze(['stream-matrix.mjs', 'stream-worker.mjs', 'stream-observer.mjs', 'stream-access-probe.mjs',
  'stream-support.mjs', 'owner-observer.mjs', 'boundary-support.mjs', 'directory-boundary-support.mjs', 'windows-oracle.c', 'boundary-inheritance.c'])

/** Hash every executed fixture/helper dependency; bind the candidate separately through CANDIDATE_SHA. */
export function sourceBinding() {
  const files = Object.fromEntries(sourceFiles.map(name => [name, fileDigest(fileURLToPath(new URL(name, import.meta.url)))]))
  return { files, sha256: digest(JSON.stringify(files)) }
}

/** Require the public installed root and public self-reference stream entry from the same package. */
export function installedBinding(entry) {
  const binding = rootBinding(entry)
  const require = createRequire(entry)
  const streams = realpathSync(require.resolve('@deepseek-ai/dsh-private-storage/streams'))
  assert.equal(streams, realpathSync(join(dirname(entry), 'streams.js')))
  const manifest = require('@deepseek-ai/dsh-private-storage/package.json')
  assert.equal(manifest.exports['./streams'].default, './lib/streams.js')
  return { ...binding, streamsEntrySha256: fileDigest(streams) }
}

/** Generate at most one owned MiB; chunk position changes its full content and digest order. */
export function syntheticChunk(offset, length) {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0)
  assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= chunkBytes)
  const bytes = Buffer.alloc(length, ((Math.floor(offset / chunkBytes) * 73) + 41) % 251)
  for (let index = 0; index < length; index += 4096) {
    const label = Buffer.from(`${offset + index}:synthetic-stream\n`)
    label.copy(bytes, index, 0, Math.min(label.length, length - index))
  }
  return bytes
}

/** Compute the manifest without allocating the complete synthetic file. */
export function syntheticDigest(length) {
  assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= maxBytes)
  const hash = createHash('sha256')
  for (let offset = 0; offset < length; offset += chunkBytes) hash.update(syntheticChunk(offset, Math.min(chunkBytes, length - offset)))
  return hash.digest('hex')
}

/** Hash actual file bytes independently with a bounded buffer, including exact EOF. */
export function hashFile(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), bytes = Buffer.alloc(chunkBytes)
  let sizeBytes = 0
  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null)
      if (count === 0) break
      sizeBytes += count
      hash.update(bytes.subarray(0, count))
    }
  } finally { closeSync(fd) }
  return { sizeBytes, sha256: hash.digest('hex'), bufferBytes: bytes.length }
}

/** Admit sequential large synthetic cases only with the file size plus a 256 MiB reserve. */
export function diskPreflight(path, sizeBytes) {
  const disk = statfsSync(path, { bigint: true })
  const availableBytes = disk.bavail * disk.bsize
  const requiredBytes = BigInt(sizeBytes) + 256n * BigInt(chunkBytes)
  if (availableBytes < requiredBytes) throw new Blocked(`Insufficient synthetic-fixture disk space: available=${availableBytes}, required=${requiredBytes}`)
  return { availableBytes: availableBytes.toString(), requiredBytes: requiredBytes.toString(),
    fileBytes: sizeBytes, reserveBytes: 256 * chunkBytes, sequential: true }
}

/** Select content size without allowing a command-line caller to enlarge a fixture. */
export function caseBytes(scenario) {
  if (Object.hasOwn(largeCases, scenario)) return largeCases[scenario]
  if (scenario.endsWith('zero-bytes')) return 0
  if (scenario.endsWith('exact-chunk')) return chunkBytes
  if (scenario.endsWith('tail-chunk')) return chunkBytes + 37
  return 173
}

/** Require SDK identity and security observations without claiming atime or audit silence. */
export function validateSdk(facts) {
  assert.equal(facts.complete, true)
  assert.equal(facts.inspectionScope, 'full-handle-facts')
  assert.match(facts.identity.volumeSerial, /^[0-9a-f]{16}$/u)
  assert.match(facts.identity.fileId, /^[0-9a-f]{32}$/u)
  assert.match(facts.descriptorHex, /^(?:[0-9a-f]{2}){20,65536}$/u)
  assert.equal(facts.reparseTag, 0)
  assert.equal(facts.filesystem, 'NTFS')
  assert.equal(facts.remote, false)
}

/** Validate all report identities and named obligations before using the summary. */
export function validateReport(report, expected = {}) {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.evidence, 'packed-native-stream-source-matrix')
  assert.deepEqual(report.results.map(row => row.name), [...cases, ...blockedCases.map(row => row.name)])
  for (const row of report.results) {
    assert.ok(['passed', 'failed', 'blocked'].includes(row.status))
    if (row.status !== 'passed') assert.ok(typeof row.reason === 'string' && row.reason.length > 0)
  }
  assert.deepEqual(report.summary, summary(report.results))
  assert.equal(report.acceptance, report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete')
  for (const { name } of blockedCases) assert.equal(report.results.find(row => row.name === name).status, 'blocked')
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(report[name], value, `Report binding differs: ${name}`)
  if (!report.nativeExecution) assert.equal(report.summary.passed, 0, 'Portable checks cannot satisfy native rows')
  else {
    assert.equal(report.platform, 'win32'); assert.equal(report.architecture, 'x64')
    assert.match(report.sourceSha ?? '', /^[0-9a-f]{40}$/u)
    for (const name of ['entrySha256', 'streamsEntrySha256', 'packageManifestSha256', 'inventorySha256',
      'candidateArchiveSha256', 'nativeBinarySha256', 'oracleSha256', 'oracleSourceSha256', 'oracleBuildSha256', 'compilerLogSha256']) {
      assert.match(report[name] ?? '', /^[0-9a-f]{64}$/u)
    }
    assert.equal(report.koffiVersion, '3.1.1'); assert.equal(report.nativePackage, '@koromix/koffi-win32-x64')
    assert.deepEqual(Object.keys(report.fixtureSources), sourceFiles)
    for (const hash of Object.values(report.fixtureSources)) assert.match(hash, /^[0-9a-f]{64}$/u)
    assert.equal(report.fixtureSourceSha256, digest(JSON.stringify(report.fixtureSources)))
  }
  for (const row of report.results.filter(row => row.status === 'passed')) {
    validateResult(row.detail, row.name, report, report.fixtureSourceSha256)
    assert.equal(row.detail.processExited, true); assert.equal(row.detail.streamClosed, true)
    assert.equal(row.detail.rootRenamedAfterChildExit, true)
    validateSdk(row.detail.sdkRootAfter)
    assert.equal(row.detail.nativeOnly, true)
    assert.equal(row.detail.actualStorageFailureClaimed, false)
    assert.equal(row.detail.accessTimeOrAuditSilenceClaimed, false)
    if (row.name.endsWith('denies-delete')) {
      const controls = row.detail.accessControls
      validateAccessProbe(controls.live, false, report, report.fixtureSourceSha256)
      validateAccessProbe(controls.released, true, report, report.fixtureSourceSha256)
      validateSdk(controls.sdkWhileLive)
      assert.equal(controls.independentProcesses, true)
      if (row.name.startsWith('stream-')) {
        assert.equal(controls.sdkWhileLive.sizeBytes, '0')
        assert.equal(controls.live.read.bytes, 0); assert.equal(controls.live.read.sha256, digest(''))
        assert.equal(controls.released.read.sha256, row.detail.observations.fileHash.sha256)
        assert.equal(controls.released.read.bytes, row.detail.observations.fileHash.sizeBytes)
      } else {
        assert.deepEqual(controls.sdkWhileLive, row.detail.observations.sourceBefore)
        assert.equal(controls.live.read.sha256, row.detail.observations.sourceHashBefore.sha256)
        assert.equal(controls.released.read.sha256, row.detail.observations.sourceHashBefore.sha256)
      }
    }
  }
  return report.summary.failed ? 1 : report.summary.blocked ? 2 : 0
}

/** Require real native denial while retained and positive controls after the owner releases. */
export function validateAccessProbe(result, allowed, binding, fixtureHash) {
  assert.equal(result.event, 'access-result'); assert.equal(result.completed, true)
  for (const name of ['entrySha256', 'streamsEntrySha256', 'nativeBinarySha256']) assert.equal(result[name], binding[name])
  assert.equal(result.fixtureSourceSha256, fixtureHash)
  assert.equal(result.mode, allowed ? 'released' : 'retained')
  assert.equal(result.deleteOpen.desiredAccess, 0x10000); assert.equal(result.deleteOpen.shareAccess, 7)
  assert.equal(result.deleteOpen.actualReturn, allowed ? 'valid-owned-handle' : 'invalid-handle')
  assert.equal(result.deleteOpen.opened, allowed)
  assert.equal(result.rename.actualReturn !== 0, allowed)
  assert.equal(result.read.opened, true); assert.notEqual(result.read.actualReturn, 0)
  assert.equal(result.read.desiredAccess, 0x120081); assert.equal(result.read.shareAccess, 7)
  assert.ok(Number.isSafeInteger(result.read.bytes) && result.read.bytes >= 0 && result.read.bytes <= chunkBytes)
  assert.match(result.read.sha256, /^[0-9a-f]{64}$/u)
  if (allowed) {
    assert.equal(result.deleteOpen.win32Error, null); assert.equal(result.rename.win32Error, null)
    assert.notEqual(result.restore.actualReturn, 0)
  } else {
    assert.equal(result.deleteOpen.win32Error, 32); assert.equal(result.rename.win32Error, 32)
    assert.equal(result.restore, null)
  }
  assert.equal(result.remainingHandles, 0); assert.deepEqual(result.closeFailures, [])
}

/** Validate raw native facts and resource accounting, independently of a child's success label. */
export function validateResult(result, scenario, binding, fixtureHash) {
  assert.ok(cases.includes(scenario))
  assert.equal(result.event, 'result'); assert.equal(result.scenario, scenario)
  for (const name of ['entrySha256', 'streamsEntrySha256', 'nativeBinarySha256']) assert.equal(result[name], binding[name])
  assert.equal(result.fixtureSourceSha256, fixtureHash)
  assert.equal(result.completed, true)
  const native = result.native
  assert.ok(Number.isSafeInteger(native.nativeCalls) && native.nativeCalls > 0)
  assert.ok(Array.isArray(native.calls) && native.calls.length > 0 && native.calls.length <= 128)
  assert.equal(native.calls.reduce((sum, call) => sum + call.count, 0), native.nativeCalls)
  for (const call of native.calls) {
    assert.ok(Number.isSafeInteger(call.count) && call.count > 0)
    assert.ok(Number.isSafeInteger(call.forwarded) && call.forwarded === call.count)
    assert.ok(Object.hasOwn(call.first, 'actualReturn') && Object.hasOwn(call.last, 'actualReturn'))
  }
  assert.equal(native.observationLayer, 'opaque-native-owner-methods')
  assert.equal(native.counterObservation, 'controlled-quiescent-barrier')
  for (const key of ['remainingStorageCapabilities', 'remainingStorageHandles', 'remainingTokenHandles', 'remainingBackingAllocations',
    'remainingSecurityDescriptors', 'pendingContexts', 'unconfirmedReleases']) assert.equal(native[key], 0)
  assert.equal(native.inheritanceObservation.status, 'verified', 'Actual SDK inheritance observations remain mandatory')
  assert.equal(native.inheritanceObservation.mechanism, 'current-process-sdk-snapshot')
  assert.ok(Number.isSafeInteger(native.inheritanceObservation.checkedStorageHandles) && native.inheritanceObservation.checkedStorageHandles > 0)
  assert.match(native.inheritanceObservation.sdkDllSha256, /^[0-9a-f]{64}$/u)
  assert.equal(native.inheritanceObservation.inheritableStorageHandles, 0)
  assert.deepEqual(native.protocolViolations, []); assert.deepEqual(result.releaseErrors, [])
  assert.ok(Array.isArray(native.faults) && native.faults.length <= 1)
  assert.equal(native.faults.length, scenario.includes('-real-') ? 1 : 0)
  for (const fault of native.faults) {
    assert.equal(fault.forwarded, true); assert.equal(fault.origin, 'test-owned-return-loss')
    assert.notEqual(fault.actualReturn, fault.visibleReturn)
  }
  assert.ok(result.observations && typeof result.observations === 'object')
  validateScenario(result, scenario)
}

/** Named rows require their actual public receipts and independent observations. */
function validateScenario(result, scenario) {
  const value = result.observations
  assert.match(value.tokenUserSid ?? '', /^(?:[0-9a-f]{2}){8,68}$/u)
  const successfulWriter = ['stream-zero-bytes', 'stream-exact-chunk', 'stream-tail-chunk', 'stream-distinct-multiappend',
    'stream-private-before-first-byte', 'stream-retained-parent-after-close', 'stream-finish-cached',
    'stream-root-streams-interoperability', 'stream-live-staging-denies-delete', ...Object.keys(largeCases)].includes(scenario)
  const failedWriter = ['stream-digest-order-mismatch', 'stream-short-manifest', 'stream-overlong-input',
    'stream-publication-collision-preserved'].includes(scenario) || scenario.startsWith('stream-real-')
  if (successfulWriter) {
    assert.equal(value.writerReceipt?.outcome, 'finished')
    if (scenario !== 'stream-distinct-multiappend') assert.equal(value.writerReceipt.expectedBytes, caseBytes(scenario))
  }
  if (failedWriter) { assert.equal(value.writerReceipt?.outcome, 'failed'); assert.equal(value.error?.name, 'PrivateFileWriterError') }
  if (value.writerReceipt) {
    const receipt = value.writerReceipt
    assert.equal(receipt.mechanism, 'windows-ntfs-write-through-rename-v1')
    assert.equal(receipt.synchronization.directory, 'not-required')
    assert.ok(['released', 'failed'].includes(receipt.release))
    if (receipt.outcome === 'finished') {
      for (const key of ['contentVerification', 'bindingVerification', 'metadataVerification']) assert.equal(receipt[key], 'verified')
      assert.equal(receipt.publication, 'published'); assert.equal(receipt.durability, 'synced')
      assert.equal(receipt.synchronization.preFile, 'succeeded'); assert.equal(receipt.synchronization.postFile, 'succeeded')
      assert.equal(receipt.acceptedBytes, receipt.expectedBytes); assert.equal(receipt.actualSha256, receipt.expectedSha256)
      assert.equal(value.fileHash.sha256, receipt.expectedSha256); assert.equal(value.fileHash.sizeBytes, receipt.expectedBytes)
      validateSdk(value.sdkFinal)
      assert.equal(value.sdkFinal.ownerSid, value.tokenUserSid)
      assert.equal(value.sdkFinal.daclPresent, true); assert.equal(value.sdkFinal.daclNull, false)
      assert.equal(value.sdkFinal.daclProtected, true); assert.equal(value.sdkFinal.links, 1)
      assert.deepEqual(value.sdkFinal.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })),
        [{ type: 0, flags: 0, mask: 0x001f01ff, sid: value.tokenUserSid }])
      assert.deepEqual(receipt.identity, { backend: 'windows-ntfs', ...value.sdkFinal.identity })
    }
  }
  if (value.sourceBefore) {
    validateSdk(value.sourceBefore); validateSdk(value.sourceAfter)
    assert.deepEqual(value.sourceAfter, value.sourceBefore)
    assert.deepEqual(value.sourceHashAfter, value.sourceHashBefore)
    assert.deepEqual(value.selectedSourceFacts.identity, { backend: 'windows-ntfs', ...value.sourceBefore.identity })
    assert.equal(value.selectedSourceFacts.sizeBytes, value.sourceHashBefore.sizeBytes)
    assert.equal(value.selectedSourceFacts.links, value.sourceBefore.links)
    assert.match(value.selectedSourceFacts.changeToken, /^[0-9a-f]{64}$/u)
    assert.equal(value.selectedSourceFacts.observations.securityDescriptorSha256, digest(Buffer.from(value.sourceBefore.descriptorHex, 'hex')))
  }
  if (scenario.includes('-real-')) {
    const fault = result.native.faults[0]
    const target = { 'stream-real-write-return-loss': 'write', 'stream-real-rename-return-loss': 'rename',
      'stream-real-postflush-return-loss': 'flush', 'stream-real-close-return-loss': 'close',
      'source-real-read-return-loss': 'read', 'source-real-close-return-loss': 'close' }[scenario]
    assert.equal(fault.name, target)
    if (target === 'rename') assert.equal(fault.actualPublication, true)
    if (target === 'write') assert.ok(Number.isSafeInteger(fault.actualReturn) && fault.actualReturn > 0)
    else assert.equal(fault.actualReturn, target === 'read' ? 'completed-value' : 'completed-void')
    assert.equal(fault.visibleReturn, 'thrown')
    if (target === 'close') assert.equal(fault.actuallyReleased, true)
    if (target === 'write' || target === 'read') assert.ok(Number.isSafeInteger(fault.actualBytes) && fault.actualBytes > 0)
    assert.ok(value.error && typeof value.error.name === 'string')
    assert.ok(value.error.nativeStatus !== null || value.error.win32Code !== null)
    if (scenario.startsWith('stream-')) {
      assert.equal(value.writerReceipt.outcome, 'failed')
      if (/rename|postflush|close/u.test(scenario)) {
        assert.equal(value.writerReceipt.publication, 'published')
        assert.equal(value.writerReceipt.cleanup, 'withheld')
        validateSdk(value.sdkFinal); assert.equal(value.fileHash.sha256, value.writerReceipt.expectedSha256)
        assert.equal(result.native.deletionsAfterPublish, 0)
      }
    } else assert.equal(value.readerReceipt.outcome, 'failed')
    if (scenario === 'stream-real-write-return-loss') {
      assert.equal(value.writerReceipt.acceptedBytes, 0)
      assert.equal(value.writerReceipt.observedSizeBytes, fault.actualBytes)
      assert.equal(result.native.writeBytes, fault.actualBytes)
    }
    if (scenario === 'stream-real-postflush-return-loss') {
      assert.equal(value.writerReceipt.synchronization.postFile, 'failed'); assert.equal(value.writerReceipt.durability, 'unconfirmed')
    }
    if (scenario === 'stream-real-close-return-loss') assert.equal(value.writerReceipt.release, 'failed')
    if (scenario === 'source-real-close-return-loss') assert.equal(value.readerReceipt.release, 'failed')
    if (scenario === 'source-real-read-return-loss') { assert.equal(value.readerReceipt.observedBytes, 0); assert.equal(result.native.readBytes, fault.actualBytes) }
  }
  if (Object.hasOwn(largeCases, scenario)) {
    assert.equal(value.writerReceipt.expectedBytes, largeCases[scenario])
    assert.equal(value.preflight.fileBytes, largeCases[scenario]); assert.equal(value.preflight.sequential, true)
    assert.ok(BigInt(value.preflight.availableBytes) >= BigInt(value.preflight.requiredBytes))
    assert.equal(value.fileHash.bufferBytes, chunkBytes)
    assert.equal(result.native.writeBytes, largeCases[scenario])
    assert.ok(result.native.maxWriteRequestBytes <= chunkBytes)
  }
  if (scenario === 'stream-private-before-first-byte') {
    validateSdk(value.sdkBeforeFirstByte)
    assert.equal(value.sdkBeforeFirstByte.sizeBytes, '0'); assert.equal(value.nativeWritesBeforeFirstByte, 0)
    assert.equal(value.sdkBeforeFirstByte.daclProtected, true)
    assert.equal(value.sdkBeforeFirstByte.links, 1)
    assert.equal(value.sdkBeforeFirstByte.ownerSid, value.tokenUserSid)
    assert.deepEqual(value.sdkBeforeFirstByte.identity, value.sdkFinal.identity)
  }
  if (scenario === 'stream-root-streams-interoperability') assert.equal(value.rootCapabilityAcceptedByStreams, true)
  if (scenario === 'stream-foreign-copy-rejected') {
    assert.deepEqual(value.copiedRuntimeHashes, { 'index.js': binding.entrySha256, 'streams.js': binding.streamsEntrySha256 })
    assert.equal(value.foreignWriterRejected, true); assert.equal(value.foreignSourceRejected, true)
    assert.equal(value.foreignNativeCalls, 0)
  }
  if (scenario.endsWith('retained-parent-after-close')) {
    assert.equal(value.parentRenameDeniedWhileRetained, true); assert.equal(value.parentRenamedAfterRelease, true)
  }
  if (scenario.endsWith('denies-delete')) assert.equal(value.liveAccessBarrier, true)
  if (scenario === 'source-hardlink') assert.equal(value.sourceBefore.links, 2)
  if (scenario === 'source-readonly-file') assert.equal(value.sourceBefore.attributes & 1, 1)
  if (scenario === 'source-shared-readable') assert.ok(value.sourceBefore.aces.some(ace => ace.sid !== value.tokenUserSid))
  if (scenario === 'stream-manifest-limits') {
    assert.equal(value.invalidManifestCount, 14); assert.equal(value.invalidManifestNativeCalls, 0)
    assert.equal(value.acceptedMaximumManifestBytes, maxBytes)
    assert.equal(value.maxChunkBytes, chunkBytes); assert.equal(value.maxFileBytes, maxBytes)
    assert.equal(value.writerReceipt.outcome, 'aborted'); assert.equal(value.writerReceipt.acceptedBytes, 0)
  }
  if (scenario === 'stream-chunk-limits') {
    assert.deepEqual(value.rejections.map(({ length, shared }) => ({ length, shared })),
      [{ length: 0, shared: false }, { length: chunkBytes + 1, shared: false }, { length: 1, shared: true }])
    for (const row of value.rejections) { assert.equal(row.error.name, 'PrivateFileWriterError'); assert.equal(row.acceptedBytes, 0); assert.equal(row.nativeWrittenBytes, 0) }
  }
  if (scenario === 'stream-legacy-byte-limit') {
    assert.equal(value.legacyMaximumReadBytes, 64 * chunkBytes); assert.equal(value.oversizedReadNativeCalls, 0)
    assert.equal(value.legacyReadError.code, 'limit')
    assert.equal(value.legacyOversizedWriteBytes, 64 * chunkBytes + 1); assert.equal(value.oversizedWriteNativeCalls, 0)
    assert.deepEqual(value.legacyWriteErrors.map(error => error.code), ['limit', 'limit'])
  }
  if (['stream-distinct-multiappend', 'stream-digest-order-mismatch'].includes(scenario)) {
    assert.equal(value.appendDigests.length, 3); assert.equal(new Set(value.appendDigests).size, 3)
    assert.deepEqual(value.actualAppendDigests, scenario.endsWith('mismatch') ? value.appendDigests.toReversed() : value.appendDigests)
    if (scenario.endsWith('mismatch')) {
      assert.equal(value.writerReceipt.contentVerification, 'failed')
      assert.notEqual(value.writerReceipt.actualSha256, value.writerReceipt.expectedSha256)
    }
  }
  if (scenario === 'stream-short-manifest') {
    assert.equal(value.writerReceipt.acceptedBytes, 172); assert.equal(value.writerReceipt.expectedBytes, 173)
    assert.equal(value.writerReceipt.contentVerification, 'failed')
  }
  if (scenario === 'stream-overlong-input') { assert.equal(value.writerReceipt.acceptedBytes, 0); assert.equal(result.native.writeBytes, 0) }
  if (['stream-preexisting-file-preserved', 'stream-publication-collision-preserved'].includes(scenario)) {
    validateSdk(value.existingBefore); assert.deepEqual(value.existingAfter, value.existingBefore)
    assert.deepEqual(value.existingHashAfter, value.existingHashBefore)
    assert.equal(value.error.code, 'collision')
  }
  if (scenario === 'stream-abort-removes-unpublished') {
    assert.equal(value.writerReceipt.outcome, 'aborted'); assert.equal(value.writerReceipt.publication, 'not-published')
    assert.ok(['removed', 'delete-pending'].includes(value.writerReceipt.cleanup)); assert.equal(value.unpublishedRemoved, true)
  }
  if (scenario === 'stream-close-keeps-unpublished') {
    assert.equal(value.writerReceipt.outcome, 'closed'); assert.equal(value.writerReceipt.publication, 'not-published')
    assert.equal(value.writerReceipt.cleanup, 'withheld')
    validateSdk(value.stagingBefore); assert.deepEqual(value.stagingAfter, value.stagingBefore)
    assert.deepEqual(value.stagingHashAfter, value.stagingHashBefore)
  }
  if (['stream-abort-removes-unpublished', 'stream-close-keeps-unpublished', 'stream-finish-cached'].includes(scenario) || failedWriter) {
    assert.equal(value.terminalNativeCalls, 0)
  }
  if (['stream-digest-order-mismatch', 'stream-short-manifest', 'stream-overlong-input', 'stream-real-write-return-loss'].includes(scenario)) {
    assert.equal(value.writerReceipt.publication, 'not-published'); assert.equal(value.unpublishedRemoved, true)
    assert.equal(value.writerReceipt.durability, 'unconfirmed')
  }
  if (scenario.startsWith('source-')) {
    assert.ok(value.sourceBefore && value.sourceAfter)
    const expected = value.expectedSource
    assert.ok(expected && expected.expectedIdentity)
    if (scenario === 'source-identity-mismatch') assert.notDeepEqual(expected.expectedIdentity, value.selectedSourceFacts.identity)
    else assert.deepEqual(expected.expectedIdentity, value.selectedSourceFacts.identity)
    assert.equal(expected.expectedBytes, value.sourceHashBefore.sizeBytes + (scenario === 'source-size-mismatch' ? 1 : 0))
    if (scenario === 'source-digest-mismatch') assert.notEqual(expected.expectedSha256, value.sourceHashBefore.sha256)
    else assert.equal(expected.expectedSha256, value.sourceHashBefore.sha256)
    const failure = ['source-identity-mismatch', 'source-size-mismatch', 'source-digest-mismatch',
      'source-incomplete-finish', 'source-attributes-change-detected'].includes(scenario) || scenario.startsWith('source-real-')
    if (failure) {
      assert.equal(value.error?.name, 'SourceFileReaderError'); assert.equal(value.readerReceipt?.outcome, 'failed')
      assert.equal(value.readerReceipt.verification, 'failed')
    } else if (scenario === 'source-close-preserves') {
      assert.equal(value.readerReceipt.outcome, 'closed'); assert.equal(value.readerReceipt.verification, 'unverified')
    } else if (scenario === 'source-manifest-limits') {
      assert.equal(value.invalidManifestCount, 9); assert.equal(value.invalidManifestNativeCalls, 0)
      assert.equal(value.acceptedMaximumManifestBytes, maxBytes); assert.ok(value.maximumManifestNativeCalls > 0)
      assert.equal(value.maximumManifestReceipt.expectedBytes, maxBytes)
      assert.equal(value.maximumManifestReceipt.verification, 'failed'); assert.equal(value.maximumManifestReceipt.release, 'released')
    } else if (scenario === 'source-chunk-limits') {
      assert.deepEqual(value.rejections.map(row => row.bound), [0, -1, 0.5, chunkBytes + 1])
      for (const row of value.rejections) {
        assert.equal(row.nativeReadBytes, 0); assert.equal(row.error.name, 'SourceFileReaderError')
        assert.equal(row.receipt.release, 'released'); assert.equal(row.receipt.verification, 'failed')
      }
    } else assert.equal(value.readerReceipt?.outcome, 'finished')
    if (scenario === 'source-attributes-change-detected') {
      validateSdk(value.sourceDuringMutation)
      assert.notEqual(value.sourceDuringMutation.attributes, value.sourceBefore.attributes)
      assert.equal(value.readerReceipt.observations, 'failed')
    }
  }
  if (scenario.startsWith('source-') && value.readerReceipt?.outcome === 'finished') {
    assert.equal(value.readerReceipt.verification, 'verified'); assert.equal(value.readerReceipt.eof, true)
    assert.equal(value.readerReceipt.actualSha256, value.sourceHashBefore.sha256)
    assert.equal(value.readerReceipt.observedBytes, value.sourceHashBefore.sizeBytes)
  }
}
