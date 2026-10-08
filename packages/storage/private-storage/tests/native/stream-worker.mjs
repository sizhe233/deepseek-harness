/** Actual Windows x64 packed-entry stream/source cases, each inside one bounded owned process. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, fileDigest, oracle } from './boundary-support.mjs'
import { caseBytes, cases, chunkBytes, hashFile, installedBinding, largeCases, maxBytes, sourceBinding, syntheticChunk, syntheticDigest } from './stream-support.mjs'
import { observeNative } from './stream-observer.mjs'

const [entry, sdk, rootPath, scenario, preflightJson] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.ok(cases.includes(scenario))
const binding = installedBinding(entry), fixture = sourceBinding()
const require = createRequire(entry), observer = observeNative(entry, dirname(sdk), rootPath)
const streamsPath = require.resolve('@deepseek-ai/dsh-private-storage/streams')
const storage = await import(pathToFileURL(entry).href)
const streams = await import(pathToFileURL(streamsPath).href)
const inspect = path => oracle(sdk, process.env, 'inspect', path)
const token = oracle(sdk, process.env, 'token')
const finalPath = join(rootPath, 'result.bin'), sourcePath = join(rootPath, 'source.bin')
const observations = { tokenUserSid: token.userSid }, releaseErrors = [], owned = []
const own = resource => { owned.push(resource); return resource }
const errorFacts = error => ({ name: error.name, message: error.message, code: error.code ?? null,
  nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null, cleanupFailed: error.cleanupFailed ?? false })
const reject = operation => {
  try { operation() } catch (error) { return error }
  assert.fail('Operation must reject this fixture')
}
const manifest = (length, hash = syntheticDigest(length)) => ({ operationId: `synthetic:${scenario}`,
  expectedBytes: length, expectedSha256: hash, replace: false, executable: false })
const append = (writer, length) => {
  for (let offset = 0; offset < length; offset += chunkBytes) writer.append(syntheticChunk(offset, Math.min(chunkBytes, length - offset)))
}
function liveBarrier(name) {
  writeSync(1, `${JSON.stringify({ event: 'retained-ready', scenario, name, ...binding, fixtureSourceSha256: fixture.sha256 })}\n`)
  assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1, 'Controller must complete live independent probes before resuming')
  observations.liveAccessBarrier = true
}
function checkPrivate(facts, directory = false) {
  assert.equal(facts.ownerSid, token.userSid)
  assert.equal(facts.daclPresent, true); assert.equal(facts.daclNull, false); assert.equal(facts.daclProtected, true)
  assert.equal(facts.directory, directory); assert.equal(facts.reparseTag, 0)
  if (!directory) assert.equal(facts.links, 1)
  assert.deepEqual(facts.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })),
    [{ type: 0, flags: directory ? 3 : 0, mask: 0x001f01ff, sid: token.userSid }])
}
function finalFacts(writer) {
  observations.writerReceipt = writer.receipt
  observations.sdkFinal = inspect(finalPath); checkPrivate(observations.sdkFinal)
  observations.fileHash = hashFile(finalPath)
  assert.equal(observations.fileHash.sha256, writer.receipt.expectedSha256)
  assert.equal(observations.fileHash.sizeBytes, writer.receipt.expectedBytes)
}
function failedWriter(writer, operation) {
  const error = reject(operation)
  assert.equal(error.name, 'PrivateFileWriterError')
  observations.error = errorFacts(error); observations.writerReceipt = error.receipt
  assert.deepEqual(writer.receipt, error.receipt)
  const calls = observer.snapshot().nativeCalls
  assert.equal(reject(() => writer.finish()), error, 'Failed finish must rethrow its original error')
  writer.abort(); writer.close(); writer.close()
  assert.equal(observer.snapshot().nativeCalls, calls, 'Terminal writer calls must not touch native resources')
  observations.terminalNativeCalls = 0
  return error
}
function absentAfterFailure(writer) {
  assert.equal(existsSync(finalPath), false)
  assert.equal(existsSync(join(rootPath, writer.receipt.stagingName)), false)
  observations.unpublishedRemoved = true
}
function denyParentRename() {
  const moved = `${rootPath}-retained`
  const error = reject(() => renameSync(rootPath, moved))
  assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code), `Unexpected retained-parent error: ${error.code}`)
  observations.parentRenameDeniedWhileRetained = true
  observations.parentRenameError = errorFacts(error)
}
function afterParentRelease() {
  const moved = `${rootPath}-released`
  renameSync(rootPath, moved); renameSync(moved, rootPath)
  observations.parentRenamedAfterRelease = true
}
function successfulWriter(root, length = caseBytes(scenario), factory = streams.createPrivateFileWriter) {
  const writer = own(factory(root, 'result.bin', manifest(length)))
  append(writer, length)
  const receipt = writer.finish()
  assert.equal(receipt.outcome, 'finished')
  finalFacts(writer)
  return writer
}

async function writerCase() {
  const root = own(storage.openPrivateDirectory(rootPath, { create: false }))
  checkPrivate(inspect(rootPath), true)
  if (scenario === 'stream-manifest-limits') {
    assert.equal(streams.MAX_STREAM_CHUNK_BYTES, chunkBytes); assert.equal(streams.MAX_STREAM_FILE_BYTES, maxBytes)
    const base = manifest(0), before = observer.snapshot().nativeCalls
    const invalid = [
      ...[-1, 0.5, NaN, Infinity, maxBytes + 1].map(expectedBytes => ({ ...base, expectedBytes })),
      ...['', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)].map(expectedSha256 => ({ ...base, expectedSha256 })),
      { ...base, replace: true }, { ...base, executable: 'false' },
      ...['', 'x'.repeat(257), 'bad\nidentifier'].map(operationId => ({ ...base, operationId })),
    ]
    for (const value of invalid) assert.ok(reject(() => streams.createPrivateFileWriter(root, 'invalid.bin', value)) instanceof Error)
    assert.equal(observer.snapshot().nativeCalls, before)
    assert.deepEqual(readdirSync(rootPath), [])
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', { ...base, expectedBytes: maxBytes }))
    assert.equal(writer.receipt.expectedBytes, maxBytes); assert.equal(writer.receipt.acceptedBytes, 0)
    writer.abort()
    observations.invalidManifestCount = invalid.length; observations.invalidManifestNativeCalls = 0
    observations.acceptedMaximumManifestBytes = writer.receipt.expectedBytes
    observations.maxChunkBytes = streams.MAX_STREAM_CHUNK_BYTES; observations.maxFileBytes = streams.MAX_STREAM_FILE_BYTES
    observations.writerReceipt = writer.receipt
  } else if (scenario === 'stream-chunk-limits') {
    observations.rejections = []
    for (const bytes of [new Uint8Array(0), new Uint8Array(chunkBytes + 1), new Uint8Array(new SharedArrayBuffer(1))]) {
      const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(chunkBytes)))
      const before = observer.snapshot().writeBytes
      const error = reject(() => writer.append(bytes))
      assert.equal(error.name, 'PrivateFileWriterError'); assert.equal(observer.snapshot().writeBytes, before)
      absentAfterFailure(writer)
      observations.rejections.push({ length: bytes.byteLength, shared: bytes.buffer instanceof SharedArrayBuffer,
        error: errorFacts(error), acceptedBytes: writer.receipt.acceptedBytes, nativeWrittenBytes: 0 })
    }
  } else if (scenario === 'stream-legacy-byte-limit') {
    const bytes = Buffer.from('synthetic legacy byte API')
    storage.createPrivateFileExclusive(root, 'legacy.bin', bytes)
    assert.deepEqual(Buffer.from(storage.readPrivateFile(root, 'legacy.bin', 64 * chunkBytes)), bytes)
    const before = observer.snapshot().nativeCalls
    const error = reject(() => storage.readPrivateFile(root, 'legacy.bin', 64 * chunkBytes + 1))
    assert.equal(error.code, 'limit'); assert.equal(observer.snapshot().nativeCalls, before)
    const oversized = new Uint8Array(64 * chunkBytes + 1)
    const exclusiveError = reject(() => storage.createPrivateFileExclusive(root, 'too-large.bin', oversized))
    const replaceError = reject(() => storage.replacePrivateFile(root, 'legacy.bin', oversized))
    assert.equal(exclusiveError.code, 'limit'); assert.equal(replaceError.code, 'limit')
    assert.equal(observer.snapshot().nativeCalls, before)
    observations.legacyMaximumReadBytes = 64 * chunkBytes; observations.oversizedReadNativeCalls = 0
    observations.legacyOversizedWriteBytes = oversized.byteLength; observations.oversizedWriteNativeCalls = 0
    observations.legacyWriteErrors = [errorFacts(exclusiveError), errorFacts(replaceError)]
    observations.legacyReadError = errorFacts(error)
  } else if (scenario === 'stream-distinct-multiappend' || scenario === 'stream-digest-order-mismatch') {
    const parts = [Buffer.from('first distinct piece\n'), Buffer.from([0, 255, 2, 129, 17]), Buffer.from('third tail differs\n')]
    const bytes = Buffer.concat(parts), writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(bytes.length, digest(bytes))))
    for (const part of scenario.endsWith('mismatch') ? [parts[2], parts[1], parts[0]] : parts) writer.append(part)
    observations.appendDigests = parts.map(digest)
    observations.actualAppendDigests = (scenario.endsWith('mismatch') ? parts.toReversed() : parts).map(digest)
    if (scenario.endsWith('mismatch')) { failedWriter(writer, () => writer.finish()); absentAfterFailure(writer) }
    else { writer.finish(); finalFacts(writer) }
  } else if (scenario === 'stream-short-manifest' || scenario === 'stream-overlong-input') {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    if (scenario.endsWith('short-manifest')) { writer.append(syntheticChunk(0, 172)); failedWriter(writer, () => writer.finish()) }
    else failedWriter(writer, () => writer.append(syntheticChunk(0, 174)))
    absentAfterFailure(writer)
  } else if (scenario === 'stream-preexisting-file-preserved' || scenario === 'stream-publication-collision-preserved') {
    let writer
    if (scenario.includes('publication-collision')) writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    oracle(sdk, process.env, 'create', finalPath, 'file', 'private')
    writeFileSync(finalPath, 'synthetic preexisting destination\n')
    observations.existingBefore = inspect(finalPath); observations.existingHashBefore = hashFile(finalPath)
    if (writer) {
      append(writer, 173); failedWriter(writer, () => writer.finish())
      assert.equal(writer.receipt.publication, 'not-published')
      assert.equal(existsSync(join(rootPath, writer.receipt.stagingName)), false)
    } else {
      const error = reject(() => streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
      assert.equal(error.code, 'collision'); observations.error = errorFacts(error)
      assert.deepEqual(readdirSync(rootPath), ['result.bin'])
    }
    observations.existingAfter = inspect(finalPath); observations.existingHashAfter = hashFile(finalPath)
    assert.deepEqual(observations.existingAfter, observations.existingBefore)
    assert.deepEqual(observations.existingHashAfter, observations.existingHashBefore)
  } else if (scenario === 'stream-private-before-first-byte') {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    observations.sdkBeforeFirstByte = inspect(join(rootPath, writer.receipt.stagingName))
    checkPrivate(observations.sdkBeforeFirstByte)
    observations.nativeWritesBeforeFirstByte = observer.snapshot().writeBytes
    assert.equal(observations.nativeWritesBeforeFirstByte, 0)
    append(writer, 173); writer.finish(); finalFacts(writer)
    assert.deepEqual(observations.sdkFinal.identity, observations.sdkBeforeFirstByte.identity)
  } else if (scenario === 'stream-retained-parent-after-close') {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    root.close(); denyParentRename()
    append(writer, 173); writer.finish(); finalFacts(writer); afterParentRelease()
  } else if (scenario === 'stream-live-staging-denies-delete') {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    liveBarrier(writer.receipt.stagingName)
    append(writer, 173); writer.finish(); finalFacts(writer)
  } else if (scenario === 'stream-abort-removes-unpublished' || scenario === 'stream-close-keeps-unpublished') {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    append(writer, 173)
    const staging = join(rootPath, writer.receipt.stagingName)
    observations.stagingBefore = inspect(staging); observations.stagingHashBefore = hashFile(staging)
    if (scenario.includes('abort-')) { writer.abort(); absentAfterFailure(writer) }
    else {
      writer.close(); assert.equal(existsSync(finalPath), false)
      observations.stagingAfter = inspect(staging); observations.stagingHashAfter = hashFile(staging)
      assert.deepEqual(observations.stagingAfter, observations.stagingBefore)
      assert.deepEqual(observations.stagingHashAfter, observations.stagingHashBefore)
    }
    const calls = observer.snapshot().nativeCalls
    writer.close(); writer.close(); writer.abort()
    assert.equal(observer.snapshot().nativeCalls, calls)
    observations.terminalNativeCalls = 0; observations.writerReceipt = writer.receipt
  } else if (scenario === 'stream-finish-cached') {
    const writer = successfulWriter(root), before = writer.receipt, calls = observer.snapshot().nativeCalls
    assert.deepEqual(writer.finish(), before); assert.deepEqual(writer.abort(), before); writer.close(); writer.close()
    assert.equal(observer.snapshot().nativeCalls, calls); observations.terminalNativeCalls = 0
    assert.equal(reject(() => writer.append(Buffer.from('closed'))).name, 'PrivateFileWriterError')
  } else if (scenario === 'stream-root-streams-interoperability') {
    assert.equal(storage.createPrivateFileWriter, streams.createPrivateFileWriter)
    successfulWriter(root)
    observations.rootCapabilityAcceptedByStreams = true
  } else if (scenario === 'stream-foreign-copy-rejected') {
    const copy = join(rootPath, 'foreign-package'), library = join(copy, 'lib')
    mkdirSync(library, { recursive: true })
    copyFileSync(join(dirname(dirname(entry)), 'package.json'), join(copy, 'package.json'))
    observations.copiedRuntimeHashes = {}
    for (const name of ['index.js', 'streams.js']) {
      copyFileSync(join(dirname(entry), name), join(library, name))
      observations.copiedRuntimeHashes[name] = fileDigest(join(library, name))
      assert.equal(observations.copiedRuntimeHashes[name], fileDigest(join(dirname(entry), name)))
    }
    const foreign = await import(pathToFileURL(join(library, 'streams.js')).href)
    assert.notEqual(foreign.createPrivateFileWriter, streams.createPrivateFileWriter)
    const source = own(streams.openSourceDirectory(rootPath)), before = observer.snapshot().nativeCalls
    const writerError = reject(() => foreign.createPrivateFileWriter(root, 'result.bin', manifest(0)))
    assert.equal(writerError.code, 'closed')
    const readerError = reject(() => foreign.openSourceFileReader(source, 'source.bin', {
      expectedIdentity: source.identity, expectedBytes: 0, expectedSha256: digest(''),
    }))
    assert.equal(readerError.code, 'closed')
    assert.equal(observer.snapshot().nativeCalls, before)
    observations.foreignWriterRejected = true; observations.foreignSourceRejected = true; observations.foreignNativeCalls = 0
    observations.foreignWriterError = errorFacts(writerError); observations.foreignSourceError = errorFacts(readerError)
  } else if (scenario.includes('-real-')) {
    const writer = own(streams.createPrivateFileWriter(root, 'result.bin', manifest(173)))
    observer.arm(scenario)
    if (scenario === 'stream-real-write-return-loss') {
      failedWriter(writer, () => append(writer, 173)); absentAfterFailure(writer)
      assert.equal(writer.receipt.acceptedBytes, 0); assert.equal(writer.receipt.observedSizeBytes, observer.snapshot().faults[0].actualBytes)
    } else {
      append(writer, 173); failedWriter(writer, () => writer.finish())
      assert.equal(writer.receipt.publication, 'published'); assert.equal(writer.receipt.cleanup, 'withheld')
      finalFacts(writer)
    }
  } else {
    if (Object.hasOwn(largeCases, scenario)) {
      observations.preflight = JSON.parse(preflightJson)
      assert.equal(observations.preflight.fileBytes, largeCases[scenario]); assert.equal(observations.preflight.sequential, true)
    }
    successfulWriter(root)
  }
}

function sourceCase() {
  const length = caseBytes(scenario), bytes = syntheticChunk(0, Math.min(chunkBytes, length))
  oracle(sdk, process.env, 'create', sourcePath, 'file', scenario === 'source-shared-readable' ? 'public' : 'private')
  if (length <= chunkBytes) writeFileSync(sourcePath, bytes)
  else writeFileSync(sourcePath, Buffer.concat([bytes, syntheticChunk(chunkBytes, length - chunkBytes)]))
  if (scenario === 'source-readonly-file') chmodSync(sourcePath, 0o444)
  if (scenario === 'source-hardlink') oracle(sdk, process.env, 'hardlink', join(rootPath, 'source-alias.bin'), sourcePath)
  observations.sourceBefore = inspect(sourcePath); observations.sourceHashBefore = hashFile(sourcePath)
  const source = own(streams.openSourceDirectory(rootPath))
  const selected = streams.inspectSourceFile(source, 'source.bin')
  observations.selectedSourceFacts = selected
  assert.deepEqual(selected.identity, { backend: 'windows-ntfs', ...observations.sourceBefore.identity })
  assert.equal(selected.sizeBytes, length)
  const expected = { expectedIdentity: selected.identity, expectedBytes: length, expectedSha256: observations.sourceHashBefore.sha256 }
  if (scenario === 'source-identity-mismatch') expected.expectedIdentity = { ...selected.identity,
    fileId: `${selected.identity.fileId[0] === '0' ? '1' : '0'}${selected.identity.fileId.slice(1)}` }
  if (scenario === 'source-size-mismatch') expected.expectedBytes++
  if (scenario === 'source-digest-mismatch') expected.expectedSha256 = digest('deliberately different synthetic source')
  observations.expectedSource = expected
  if (scenario === 'source-manifest-limits') {
    const invalid = [
      ...[-1, 0.5, NaN, Infinity, maxBytes + 1].map(expectedBytes => ({ ...expected, expectedBytes })),
      ...['', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)].map(expectedSha256 => ({ ...expected, expectedSha256 })),
    ]
    const before = observer.snapshot().nativeCalls
    for (const value of invalid) reject(() => streams.openSourceFileReader(source, 'source.bin', value))
    assert.equal(observer.snapshot().nativeCalls, before)
    observations.invalidManifestCount = invalid.length; observations.invalidManifestNativeCalls = 0
    const error = reject(() => streams.openSourceFileReader(source, 'source.bin', { ...expected, expectedBytes: maxBytes }))
    assert.equal(error.name, 'SourceFileReaderError'); assert.equal(error.receipt.expectedBytes, maxBytes)
    observations.acceptedMaximumManifestBytes = maxBytes
    observations.maximumManifestNativeCalls = observer.snapshot().nativeCalls - before
    observations.maximumManifestReceipt = error.receipt
  } else if (scenario === 'source-identity-mismatch' || scenario === 'source-size-mismatch') {
    const error = reject(() => streams.openSourceFileReader(source, 'source.bin', expected))
    assert.equal(error.name, 'SourceFileReaderError'); observations.error = errorFacts(error); observations.readerReceipt = error.receipt
  } else if (scenario === 'source-chunk-limits') {
    observations.rejections = []
    for (const bound of [0, -1, 0.5, chunkBytes + 1]) {
      const reader = own(streams.openSourceFileReader(source, 'source.bin', expected)), before = observer.snapshot().readBytes
      const error = reject(() => reader.readChunk(bound))
      assert.equal(error.name, 'SourceFileReaderError'); assert.equal(observer.snapshot().readBytes, before)
      observations.rejections.push({ bound, error: errorFacts(error), nativeReadBytes: 0, receipt: error.receipt })
    }
  } else {
    const reader = own(streams.openSourceFileReader(source, 'source.bin', expected))
    if (scenario === 'source-live-reader-denies-delete') liveBarrier('source.bin')
    if (scenario === 'source-retained-parent-after-close') { source.close(); denyParentRename() }
    if (scenario.includes('-real-')) observer.arm(scenario)
    if (scenario === 'source-attributes-change-detected') {
      chmodSync(sourcePath, 0o444)
      observations.sourceDuringMutation = inspect(sourcePath)
      assert.notEqual(observations.sourceDuringMutation.attributes, observations.sourceBefore.attributes)
      const error = reject(() => reader.readChunk(chunkBytes))
      assert.equal(error.name, 'SourceFileReaderError'); assert.equal(error.receipt.observations, 'failed')
      observations.error = errorFacts(error); observations.readerReceipt = error.receipt
      chmodSync(sourcePath, 0o666)
    } else if (scenario === 'source-close-preserves') {
      reader.readChunk(17); reader.close(); observations.readerReceipt = reader.receipt
      assert.equal(reader.receipt.verification, 'unverified')
    } else if (scenario === 'source-incomplete-finish') {
      reader.readChunk(17)
      const error = reject(() => reader.finish())
      assert.equal(error.name, 'SourceFileReaderError'); observations.error = errorFacts(error); observations.readerReceipt = error.receipt
    } else {
      const hash = createHash('sha256'); let observedBytes = 0
      try {
        for (;;) {
          const part = reader.readChunk(chunkBytes)
          if (part.byteLength === 0) break
          assert.ok(part.byteLength <= chunkBytes); observedBytes += part.byteLength; hash.update(part)
          part.fill(0xee)
        }
        observations.independentReadHash = hash.digest('hex'); observations.independentReadBytes = observedBytes
        observations.readerReceipt = reader.finish()
        assert.equal(observations.independentReadHash, expected.expectedSha256)
        assert.deepEqual(reader.finish(), observations.readerReceipt)
        assert.equal(scenario.includes('-real-') || scenario === 'source-digest-mismatch', false, 'Expected source failure did not occur')
      } catch (error) {
        if (!(scenario.includes('-real-') || scenario === 'source-digest-mismatch')) throw error
        assert.equal(error.name, 'SourceFileReaderError'); observations.error = errorFacts(error); observations.readerReceipt = error.receipt
      }
    }
    const before = observer.snapshot().nativeCalls
    reader.close(); reader.close()
    assert.equal(observer.snapshot().nativeCalls, before)
    observations.terminalNativeCalls = 0
    if (scenario === 'source-retained-parent-after-close') afterParentRelease()
  }
  observations.sourceAfter = inspect(sourcePath); observations.sourceHashAfter = hashFile(sourcePath)
  assert.deepEqual(observations.sourceAfter, observations.sourceBefore)
  assert.deepEqual(observations.sourceHashAfter, observations.sourceHashBefore)
  if (scenario === 'source-shared-readable') assert.ok(observations.sourceBefore.aces.some(ace => ace.sid !== token.userSid))
}

let completed = false, failure
try {
  assert.equal(storage.capabilities().available, true)
  assert.equal(storage.capabilities().nativeArtifact.nativeBinarySha256, binding.nativeBinarySha256)
  if (scenario.startsWith('source-')) sourceCase()
  else await writerCase()
  completed = true
} catch (error) { failure = errorFacts(error) }
finally {
  for (const resource of owned.toReversed()) {
    try { resource.close() } catch (error) { releaseErrors.push(errorFacts(error)) }
  }
  observer.restore()
}
writeSync(1, `${JSON.stringify({ event: 'result', scenario, ...binding, fixtureSourceSha256: fixture.sha256,
  completed, failure, observations, native: observer.snapshot(), releaseErrors,
  nativeOnly: true, actualStorageFailureClaimed: false, accessTimeOrAuditSilenceClaimed: false })}\n`)
