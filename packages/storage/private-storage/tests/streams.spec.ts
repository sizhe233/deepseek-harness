/** Injected stream-state conformance; these tests never establish native filesystem acceptance. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createBoundedFileWriter, PrivateFileWriterError } from '../src/stream-writer.ts'
import { createBoundedSourceReader, SourceFileReaderError } from '../src/source-reader.ts'
import { MAX_STREAM_CHUNK_BYTES, MAX_STREAM_FILE_BYTES, sameStreamIdentity, validateStreamIdentity } from '../src/stream-policy.ts'
import { PrivateStorageError } from '../src/error.ts'
import { primaryStreamFailure, PrivateStreamError, SourceObservationError } from '../src/stream-error.ts'
import type { StreamFileFacts, StreamWriterResource } from '../src/stream-native.ts'
import type { PrivateFileWriterOptions, PrivateStreamOperationId, SourceFileFacts, StreamMechanism } from '../src/stream-types.ts'

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const id = Object.freeze({ backend: 'posix' as const, device: '7', inode: '9' })
const parentId = Object.freeze({ backend: 'posix' as const, device: '7', inode: '8' })
const bytes = Buffer.from('first/second')
const options = (data = bytes): PrivateFileWriterOptions => ({
  operationId: brandString<PrivateStreamOperationId>('synthetic-stream'),
  expectedBytes: data.length, expectedSha256: sha(data), replace: false, executable: false,
})
function writerFixture(mechanism: StreamMechanism = 'linux-file-directory-fsync-v1') {
  const calls: string[] = []
  const state = { data: Buffer.alloc(0), executable: false, published: false, removed: false, released: false,
    privateVerified: true, fault: '', reconcile: 'published' as 'published' | 'not-published' | 'indeterminate',
    closeCount: 0, writeCount: 0, target: null as Buffer | null }
  const fault = (phase: string): void => { if (state.fault === phase) throw new Error(`injected ${phase}`) }
  const inspect = (): StreamFileFacts => ({ identity: id, parentIdentity: parentId, sizeBytes: state.data.length,
    links: 1, privateVerified: state.privateVerified, executable: mechanism === 'windows-ntfs-write-through-rename-v1' ? null : state.executable })
  const resource: StreamWriterResource = {
    mechanism, stagingName: '.dsh-private-synthetic', inspect,
    write: (chunk) => {
      calls.push('write'); state.writeCount++
      if (state.fault === 'partial') {
        state.data = Buffer.concat([state.data, chunk.subarray(0, 2)])
        throw Object.assign(new Error('injected partial write'), { confirmedBytes: 2 })
      }
      fault('write'); state.data = Buffer.concat([state.data, chunk])
    },
    setExecutable: (value) => { calls.push('metadata'); fault('metadata'); state.executable = value },
    syncFile: () => { calls.push('file-sync'); fault(state.published ? 'post-sync' : 'pre-sync') },
    syncDirectory: () => { calls.push('directory-sync'); fault('directory-sync') },
    publish: () => {
      calls.push('publish'); fault('before-publish')
      if (state.target !== null) throw new Error('destination exists')
      state.published = true; state.target = Buffer.from(state.data); fault('lost-ack')
    },
    reconcile: () => { calls.push('reconcile'); fault('reconcile'); return state.reconcile },
    verifyFinal: () => { calls.push('verify-final'); fault('verify-final'); return inspect() },
    removeUnpublished: () => { calls.push('remove'); fault('remove'); expect(state.published).toBe(false); state.removed = true; return { deletion: 'removed', directorySynced: true } },
    close: () => { calls.push('close'); state.closeCount++; state.released = true; fault('close') },
  }
  return { state, calls, resource, make: (expected = options()) => createBoundedFileWriter('final.bin', expected, mechanism, () => resource) }
}
function sourceFixture(data = bytes) {
  const state = { data: Buffer.from(data), cursor: 0, token: 'initial', closed: 0, readCount: 0, shared: false, closeFails: false }
  const facts = (): SourceFileFacts => ({ identity: id, sizeBytes: data.length, links: 2, changeToken: state.token,
    observations: { mode: 0o100444, mtimeNs: state.token, readOnly: true } })
  const resource = {
    inspect: facts,
    read: (count: number) => {
      state.readCount++
      const chunk = Buffer.from(state.data.subarray(state.cursor, state.cursor + count)); state.cursor += chunk.length
      if (state.shared) return new Uint8Array(new SharedArrayBuffer(chunk.length))
      return chunk
    },
    close: () => { state.closed++; if (state.closeFails) throw new Error('injected close') },
  }
  return { state, resource, options: { expectedIdentity: id, expectedBytes: data.length, expectedSha256: sha(data) },
    make: () => createBoundedSourceReader({ expectedIdentity: id, expectedBytes: data.length, expectedSha256: sha(data) }, () => resource) }
}

describe('shared bounded writer state', () => {
  it.each(['linux-file-directory-fsync-v1', 'darwin-file-directory-fullsync-v1', 'windows-ntfs-write-through-rename-v1'] as const)
  ('records the exact %s sequence and caches successful completion', (mechanism) => {
    const fixture = writerFixture(mechanism), writer = fixture.make()
    writer.append(bytes.subarray(0, 6)); writer.append(bytes.subarray(6))
    const receipt = writer.finish()
    expect(receipt).toMatchObject({ outcome: 'finished', publication: 'published', durability: 'synced',
      contentVerification: 'verified', bindingVerification: 'verified', metadataVerification: 'verified', release: 'released',
      acceptedBytes: bytes.length, observedSizeBytes: bytes.length, actualSha256: sha(bytes) })
    expect(fixture.state.target).toEqual(bytes)
    const before = [...fixture.calls]
    expect(writer.finish()).toEqual(receipt); writer.close(); expect(writer.abort()).toEqual(receipt)
    expect(fixture.calls).toEqual(before)
    expect(() =>{  writer.append(Buffer.from('x')) }).toThrow(PrivateFileWriterError)
    expect(fixture.calls.filter(value => value === 'file-sync')).toHaveLength(mechanism === 'linux-file-directory-fsync-v1' ? 1 : 2)
    expect(fixture.calls.includes('directory-sync')).toBe(mechanism !== 'windows-ntfs-write-through-rename-v1')
  })

  it('supports empty output and preserves explicit executable policy', () => {
    const fixture = writerFixture(), writer = fixture.make({ ...options(Buffer.alloc(0)), executable: true })
    expect(writer.finish()).toMatchObject({ acceptedBytes: 0, executable: true, metadataVerification: 'verified' })
    expect(fixture.state.executable).toBe(true)
  })

  it('captures immutable expectations before the factory runs', () => {
    const fixture = writerFixture(), expected = options()
    const writer = createBoundedFileWriter('final.bin', expected, fixture.resource.mechanism, () => {
      Object.assign(expected, { expectedBytes: 0, expectedSha256: sha(Buffer.alloc(0)), executable: true }); return fixture.resource
    })
    writer.append(bytes); expect(writer.finish()).toMatchObject({ expectedBytes: bytes.length, executable: false })
  })

  it.each([-1, 0.5, MAX_STREAM_FILE_BYTES + 1, NaN, Infinity])('rejects manifest size %s before creating a resource', (expectedBytes) => {
    let created = false
    expect(() => createBoundedFileWriter('x', { ...options(), expectedBytes }, 'linux-file-directory-fsync-v1', () => {
      created = true; return writerFixture().resource
    })).toThrow(RangeError)
    expect(created).toBe(false)
  })

  it.each([{ expectedSha256: 'A'.repeat(64) }, { operationId: '' }, { replace: true }, { executable: undefined }])
  ('rejects malformed manifest expectations %j before native creation', (change) => {
    let created = false
    const supplied = Object.assign(options(), change)
    expect(() => createBoundedFileWriter('x', supplied, 'linux-file-directory-fsync-v1', () => {
      created = true; return writerFixture().resource
    })).toThrow(TypeError)
    expect(created).toBe(false)
  })

  it.each([Buffer.alloc(0), Buffer.alloc(MAX_STREAM_CHUNK_BYTES + 1), new Uint8Array(new SharedArrayBuffer(2))])
  ('rejects invalid chunk before native write and terminates the writer', (chunk) => {
    const fixture = writerFixture(), writer = fixture.make()
    expect(() =>{  writer.append(chunk) }).toThrow(PrivateFileWriterError)
    expect(fixture.state.writeCount).toBe(0); expect(fixture.state.removed).toBe(true)
    expect(() => writer.finish()).toThrow(PrivateFileWriterError)
    expect(fixture.calls).not.toContain('publish')
  })

  it('accepts exactly 1 MiB and a tail using ordered bounded writes', () => {
    const data = Buffer.alloc(MAX_STREAM_CHUNK_BYTES + 3, 79)
    const fixture = writerFixture(), writer = fixture.make(options(data))
    writer.append(data.subarray(0, MAX_STREAM_CHUNK_BYTES)); writer.append(data.subarray(MAX_STREAM_CHUNK_BYTES))
    expect(writer.finish().actualSha256).toBe(sha(data)); expect(fixture.state.writeCount).toBe(2)
  })

  it('refuses overflow before writing and underflow or wrong digest before rename', () => {
    const overflow = writerFixture(), overflowWriter = overflow.make()
    expect(() =>{  overflowWriter.append(Buffer.alloc(bytes.length + 1)) }).toThrow(); expect(overflow.state.writeCount).toBe(0)
    for (const chunk of [bytes.subarray(0, 1), Buffer.alloc(bytes.length)]) {
      const fixture = writerFixture(), writer = fixture.make(); writer.append(chunk)
      expect(() => writer.finish()).toThrow(PrivateFileWriterError)
      expect(writer.receipt.contentVerification).toBe('failed'); expect(fixture.calls).not.toContain('publish')
    }
  })

  it('distinguishes accepted input from confirmed partial write and observed EOF', () => {
    const fixture = writerFixture(), writer = fixture.make(); fixture.state.fault = 'partial'
    expect(() =>{  writer.append(bytes) }).toThrow(PrivateFileWriterError)
    expect(writer.receipt).toMatchObject({ acceptedBytes: 0, confirmedPartialBytes: 2, observedSizeBytes: 2, publication: 'not-published' })
    const calls = [...fixture.calls]
    expect(() => writer.finish()).toThrow(PrivateFileWriterError); expect(fixture.calls).toEqual(calls)
  })

  it.each(['metadata', 'pre-sync', 'directory-sync', 'verify-final', 'close'])('keeps exact publication facts after %s failure', (fault) => {
    const fixture = writerFixture(), writer = fixture.make(); writer.append(bytes); fixture.state.fault = fault
    expect(() => writer.finish()).toThrow(PrivateFileWriterError)
    const published = ['directory-sync', 'verify-final', 'close'].includes(fault)
    expect(writer.receipt.publication).toBe(published ? 'published' : 'not-published')
    expect(fixture.state.removed).toBe(!published)
    expect(writer.receipt.durability).toBe(fault === 'close' ? 'synced' : 'unconfirmed')
    expect(fixture.state.closeCount).toBe(1)
  })

  it('keeps a known real publication after a lost acknowledgement without retry or deletion', () => {
    const fixture = writerFixture(), writer = fixture.make(); writer.append(bytes); fixture.state.fault = 'lost-ack'
    expect(() => writer.finish()).toThrow(PrivateFileWriterError)
    expect(writer.receipt).toMatchObject({ publication: 'published', durability: 'unconfirmed', cleanup: 'withheld' })
    expect(fixture.calls.filter(value => value === 'publish')).toHaveLength(1)
    expect(writer.abort().publication).toBe('published'); expect(fixture.state.removed).toBe(false)
  })

  it('withholds removal on indeterminate rename and preserves a competing final file on collision', () => {
    const uncertain = writerFixture(), writer = uncertain.make(); writer.append(bytes)
    uncertain.state.fault = 'lost-ack'; uncertain.state.reconcile = 'indeterminate'
    expect(() => writer.finish()).toThrow(); expect(writer.receipt.publication).toBe('indeterminate'); expect(uncertain.state.removed).toBe(false)
    const collision = writerFixture(), loser = collision.make(); loser.append(bytes)
    collision.state.target = Buffer.from('winner'); collision.state.reconcile = 'not-published'
    expect(() => loser.finish()).toThrow(); expect(loser.receipt.publication).toBe('not-published')
    expect(collision.state.target.toString()).toBe('winner'); expect(collision.state.removed).toBe(true)
  })

  it('refuses privacy drift, copies caller chunks and releases exactly once on close or abort', () => {
    const fixture = writerFixture(), writer = fixture.make(); const chunk = Buffer.from(bytes)
    writer.append(chunk); chunk.fill(0); expect(writer.finish().actualSha256).toBe(sha(bytes))
    const drift = writerFixture(), bad = drift.make(); drift.state.privateVerified = false
    expect(() =>{  bad.append(bytes) }).toThrow(); expect(bad.receipt.metadataVerification).toBe('failed'); expect(drift.state.writeCount).toBe(0)
    const abandoned = writerFixture(), open = abandoned.make(); open.append(bytes.subarray(0, 1)); open.close(); open.close()
    expect(open.receipt).toMatchObject({ outcome: 'closed', cleanup: 'withheld', release: 'released' })
    expect(abandoned.state.removed).toBe(false)
    const cancelled = writerFixture(), cancel = cancelled.make()
    expect(cancel.abort().outcome).toBe('aborted'); cancel.abort(); cancel.close()
    expect(cancelled.state.closeCount).toBe(1)
    expect(cancelled.state.removed).toBe(true)
  })
})

describe('shared readonly source state', () => {
  it('accepts shared/read-only source facts and hashes before the caller can mutate each returned chunk', () => {
    const fixture = sourceFixture(), reader = fixture.make()
    const first = reader.readChunk(6); first.fill(0)
    expect(Buffer.from(reader.readChunk(6)).toString()).toBe('second')
    const result = reader.finish()
    expect(result).toMatchObject({ eof: true, verification: 'verified', actualSha256: sha(bytes), release: 'released', outcome: 'finished' })
    expect(result.source.links).toBe(2); const reads = fixture.state.readCount
    expect(reader.finish()).toEqual(result); reader.close()
    expect(fixture.state.readCount).toBe(reads); expect(fixture.state.closed).toBe(1)
  })

  it('certifies an empty stream only after actual EOF', () => {
    const fixture = sourceFixture(Buffer.alloc(0)), reader = fixture.make()
    expect(reader.finish()).toMatchObject({ verification: 'verified', eof: true, observedBytes: 0 }); expect(fixture.state.readCount).toBe(1)
  })

  it('refuses incorrect identity and closes the retained source after admission failure', () => {
    const fixture = sourceFixture()
    expect(() => createBoundedSourceReader({ ...fixture.options, expectedIdentity: { ...id, inode: '999' } }, () => fixture.resource))
      .toThrow(SourceFileReaderError)
    expect(fixture.state.closed).toBe(1)
  })

  it('refuses source mutation, underflow, overflow, wrong hash and shared native buffers', () => {
    for (const mutate of ['token', 'underflow', 'overflow', 'digest', 'shared']) {
      const fixture = sourceFixture(), reader = fixture.make()
      if (mutate === 'token') fixture.state.token = 'changed'
      if (mutate === 'underflow') fixture.state.data = Buffer.alloc(1)
      if (mutate === 'overflow') fixture.state.data = Buffer.alloc(bytes.length + 1)
      if (mutate === 'digest') fixture.state.data = Buffer.alloc(bytes.length)
      if (mutate === 'shared') fixture.state.shared = true
      expect(() => { reader.readChunk(MAX_STREAM_CHUNK_BYTES); reader.finish() }).toThrow(SourceFileReaderError)
      expect(reader.receipt.verification).toBe('failed'); expect(fixture.state.closed).toBe(1)
    }
  })

  it('refuses finish with unread bytes, validates read bounds and never rereads after failure', () => {
    const fixture = sourceFixture(), reader = fixture.make()
    expect(() => reader.finish()).toThrow(SourceFileReaderError)
    const calls = fixture.state.readCount; expect(() => reader.finish()).toThrow(); expect(fixture.state.readCount).toBe(calls)
    const invalid = sourceFixture(), other = invalid.make()
    expect(() => other.readChunk(MAX_STREAM_CHUNK_BYTES + 1)).toThrow(); expect(invalid.state.readCount).toBe(0)
  })

  it('records release failure and close-only abandonment without inventing content verification', () => {
    const fixture = sourceFixture(), reader = fixture.make(); reader.readChunk(bytes.length); fixture.state.closeFails = true
    expect(() => reader.finish()).toThrow(); expect(reader.receipt.release).toBe('failed'); reader.close(); expect(fixture.state.closed).toBe(1)
    const partial = sourceFixture(), abandoned = partial.make(); abandoned.readChunk(1); abandoned.close(); abandoned.close()
    expect(abandoned.receipt).toMatchObject({ outcome: 'closed', verification: 'unverified', release: 'released' })
  })
})

describe('stream failure receipts and native adapter boundaries', () => {
  it('retains creation failure without inventing an object identity or retrying factory work', () => {
    let calls = 0
    try {
      createBoundedFileWriter('x', options(), 'linux-file-directory-fsync-v1', () => { calls++; throw new Error('native creation refused') })
      throw new Error('creation unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateFileWriterError)
      expect((error as PrivateFileWriterError).receipt).toMatchObject({ publication: 'not-published', identity: null, parentIdentity: null })
    }
    expect(calls).toBe(1)
  })

  it('rejects a mismatched adapter and releases its owned staging resource', () => {
    const fixture = writerFixture()
    expect(() => createBoundedFileWriter('x', options(), 'darwin-file-directory-fullsync-v1', () => fixture.resource)).toThrow()
    expect(fixture.state.closeCount).toBe(1); expect(fixture.state.removed).toBe(true)
  })

  it('records failed inspection and cleanup without hiding resource release failures', () => {
    const fixture = writerFixture(), writer = fixture.make()
    fixture.resource.inspect = () => { throw new Error('cannot observe EOF') }
    fixture.resource.removeUnpublished = () => { throw new Error('cannot verify staging binding') }
    fixture.state.fault = 'close'
    expect(() =>{  writer.append(bytes) }).toThrow(PrivateFileWriterError)
    expect(writer.receipt).toMatchObject({ observedSizeBytes: null, cleanup: 'failed', release: 'failed', publication: 'not-published' })
    expect(fixture.state.closeCount).toBe(1)
  })

  it.each(['identity', 'parent', 'size', 'links'])('refuses %s drift before the next write', (change) => {
    const fixture = writerFixture(), writer = fixture.make(), before = fixture.resource.inspect()
    fixture.resource.inspect = () => ({ ...before,
      ...change === 'identity' ? { identity: { ...id, inode: 'replaced' } } : {},
      ...change === 'parent' ? { parentIdentity: { ...parentId, inode: 'replaced' } } : {},
      ...change === 'size' ? { sizeBytes: 1 } : {},
      ...change === 'links' ? { links: 2 } : {},
    })
    expect(() =>{  writer.append(bytes) }).toThrow(); expect(fixture.state.writeCount).toBe(0); expect(fixture.calls).not.toContain('publish')
  })

  it('keeps publication indeterminate when reconciliation itself cannot inspect the names', () => {
    const fixture = writerFixture(), writer = fixture.make(); writer.append(bytes); fixture.state.fault = 'lost-ack'
    fixture.resource.reconcile = () => { throw new Error('unreadable bindings') }
    expect(() => writer.finish()).toThrow()
    expect(writer.receipt).toMatchObject({ publication: 'indeterminate', cleanup: 'withheld', durability: 'unconfirmed' })
    expect(fixture.state.removed).toBe(false)
  })

  it.each(['darwin-file-directory-fullsync-v1', 'windows-ntfs-write-through-rename-v1'] as const)
  ('keeps successful publication but unconfirmed persistence after %s post-sync failure', (mechanism) => {
    const fixture = writerFixture(mechanism), writer = fixture.make(); writer.append(bytes); fixture.state.fault = 'post-sync'
    expect(() => writer.finish()).toThrow()
    expect(writer.receipt).toMatchObject({ publication: 'published', durability: 'unconfirmed', synchronization: { postFile: 'failed' } })
    expect(fixture.state.removed).toBe(false)
  })

  it('records Windows delete-pending separately from removed and preserves manifest executable intent', () => {
    const fixture = writerFixture('windows-ntfs-write-through-rename-v1'), writer = fixture.make({ ...options(), executable: true })
    fixture.resource.removeUnpublished = () => ({ deletion: 'delete-pending', directorySynced: false })
    expect(writer.abort()).toMatchObject({ outcome: 'aborted', cleanup: 'delete-pending', cleanupDurability: 'unconfirmed', executable: true, executableMetadata: 'not-required' })
  })

  it('preserves abort and explicit-close failures without repeating release', () => {
    const cancelled = writerFixture(), aborting = cancelled.make(); cancelled.state.fault = 'remove'
    expect(() => aborting.abort()).toThrow(PrivateFileWriterError); expect(aborting.abort().outcome).toBe('failed')
    expect(cancelled.state.closeCount).toBe(1)
    const abandoned = writerFixture(), closing = abandoned.make(); abandoned.state.fault = 'close'
    expect(() =>{  closing.close() }).toThrow(PrivateFileWriterError); closing.close()
    expect(closing.receipt).toMatchObject({ outcome: 'failed', release: 'failed', cleanup: 'withheld' })
    expect(abandoned.state.closeCount).toBe(1)
  })

  it('releases an unobservable source once even when its release also fails', () => {
    for (const closeFails of [false, true]) {
      const fixture = sourceFixture(); fixture.resource.inspect = () => { throw new Error('cannot inspect') }
      fixture.state.closeFails = closeFails
      expect(() => fixture.make()).toThrow(SourceFileReaderError); expect(fixture.state.closed).toBe(1)
    }
  })

  it('marks failed live source observation and keeps an oversized native return terminal', () => {
    const fixture = sourceFixture(), reader = fixture.make()
    fixture.resource.inspect = () => { throw new Error('observation unavailable') }
    expect(() => reader.readChunk(1)).toThrow(); expect(reader.receipt.observations).toBe('unverified')
    const oversized = sourceFixture(), other = oversized.make()
    oversized.resource.read = count => Buffer.alloc(count + 1)
    expect(() => other.readChunk(1)).toThrow(); expect(other.receipt.verification).toBe('failed')
  })

  it('refuses reads after explicit source closure and retains a close failure', () => {
    const fixture = sourceFixture(), reader = fixture.make(); reader.close()
    expect(() => reader.readChunk(1)).toThrow(SourceFileReaderError)
    const failing = sourceFixture(), other = failing.make(); failing.state.closeFails = true
    expect(() =>{  other.close() }).toThrow(SourceFileReaderError); other.close(); expect(failing.state.closed).toBe(1)
  })
})


describe('platform identity and primary error preservation', () => {
  it('compares complete NTFS and POSIX identities without conflating backends', () => {
    const windows = { backend: 'windows-ntfs' as const, volumeSerial: '1234', fileId: '5678' }
    expect(sameStreamIdentity(windows, { ...windows })).toBe(true)
    expect(sameStreamIdentity(windows, { ...windows, volumeSerial: 'different' })).toBe(false)
    expect(sameStreamIdentity(windows, { ...windows, fileId: 'different' })).toBe(false)
    expect(sameStreamIdentity(windows, id)).toBe(false)
    expect(sameStreamIdentity(id, windows)).toBe(false)
    expect(sameStreamIdentity(id, { ...id, device: 'different' })).toBe(false)
  })
  it('preserves native Windows status/classification and POSIX errno through cleanup aggregation', () => {
    const fixture = writerFixture(), writer = fixture.make()
    const primary = new PrivateStorageError('sharing', 'synthetic write', { nativeStatus: 0xc0000043, win32Code: 32 })
    fixture.resource.write = () => { throw primary }; fixture.state.fault = 'close'
    let failure: unknown
    try { writer.append(bytes) } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'sharing', nativeStatus: 0xc0000043, win32Code: 32, cleanupFailed: true, errno: null, syscall: null })
    expect(failure).toBeInstanceOf(PrivateStreamError)
    expect(failure).not.toBeInstanceOf(PrivateStorageError)
    const source = sourceFixture(), reader = source.make()
    source.resource.read = () => { throw Object.assign(new Error('real-style POSIX failure'), { errno: 5, syscall: 'read' }) }
    source.state.closeFails = true
    expect(() => reader.readChunk(1)).toThrow(SourceFileReaderError)
    try { reader.finish() } catch (error) { expect(error).toMatchObject({ code: 'native', errno: 5, syscall: 'read', cleanupFailed: true }) }
  })
  it('keeps a primary cleanup flag, tolerates an empty aggregate and stops a cyclic aggregate', () => {
    const fixture = writerFixture(), writer = fixture.make()
    fixture.resource.write = () => { throw new PrivateStorageError('native', 'synthetic', { cleanupFailed: true }) }
    try { writer.append(bytes) } catch (error) { expect(error).toMatchObject({ cleanupFailed: true }) }
    const empty = new AggregateError([]); expect(primaryStreamFailure(empty)).toBe(empty)
    const cyclic = new AggregateError([]); cyclic.errors.push(cyclic); expect(primaryStreamFailure(cyclic)).toBe(cyclic)
    expect(primaryStreamFailure(new AggregateError([new AggregateError(['primary'])]))).toBe('primary')
  })
  it('refuses a provider that drops executable metadata before publication', () => {
    const fixture = writerFixture(), writer = fixture.make({ ...options(), executable: true }); writer.append(bytes)
    fixture.resource.setExecutable = () => {}
    expect(() => writer.finish()).toThrow()
    expect(writer.receipt).toMatchObject({ executableMetadata: 'failed', metadataVerification: 'failed', publication: 'not-published' })
  })
  it.each(['x'.repeat(257), 'bad\u0000id'])('rejects unsafe operation correlation before creation', (operationId) => {
    let created = false
    expect(() => createBoundedFileWriter('x', Object.assign(options(), { operationId }), 'linux-file-directory-fsync-v1', () => {
      created = true; return writerFixture().resource
    })).toThrow(TypeError)
    expect(created).toBe(false)
  })
  it('refuses non-byte views before native write', () => {
    const fixture = writerFixture(), writer = fixture.make()
    expect(() =>{  writer.append(new DataView(new ArrayBuffer(2)) as never) }).toThrow()
    expect(fixture.state.writeCount).toBe(0)
  })
})


it('preserves a native EOF failure through finish without wrapping it twice', () => {
  const fixture = sourceFixture(Buffer.alloc(0)), reader = fixture.make()
  const primary = new PrivateStorageError('changed', 'EOF failed', { nativeStatus: 0xc0000001, win32Code: 5 })
  fixture.resource.read = () => { throw primary }
  let first: unknown
  try { reader.finish() } catch (error) { first = error }
  expect(first).toBeInstanceOf(SourceFileReaderError)
  expect(first).toMatchObject({ code: 'changed', nativeStatus: 0xc0000001, win32Code: 5, cause: primary })
  try { reader.finish() } catch (error) { expect(error).toBe(first) }
  expect(fixture.state.closed).toBe(1)
})

it('reports initial source admission and release failures independently without fabricating a receipt', () => {
  const fixture = sourceFixture()
  fixture.resource.inspect = () => { throw new PrivateStorageError('changed', 'inspect failed', { win32Code: 5 }) }
  fixture.state.closeFails = true
  let failure: unknown
  try { fixture.make() } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'changed', win32Code: 5, cleanupFailed: true, receipt: undefined })
  expect(fixture.state.closed).toBe(1)
})

it('preserves a new stream-family primary failure through a later writer settlement', () => {
  const source = sourceFixture(Buffer.alloc(0)), reader = source.make()
  source.resource.read = () => { throw new PrivateStorageError('changed', 'read failed', { win32Code: 5 }) }
  let primary: unknown
  try { reader.finish() } catch (error) { primary = error }
  const output = writerFixture(), writer = output.make()
  output.resource.write = () => { throw primary }
  expect(() =>{  writer.append(bytes) }).toThrow(PrivateFileWriterError)
  try { writer.finish() } catch (error) { expect(error).toMatchObject({ code: 'changed', win32Code: 5 }) }
})


it('distinguishes established native source change from ordinary unobservable I/O failure', () => {
  for (const changed of [true, false]) {
    const fixture = sourceFixture(), reader = fixture.make()
    const primary = new PrivateStorageError(changed ? 'changed' : 'native', 'native read failed', { win32Code: 5 })
    fixture.resource.read = () => { throw changed ? new SourceObservationError(primary) : primary }
    expect(() => reader.readChunk(1)).toThrow(SourceFileReaderError)
    expect(reader.receipt.observations).toBe(changed ? 'failed' : 'unverified')
    try { reader.finish() } catch (error) { expect(error).toMatchObject({ code: changed ? 'changed' : 'native', win32Code: 5 }) }
    expect(fixture.state.closed).toBe(1)
  }
})

it('preserves verified source contents after a late release failure', () => {
  const fixture = sourceFixture(), reader = fixture.make(); reader.readChunk(bytes.length)
  fixture.state.closeFails = true
  expect(() => reader.finish()).toThrow(SourceFileReaderError)
  expect(reader.receipt).toMatchObject({ verification: 'verified', observations: 'unchanged', eof: true,
    actualSha256: sha(bytes), release: 'failed', outcome: 'failed' })
})


it.each([null, undefined, 1, ['0'.repeat(64)], { toString: () => '0'.repeat(64) }])
('rejects non-string digest %j before native creation or opening', (expectedSha256) => {
  let calls = 0
  const create = () => { calls++; return writerFixture().resource }
  expect(() => createBoundedFileWriter('x', Object.assign(options(), { expectedSha256 }), 'linux-file-directory-fsync-v1', create)).toThrow(TypeError)
  const source = sourceFixture()
  expect(() => createBoundedSourceReader(Object.assign(source.options, { expectedSha256 }), () => {
    calls++; return source.resource
  })).toThrow(TypeError)
  expect(calls).toBe(0)
})

it.each([null, [], 1, {}, { backend: 'other' }, { backend: 'posix' }, { backend: 'posix', device: '1' },
  { backend: 'windows-ntfs' }, { backend: 'windows-ntfs', volumeSerial: '0'.repeat(16) }, { ...id, device: '01' }, { ...id, inode: '-1' },
  { ...id, inode: '18446744073709551616' }, { ...id, inode: 1 },
  { backend: 'windows-ntfs', volumeSerial: '1', fileId: '0'.repeat(32) },
  { backend: 'windows-ntfs', volumeSerial: '0'.repeat(16), fileId: 'A'.repeat(32) }])
('rejects malformed source identity %j before opening', (expectedIdentity) => {
  const source = sourceFixture(); let opened = false
  expect(() => createBoundedSourceReader(Object.assign(source.options, { expectedIdentity }), () => {
    opened = true; return source.resource
  })).toThrow(TypeError)
  expect(opened).toBe(false)
})

it('admits canonical platform identities including native-width limits', () => {
  validateStreamIdentity({ backend: 'posix', device: '0', inode: '18446744073709551615' })
  validateStreamIdentity({ backend: 'windows-ntfs', volumeSerial: 'f'.repeat(16), fileId: '0'.repeat(32) })
})

it('captures known creation metadata before failed inspection and retains later observations', () => {
  for (const observed of [false, true]) for (const knownParent of [false, true]) {
    const fixture = writerFixture(); let inspections = 0
    const initial = fixture.resource.inspect()
    if (knownParent) Object.assign(fixture.resource, { parentIdentity: parentId })
    fixture.resource.inspect = () => {
      inspections++
      if (!observed || inspections === 1) throw new Error('post-create observation failed')
      return initial
    }
    fixture.resource.removeUnpublished = () => ({ deletion: 'withheld', directorySynced: false })
    let failure: unknown
    try { fixture.make() } catch (error) { failure = error }
    expect(failure).toMatchObject({ receipt: { stagingName: fixture.resource.stagingName,
      parentIdentity: knownParent || observed ? parentId : null,
      identity: observed ? id : null, publication: 'not-published', cleanup: 'withheld', release: 'released' } })
    expect(inspections).toBe(2); expect(fixture.state.closeCount).toBe(1)
  }
})

it('does not trigger lazy creation through inspection of a mismatched resource', () => {
  const fixture = writerFixture(); let inspections = 0
  fixture.resource.inspect = () => { inspections++; throw new Error('must not initialize') }
  expect(() => createBoundedFileWriter('x', options(), 'darwin-file-directory-fullsync-v1', () => fixture.resource)).toThrow()
  expect(inspections).toBe(0); expect(fixture.state.closeCount).toBe(1)
})


it('records an established native inspection change as failed observations', () => {
  const fixture = sourceFixture(), reader = fixture.make()
  fixture.resource.inspect = () => { throw new SourceObservationError(new PrivateStorageError('changed', 'native inspection mismatch')) }
  expect(() => reader.readChunk(1)).toThrow(SourceFileReaderError)
  expect(reader.receipt).toMatchObject({ observations: 'failed', release: 'released' })
})
