/** Portable report/data/process negatives only. None of these tests execute a Windows storage backend. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { digest, fixtureEnvironment, startChild, summary } from './boundary-support.mjs'
import { blockedCases, caseBytes, cases, chunkBytes, hashFile, largeCases, maxBytes, oracleBinding, sourceBinding,
  sourceFiles, syntheticChunk, syntheticDigest, validateAccessProbe, validateReport, validateResult } from './stream-support.mjs'

const binding = { entrySha256: 'a'.repeat(64), streamsEntrySha256: 'b'.repeat(64), nativeBinarySha256: 'c'.repeat(64) }
const fixtureHash = 'd'.repeat(64)
const sid = '01'.repeat(12)
function sdkFacts() {
  return { complete: true, inspectionScope: 'full-handle-facts', identity: { volumeSerial: '1'.repeat(16), fileId: '2'.repeat(32) },
    descriptorHex: '00'.repeat(20), ownerSid: sid, daclPresent: true, daclNull: false, daclProtected: true,
    directory: false, links: 1, sizeBytes: '0', attributes: 128, reparseTag: 0, filesystem: 'NTFS', remote: false,
    aces: [{ type: 0, flags: 0, mask: 0x001f01ff, sid }] }
}
function nativeSummary() {
  return { nativeCalls: 3, observationLayer: 'opaque-native-owner-methods', counterObservation: 'controlled-quiescent-barrier',
    calls: [{ name: 'open', count: 3, forwarded: 3,
    first: { actualReturn: 'completed-value' }, last: { actualReturn: 'completed-value' } }], faults: [],
  remainingStorageCapabilities: 0, remainingTokenHandles: 0, pendingContexts: 0, unconfirmedReleases: 0,
  remainingStorageHandles: 0, remainingBackingAllocations: 0, remainingSecurityDescriptors: 0,
  inheritanceObservation: { status: 'verified', mechanism: 'current-process-sdk-snapshot', checkedStorageHandles: 3,
    inheritableStorageHandles: 0, sdkDllSha256: 'f'.repeat(64) },
  protocolViolations: [], writeBytes: 0, readBytes: 0, deletionsAfterPublish: 0 }
}
function resultFixture() {
  return { event: 'result', scenario: 'stream-manifest-limits', ...binding, fixtureSourceSha256: fixtureHash,
    completed: true, native: nativeSummary(), releaseErrors: [], observations: { tokenUserSid: sid,
      invalidManifestCount: 14, invalidManifestNativeCalls: 0, acceptedMaximumManifestBytes: maxBytes,
      maxChunkBytes: chunkBytes, maxFileBytes: maxBytes,
      writerReceipt: { mechanism: 'windows-ntfs-write-through-rename-v1', synchronization: { directory: 'not-required' },
        release: 'released', outcome: 'aborted', acceptedBytes: 0 } },
    nativeOnly: true, actualStorageFailureClaimed: false, accessTimeOrAuditSilenceClaimed: false }
}
function reportFixture(native = false) {
  const fixtureSources = Object.fromEntries(sourceFiles.map(name => [name, 'e'.repeat(64)]))
  return recount({ schemaVersion: 1, evidence: 'packed-native-stream-source-matrix',
    nativeExecution: native, platform: native ? 'win32' : 'linux', architecture: 'x64', sourceSha: 'f'.repeat(40), ...binding,
    ...Object.fromEntries(['packageManifestSha256', 'inventorySha256', 'candidateArchiveSha256', 'oracleSha256',
      'oracleSourceSha256', 'oracleBuildSha256', 'compilerLogSha256'].map(name => [name, '0'.repeat(64)])),
    koffiVersion: '3.1.1', nativePackage: '@koromix/koffi-win32-x64',
    fixtureSources, fixtureSourceSha256: digest(JSON.stringify(fixtureSources)),
    results: [...cases, ...blockedCases.map(row => row.name)].map(name => ({ name, status: 'blocked', reason: 'Portable report data only' })) })
}
function recount(report) {
  report.summary = summary(report.results)
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  return report
}

test('the exact required inventory includes large sizes and unimplemented lifetime obligations', () => {
  assert.equal(cases.length, 45); assert.equal(blockedCases.length, 11)
  assert.equal(new Set([...cases, ...blockedCases.map(row => row.name)]).size, 56)
  assert.deepEqual(Object.values(largeCases), [64 * chunkBytes + 1, 257 * chunkBytes, maxBytes])
  assert.equal(caseBytes('stream-zero-bytes'), 0)
  assert.equal(caseBytes('source-tail-chunk'), chunkBytes + 37)
  const report = reportFixture()
  assert.equal(validateReport(report), 2)
  report.results[0] = { name: cases[0], status: 'failed', reason: 'Observed native prerequisite failure' }
  assert.equal(validateReport(recount(report)), 1)
  for (const name of ['stream-live-worker-termination', 'source-live-worker-termination', 'stream-real-gc-release-only',
    'source-real-gc-release-only', 'source-readonly-volume', 'stream-indeterminate-rename-no-delete']) {
    assert.ok(blockedCases.some(row => row.name === name && row.reason.length > 20))
  }
})

test('report validation rejects erased rows, invented passes, stale identities and unsupported status labels', () => {
  for (const mutate of [
    r => { r.results.pop(); recount(r) }, r => { r.results[1].name = r.results[0].name },
    r => { r.results.reverse() }, r => { r.results[0].status = 'skipped'; recount(r) },
    r => { r.results[0].status = 'passed'; recount(r) }, r => { r.results[0].reason = '' },
    r => { r.summary.blocked-- }, r => { r.acceptance = 'complete' },
  ]) {
    const report = reportFixture(); mutate(report); assert.throws(() => validateReport(report))
  }
  const original = reportFixture(true)
  assert.equal(validateReport(original, { sourceSha: original.sourceSha, ...binding }), 2)
  for (const name of ['sourceSha', 'entrySha256', 'streamsEntrySha256', 'packageManifestSha256', 'inventorySha256',
    'candidateArchiveSha256', 'nativeBinarySha256', 'oracleSha256', 'oracleSourceSha256', 'oracleBuildSha256', 'compilerLogSha256']) {
    const report = structuredClone(original); report[name] = null; assert.throws(() => validateReport(report))
  }
  for (const mutate of [
    r => { r.platform = 'linux' }, r => { r.architecture = 'arm64' }, r => { r.koffiVersion = '3.1.0' },
    r => { r.nativePackage = '@koromix/koffi-win32-arm64' },
    r => { r.fixtureSources[sourceFiles[0]] = '1'.repeat(64) },
    r => { delete r.fixtureSources['stream-observer.mjs'] },
  ]) {
    const report = structuredClone(original); mutate(report); assert.throws(() => validateReport(report))
  }
  assert.throws(() => validateReport(original, { sourceSha: '0'.repeat(40) }), /binding differs/u)
})

test('passing rows need bounded raw calls, release accounting and their named operation evidence', () => {
  const original = resultFixture()
  validateResult(original, original.scenario, binding, fixtureHash)
  for (const mutate of [
    r => { r.completed = false }, r => { r.event = 'ready' }, r => { r.scenario = 'stream-zero-bytes' },
    r => { r.entrySha256 = '0'.repeat(64) }, r => { r.streamsEntrySha256 = '0'.repeat(64) },
    r => { r.nativeBinarySha256 = '0'.repeat(64) }, r => { r.fixtureSourceSha256 = '0'.repeat(64) },
    r => { r.native.nativeCalls = 0 }, r => { r.native.nativeCalls++ }, r => { r.native.calls = [] },
    r => { r.native.calls[0].forwarded = 2 }, r => { delete r.native.calls[0].first.actualReturn },
    r => { delete r.native.calls[0].last.actualReturn }, r => { r.native.calls = Array(129).fill(r.native.calls[0]) },
    r => { r.native.remainingStorageHandles = 1 }, r => { r.native.remainingBackingAllocations = 1 },
    r => { r.native.remainingSecurityDescriptors = 1 }, r => { r.native.inheritanceObservation.inheritableStorageHandles = 1 },
    r => { r.native.inheritanceObservation.status = 'unverified' }, r => { r.native.inheritanceObservation.checkedStorageHandles = 0 },
    r => { r.native.remainingStorageCapabilities = 1 }, r => { r.native.remainingTokenHandles = 1 },
    r => { r.native.pendingContexts = 1 }, r => { r.native.unconfirmedReleases = 1 },
    r => { r.native.observationLayer = 'raw-syscall-trace' }, r => { r.native.counterObservation = 'concurrent-snapshot' },
    r => { r.native.protocolViolations.push('duplicate close') }, r => { r.releaseErrors.push('release uncertain') },
    r => { r.native.faults = [{ origin: 'actual-native-failure' }] },
    r => { r.observations.invalidManifestCount = 0 }, r => { r.observations.invalidManifestNativeCalls = 1 },
    r => { r.observations.maxFileBytes = 64 * chunkBytes }, r => { r.observations.acceptedMaximumManifestBytes = 0 },
    r => { r.observations = {} },
  ]) {
    const result = structuredClone(original); mutate(result)
    assert.throws(() => validateResult(result, original.scenario, binding, fixtureHash))
  }
})

test('persisted passes require process quiescence and cannot replace explicitly blocked obligations', () => {
  const original = reportFixture(true), result = resultFixture()
  Object.assign(result, { fixtureSourceSha256: original.fixtureSourceSha256,
    processExited: true, streamClosed: true, rootRenamedAfterChildExit: true, sdkRootAfter: sdkFacts() })
  original.results[0] = { name: cases[0], status: 'passed', detail: result }; recount(original)
  assert.equal(validateReport(original), 2)
  for (const mutate of [
    r => { r.results[0].detail.processExited = false }, r => { r.results[0].detail.streamClosed = false },
    r => { r.results[0].detail.rootRenamedAfterChildExit = false }, r => { delete r.results[0].detail.sdkRootAfter },
    r => { r.results[0].detail.nativeOnly = false }, r => { r.results[0].detail.actualStorageFailureClaimed = true },
    r => { r.results[0].detail.accessTimeOrAuditSilenceClaimed = true },
    r => { r.results.at(-1).status = 'passed'; r.results.at(-1).detail = result; recount(r) },
  ]) {
    const report = structuredClone(original); mutate(report); assert.throws(() => validateReport(report))
  }
})

test('zero-byte publication requires an exact verified receipt and independent private SDK facts', () => {
  const result = resultFixture(), sdk = sdkFacts(), hash = digest('')
  result.scenario = 'stream-zero-bytes'
  result.observations = { tokenUserSid: sid, sdkFinal: sdk, fileHash: { sizeBytes: 0, sha256: hash, bufferBytes: chunkBytes },
    writerReceipt: { mechanism: 'windows-ntfs-write-through-rename-v1', release: 'released', outcome: 'finished',
      identity: { backend: 'windows-ntfs', ...sdk.identity }, expectedBytes: 0, acceptedBytes: 0,
      expectedSha256: hash, actualSha256: hash, contentVerification: 'verified', bindingVerification: 'verified',
      metadataVerification: 'verified', publication: 'published', durability: 'synced',
      synchronization: { preFile: 'succeeded', directory: 'not-required', postFile: 'succeeded' } } }
  validateResult(result, result.scenario, binding, fixtureHash)
  for (const mutate of [
    r => { delete r.observations.writerReceipt }, r => { r.observations.writerReceipt.publication = 'indeterminate' },
    r => { r.observations.writerReceipt.durability = 'unconfirmed' },
    r => { r.observations.writerReceipt.synchronization.postFile = 'failed' },
    r => { r.observations.writerReceipt.actualSha256 = '0'.repeat(64) },
    r => { r.observations.fileHash.sizeBytes = 1 }, r => { r.observations.sdkFinal.daclProtected = false },
    r => { r.observations.sdkFinal.aces[0].flags = 3 }, r => { r.observations.sdkFinal.links = 2 },
    r => { r.observations.writerReceipt.identity.fileId = '0'.repeat(32) },
  ]) {
    const copy = structuredClone(result); mutate(copy); assert.throws(() => validateResult(copy, copy.scenario, binding, fixtureHash))
  }
})

test('synthetic content and independent hashes stay bounded, distinguish chunk order and include tails', () => {
  const first = syntheticChunk(0, chunkBytes), second = syntheticChunk(chunkBytes, 37)
  assert.notEqual(digest(first.subarray(0, 37)), digest(second))
  assert.notEqual(digest(Buffer.concat([first, second])), digest(Buffer.concat([second, first])))
  assert.equal(syntheticDigest(0), digest(''))
  assert.equal(syntheticDigest(chunkBytes + 37), digest(Buffer.concat([first, second])))
  assert.throws(() => syntheticChunk(0, chunkBytes + 1))
  assert.throws(() => syntheticDigest(maxBytes + 1))
  const root = mkdtempSync(join(tmpdir(), 'stream-hash-'))
  try {
    const file = join(root, 'small.bin'); writeFileSync(file, Buffer.concat([first, second]))
    assert.deepEqual(hashFile(file), { sizeBytes: chunkBytes + 37, sha256: syntheticDigest(chunkBytes + 37), bufferBytes: chunkBytes })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('source receipts cannot substitute privacy claims for unchanged source identity, descriptor and bytes', () => {
  const result = resultFixture(), sdk = sdkFacts(), hash = digest('')
  result.scenario = 'source-zero-bytes'
  const selected = { identity: { backend: 'windows-ntfs', ...sdk.identity }, sizeBytes: 0, links: 1,
    changeToken: '1'.repeat(64), observations: { securityDescriptorSha256: digest(Buffer.from(sdk.descriptorHex, 'hex')) } }
  result.observations = { tokenUserSid: sid, sourceBefore: sdk, sourceAfter: structuredClone(sdk),
    sourceHashBefore: { sizeBytes: 0, sha256: hash }, sourceHashAfter: { sizeBytes: 0, sha256: hash },
    selectedSourceFacts: selected, expectedSource: { expectedIdentity: selected.identity, expectedBytes: 0, expectedSha256: hash },
    readerReceipt: { outcome: 'finished', verification: 'verified', eof: true,
      actualSha256: hash, observedBytes: 0, release: 'released' } }
  validateResult(result, result.scenario, binding, fixtureHash)
  for (const mutate of [
    r => { delete r.observations.sourceBefore }, r => { r.observations.sourceAfter.descriptorHex = 'ff'.repeat(20) },
    r => { r.observations.sourceHashAfter.sha256 = '0'.repeat(64) },
    r => { r.observations.selectedSourceFacts.identity.fileId = '0'.repeat(32) },
    r => { r.observations.selectedSourceFacts.observations.securityDescriptorSha256 = '0'.repeat(64) },
    r => { r.observations.readerReceipt.eof = false }, r => { r.observations.readerReceipt.verification = 'unverified' },
    r => { r.observations.readerReceipt.actualSha256 = '0'.repeat(64) },
  ]) {
    const copy = structuredClone(result); mutate(copy); assert.throws(() => validateResult(copy, copy.scenario, binding, fixtureHash))
  }
})

test('a write return-loss row requires actual native progress and honest unpublished failure accounting', () => {
  const result = resultFixture()
  result.scenario = 'stream-real-write-return-loss'
  result.native.writeBytes = 173
  result.native.faults = [{ name: 'write', forwarded: true, actualReturn: 173, visibleReturn: 'thrown',
    origin: 'test-owned-return-loss', actualBytes: 173, associatedWin32Error: 29 }]
  result.observations = { tokenUserSid: sid, error: { name: 'PrivateFileWriterError', win32Code: 29, nativeStatus: null },
    terminalNativeCalls: 0, unpublishedRemoved: true,
    writerReceipt: { mechanism: 'windows-ntfs-write-through-rename-v1', release: 'released', outcome: 'failed',
      synchronization: { directory: 'not-required' }, acceptedBytes: 0, observedSizeBytes: 173,
      publication: 'not-published', durability: 'unconfirmed' } }
  validateResult(result, result.scenario, binding, fixtureHash)
  for (const mutate of [
    r => { r.native.faults[0].name = 'read' }, r => { r.native.faults[0].actualReturn = 0 },
    r => { r.native.faults[0].actualBytes = 0 }, r => { r.native.faults[0].forwarded = false },
    r => { r.observations.writerReceipt.acceptedBytes = 173 }, r => { r.observations.writerReceipt.observedSizeBytes = 0 },
    r => { r.observations.writerReceipt.publication = 'published' }, r => { r.observations.unpublishedRemoved = false },
    r => { r.observations.error.win32Code = null },
  ]) {
    const copy = structuredClone(result); mutate(copy); assert.throws(() => validateResult(copy, copy.scenario, binding, fixtureHash))
  }
})

test('the SDK record refuses substituted executable bytes, source, architecture or compiler output', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-sdk-record-'))
  try {
    const program = join(root, 'oracle.exe'), compiler = join(root, 'compiler.log'), record = join(root, 'oracle-build.json')
    writeFileSync(program, 'portable bytes, not an executable'); writeFileSync(compiler, 'portable log')
    const build = { architecture: 'x64', sourceSha256: sourceBinding().files['windows-oracle.c'],
      binarySha256: digest(readFileSync(program)), compilerLogSha256: digest(readFileSync(compiler)) }
    writeFileSync(record, JSON.stringify(build)); assert.equal(oracleBinding(program).oracleSha256, build.binarySha256)
    for (const field of Object.keys(build)) {
      writeFileSync(record, JSON.stringify({ ...build, [field]: 'wrong' })); assert.throws(() => oracleBinding(program))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('malformed output and missing completion are bounded and the exact owned process settles', async () => {
  for (const code of ["console.log('not-json');setInterval(()=>{},1000)", "console.log(JSON.stringify({event:'ready'}));setInterval(()=>{},1000)"]) {
    const child = startChild(process.execPath, ['-e', code], fixtureEnvironment(tmpdir(), tmpdir()), { closeTimeoutMs: 5000 })
    try {
      if (code.includes('not-json')) await assert.rejects(child.next(5000), SyntaxError)
      else { assert.deepEqual(await child.next(5000), { event: 'ready' }); await assert.rejects(child.next(25), /timed out/u) }
    } finally { await child.kill() }
    assert.equal(child.settled, true)
  }
})

test('duplicate result messages cannot satisfy the one-result protocol after normal process exit', async () => {
  const child = startChild(process.execPath, ['-e', "console.log(JSON.stringify({event:'result'}));console.log(JSON.stringify({event:'result'}))"],
    fixtureEnvironment(tmpdir(), tmpdir()))
  try {
    assert.equal((await child.next()).event, 'result'); await child.complete()
    await assert.rejects(async () => { await assert.rejects(child.next(1), /already exited/u) })
  } finally { await child.kill() }
  assert.equal(child.settled, true)
})

test('live-delete controls require actual sharing errors, successful independent reads and post-release positive controls', () => {
  const retained = { event: 'access-result', completed: true, mode: 'retained', ...binding, fixtureSourceSha256: fixtureHash,
    deleteOpen: { desiredAccess: 0x10000, shareAccess: 7, actualReturn: 'invalid-handle', opened: false, win32Error: 32 },
    rename: { actualReturn: 0, win32Error: 32 }, restore: null,
    read: { desiredAccess: 0x120081, shareAccess: 7, opened: true, actualReturn: 1, bytes: 0, sha256: digest('') },
    remainingHandles: 0, closeFailures: [] }
  const released = { ...structuredClone(retained), mode: 'released',
    deleteOpen: { desiredAccess: 0x10000, shareAccess: 7, actualReturn: 'valid-owned-handle', opened: true, win32Error: null },
    rename: { actualReturn: 1, win32Error: null }, restore: { actualReturn: 1, win32Error: null } }
  validateAccessProbe(retained, false, binding, fixtureHash); validateAccessProbe(released, true, binding, fixtureHash)
  for (const mutate of [
    r => { r.deleteOpen.opened = true }, r => { r.deleteOpen.win32Error = 5 },
    r => { r.deleteOpen.desiredAccess = 1 }, r => { r.rename.actualReturn = 1 },
    r => { r.rename.win32Error = 2 }, r => { r.read.opened = false }, r => { r.read.actualReturn = 0 },
    r => { r.read.bytes = chunkBytes + 1 }, r => { r.remainingHandles = 1 },
    r => { r.closeFailures.push({ actualReturn: 0, win32Error: 6 }) },
  ]) {
    const copy = structuredClone(retained); mutate(copy)
    assert.throws(() => validateAccessProbe(copy, false, binding, fixtureHash))
  }
  const copy = structuredClone(released); copy.restore.actualReturn = 0
  assert.throws(() => validateAccessProbe(copy, true, binding, fixtureHash))
})

test('non-Windows CLI retains every required row, imports no candidate and creates no large files',
  { skip: process.platform === 'win32' && process.arch === 'x64' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-portable-'))
    try {
      const entry = join(root, 'index.js'), sdk = join(root, 'oracle.exe'), output = join(root, 'report.json')
      writeFileSync(entry, "throw new Error('candidate must not be imported')")
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('stream-matrix.mjs', import.meta.url)),
        '--entry', entry, '--oracle', sdk, '--output', output], { env: fixtureEnvironment(root, root), encoding: 'utf8', timeout: 10_000 })
      assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 2, child.stderr)
      const report = JSON.parse(readFileSync(output, 'utf8'))
      assert.equal(validateReport(report), 2); assert.equal(report.nativeExecution, false)
      assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 56 })
      assert.match(report.prerequisiteFailure, /actual Windows x64/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
