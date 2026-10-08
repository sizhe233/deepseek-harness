/** Streaming observation lifecycle models; no native filesystem conformance is implied. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createObservedSourceReader, ObservedSourceFileReaderError } from '../src/observed-source-reader.ts'
import { SourceObservationError } from '../src/stream-error.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { SourceReaderResource } from '../src/stream-native.ts'
import type { SourceFileFacts } from '../src/stream-types.ts'
const source = (sizeBytes = 6): SourceFileFacts => ({ identity: { backend: 'posix', device: '1', inode: '2' }, sizeBytes, links: 2,
  changeToken: 'selected', observations: { mode: 0o100644, revision: 'a' } })
function model(bytes = Buffer.from('abcdef')) {
  let actual = source(bytes.length), cursor = 0, closes = 0
  const resource: SourceReaderResource = { inspect: () => actual, read: (maximum) => {
    const output = Buffer.from(bytes.subarray(cursor, cursor + maximum)); cursor += output.length; return output
  }, close: () => { closes++ } }
  return { resource, get closes() { return closes }, setSource(value: SourceFileFacts) { actual = value } }
}
function captured(operation: () => unknown): ObservedSourceFileReaderError {
  try { operation() } catch (error) { if (error instanceof ObservedSourceFileReaderError) return error; throw error }
  throw new Error('Expected observation failure')
}
it('computes the complete digest across independent chunks and never calls it prior-manifest verification', () => {
  const f = model(), expected = source(), reader = createObservedSourceReader({ expectedSource: expected,
    maxBytes: 1024 }, () => f.resource)
  expect(Buffer.from(reader.readChunk(2)).toString()).toBe('ab')
  expect(Buffer.from(reader.readChunk(4)).toString()).toBe('cdef')
  const receipt = reader.finish()
  expect(receipt).toMatchObject({ kind: 'observed-source', observedBytes: 6, eof: true, observations: 'unchanged',
    verification: 'observed', release: 'released', outcome: 'finished', actualSha256: createHash('sha256').update('abcdef').digest('hex') })
  expect(reader.finish()).toEqual(receipt); reader.close(); expect(f.closes).toBe(1)
  expect(() => reader.readChunk(1)).toThrow(ObservedSourceFileReaderError)
})
it('supports empty input and refuses invalid selection before any resource acquisition', () => {
  const f = model(Buffer.alloc(0)), empty = createObservedSourceReader({ expectedSource: source(0), maxBytes: 0 }, () => f.resource)
  expect(empty.finish()).toMatchObject({ observedBytes: 0, eof: true, verification: 'observed' })
  for (const maxBytes of [-1, 1024 ** 3 + 1, 0.5, NaN, 5]) expect(() => createObservedSourceReader({ expectedSource: source(), maxBytes },
    () => { throw new Error('Factory must not run') })).toThrow(RangeError)
  for (const value of [{ ...source(), sizeBytes: -1 }, { ...source(), sizeBytes: 0.5 }, { ...source(), links: 0 }]) {
    expect(() => createObservedSourceReader({ expectedSource: value, maxBytes: 6 },
      () => { throw new Error('Factory must not run') })).toThrow(RangeError)
  }
})
it('retains initial native failure and reports inspection/close failures without guessing observations', () => {
  const primary = new PrivateStorageError('privacy', 'denied', { nativeStatus: 0xc0000022 })
  const failed = captured(() => createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => { throw primary }))
  expect(failed).toMatchObject({ code: 'privacy', nativeStatus: 0xc0000022, receipt: { source: null, release: 'not-attempted' } })
  const f = model(); f.resource.inspect = () => { throw primary }; f.resource.close = () => { throw new Error('close uncertain') }
  const inspected = captured(() => createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource))
  expect(inspected).toMatchObject({ code: 'privacy', cleanupFailed: true, receipt: { observations: 'unverified', release: 'failed' } })
})
it.each(['identity', 'size', 'links', 'token', 'metadata', 'extra'] as const)('detects %s drift and settles once', (field) => {
  const f = model(), reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource)
  const next = source()
  f.setSource(field === 'identity' ? { ...next, identity: { backend: 'posix', device: '1', inode: '3' } }
    : field === 'size' ? { ...next, sizeBytes: 5 } : field === 'links' ? { ...next, links: 1 }
      : field === 'token' ? { ...next, changeToken: 'changed' } : field === 'metadata' ? { ...next,
        observations: { mode: 0o100600, revision: 'a' } }
        : { ...next, observations: { ...next.observations, extra: true } })
  const error = captured(() => reader.readChunk(1))
  expect(error.receipt).toMatchObject({ observations: 'failed', release: 'released', outcome: 'failed' })
  expect(captured(() => reader.finish())).toBe(error); reader.close(); expect(f.closes).toBe(1)
})
it.each([false, true])('distinguishes ordinary I/O refusal from established source drift (%s)', (changed) => {
  const f = model(), reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource)
  f.resource.read = () => { throw changed ? new SourceObservationError(new Error('changed')) : new Error('I/O refused') }
  expect(captured(() => reader.readChunk(1)).receipt.observations).toBe(changed ? 'failed' : 'unverified')
  expect(f.closes).toBe(1)
})
it('preserves a computed digest and confirmed EOF when final release cannot be confirmed', () => {
  const f = model(), reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource)
  reader.readChunk(6); f.resource.close = () => { throw new Error('lost close result') }
  const error = captured(() => reader.finish())
  expect(error.receipt).toMatchObject({ verification: 'observed', eof: true, release: 'failed', outcome: 'failed' })
  expect(error.receipt.actualSha256).toBe(createHash('sha256').update('abcdef').digest('hex'))
  expect(captured(() => reader.finish())).toBe(error)
})
it('settles finish-read and inspection failures once while retaining established observation status', () => {
  const first = model(), reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => first.resource)
  first.resource.read = () => { throw new Error('EOF probe failed') }
  const failed = captured(() => reader.finish())
  expect(captured(() => reader.finish())).toBe(failed); expect(first.closes).toBe(1)
  const second = model(), changed = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => second.resource)
  second.resource.inspect = () => { throw new SourceObservationError(new Error('binding changed')) }
  expect(captured(() => changed.readChunk(1)).receipt.observations).toBe('failed')
  const third = model(), closing = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => third.resource)
  third.resource.close = () => { throw new Error('close failed') }
  expect(captured(() =>{  closing.close() }).receipt.release).toBe('failed')
})
it('detects one extra byte even when an inconsistent provider repeats the selected metadata', () => {
  const f = model(Buffer.from('abcdefg')); f.setSource(source())
  const reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource)
  reader.readChunk(6)
  expect(captured(() => reader.readChunk(1)).receipt).toMatchObject({ observedBytes: 7, verification: 'failed', release: 'released' })
})
it.each(['partial', 'early-eof', 'overlong', 'shared', 'invalid-chunk',
  'close'] as const)('refuses incomplete or invalid %s lifecycle', (kind) => {
  const f = model(), reader = createObservedSourceReader({ expectedSource: source(), maxBytes: 6 }, () => f.resource)
  if (kind === 'close') {
    reader.close(); reader.close(); expect(reader.receipt).toMatchObject({ outcome: 'closed',
      verification: 'unverified', release: 'released' })
    expect(() => reader.finish()).toThrow(ObservedSourceFileReaderError); expect(f.closes).toBe(1); return
  }
  if (kind === 'early-eof') f.resource.read = () => Buffer.alloc(0)
  if (kind === 'overlong') f.resource.read = maximum => Buffer.alloc(maximum + 1)
  if (kind === 'shared') f.resource.read = () => new Uint8Array(new SharedArrayBuffer(1))
  const error = captured(() => kind === 'partial' || kind === 'early-eof' ? reader.finish() : reader.readChunk(kind === 'invalid-chunk' ? 0 : 1))
  expect(error.receipt.outcome).toBe('failed'); expect(f.closes).toBe(1)
})
