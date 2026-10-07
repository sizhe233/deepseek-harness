/** Sequential source observation computes a digest without claiming prior artifact-manifest admission. */
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { PrivateStreamError, SourceObservationError } from './stream-error.ts'
import { MAX_STREAM_FILE_BYTES, sameStreamIdentity, validateStreamChunkSize, validateStreamIdentity } from './stream-policy.ts'
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts } from './stream-types.ts'

/** Exact provisional observations and a separate stream ceiling of at most 1 GiB. */
export interface ObservedSourceFileReaderOptions { readonly expectedSource: SourceFileFacts; readonly maxBytes: number }
/** Computed observation only; no independently expected content digest was supplied. */
export interface ObservedSourceFileReadReceipt {
  readonly kind: 'observed-source'
  readonly expectedSource: SourceFileFacts
  readonly source: SourceFileFacts | null
  readonly maxBytes: number
  readonly observedBytes: number
  readonly actualSha256: string | null
  readonly eof: boolean
  readonly observations: 'unverified' | 'unchanged' | 'failed'
  readonly verification: 'unverified' | 'observed' | 'failed'
  readonly release: 'not-attempted' | 'released' | 'failed'
  readonly outcome: 'open' | 'finished' | 'closed' | 'failed'
}
/** Provider-owned sequential stream, separate from strict artifact readers and small document imports. */
export interface ObservedSourceFileReader {
  readonly receipt: ObservedSourceFileReadReceipt
  /** @param maxBytes Positive chunk ceiling at most 1 MiB. @returns Detached bytes; an empty array confirms EOF. */
  readChunk(maxBytes: number): Uint8Array
  /** @returns Final computed digest after exact EOF, unchanged observations and confirmed release. */
  finish(): ObservedSourceFileReadReceipt
  /** Release once without asserting complete observation. */
  close(): void
}
/** Primary I/O error and all established observation/release facts. */
export class ObservedSourceFileReaderError extends PrivateStreamError {
  /** Partial read progress and independent observation and release outcomes. */
  readonly receipt: ObservedSourceFileReadReceipt
  constructor(receipt: ObservedSourceFileReadReceipt, cause: unknown) {
    super('source observation stream failed', cause, receipt.release === 'failed')
    this.name = 'ObservedSourceFileReaderError'; this.receipt = receipt
  }
}
const freezeFacts = (facts: SourceFileFacts): SourceFileFacts => Object.freeze({ ...facts,
  identity: Object.freeze({ ...facts.identity }), observations: Object.freeze({ ...facts.observations }) })
function equalFacts(actual: SourceFileFacts, expected: SourceFileFacts): boolean {
  return sameStreamIdentity(actual.identity, expected.identity) && actual.sizeBytes === expected.sizeBytes
    && actual.links === expected.links && actual.changeToken === expected.changeToken
    && Object.keys(actual.observations).length === Object.keys(expected.observations).length
    && Object.entries(expected.observations).every(([key, value]) =>
      Object.hasOwn(actual.observations, key) && actual.observations[key] === value)
}
/**
 * Retain one source and compute its complete bounded digest after matching every provisional observation.
 * @param options Exact source selection and independent size ceiling.
 * @param open Readonly provider factory; it settles failures before returning.
 * @returns Sequential observation reader with honest terminal receipts.
 */
export function createObservedSourceReader(
  options: ObservedSourceFileReaderOptions, open: () => SourceReaderResource,
): ObservedSourceFileReader {
  validateStreamIdentity(options.expectedSource.identity)
  const expected = freezeFacts(options.expectedSource), maximum = options.maxBytes
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_STREAM_FILE_BYTES
    || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 0 || expected.sizeBytes > maximum
    || !Number.isSafeInteger(expected.links) || expected.links < 1) throw new RangeError('invalid observed-source size or link bound')
  let facts: ObservedSourceFileReadReceipt = { kind: 'observed-source', expectedSource: expected, source: null,
    maxBytes: maximum, observedBytes: 0, actualSha256: null, eof: false, observations: 'unverified',
    verification: 'unverified', release: 'not-attempted', outcome: 'open' }
  let resource: SourceReaderResource
  try { resource = open() }
  catch (error) { throw new ObservedSourceFileReaderError(Object.freeze({ ...facts, outcome: 'failed', verification: 'failed' }), error) }
  let released = false, failure: ObservedSourceFileReaderError | undefined
  const hash = createHash('sha256')
  const snapshot = (): ObservedSourceFileReadReceipt => Object.freeze({ ...facts })
  const update = (next: Partial<ObservedSourceFileReadReceipt>): void => { facts = { ...facts, ...next } }
  const release = (errors: unknown[]): void => {
    if (released) return
    released = true
    try { resource.close(); update({ release: 'released' }) }
    catch (error) { errors.push(error); update({ release: 'failed' }) }
  }
  const fail = (cause: unknown): never => {
    if (failure !== undefined && cause === failure) throw failure
    update({ outcome: 'failed', verification: facts.verification === 'observed' ? 'observed' : 'failed' })
    const errors = [cause]; release(errors)
    failure = new ObservedSourceFileReaderError(snapshot(), errors.length === 1 ? cause : new AggregateError(errors))
    throw failure
  }
  const inspect = (): void => {
    let actual: SourceFileFacts
    try { actual = resource.inspect() }
    catch (error) { update({ observations: error instanceof SourceObservationError ? 'failed' : 'unverified' }); throw error }
    if (!equalFacts(actual, expected)) {
      update({ source: freezeFacts(actual), observations: 'failed' })
      throw new SourceObservationError(new Error('source differs from its provisional selection'))
    }
    update({ source: freezeFacts(actual), observations: 'unchanged' })
  }
  const requireOpen = (): SourceReaderResource => {
    if (failure !== undefined) throw failure
    if (facts.outcome !== 'open') throw new ObservedSourceFileReaderError(snapshot(), new Error('source observation reader is closed'))
    return resource
  }
  try { inspect() } catch (error) { fail(error) }
  const read = (maximumChunk: number): Uint8Array => {
    const selected = requireOpen()
    try {
      validateStreamChunkSize(maximumChunk); inspect()
      const bound = Math.min(maximumChunk, expected.sizeBytes - facts.observedBytes + 1)
      let bytes: Uint8Array
      try { bytes = selected.read(bound) }
      catch (error) { update({ observations: error instanceof SourceObservationError ? 'failed' : 'unverified' }); throw error }
      if (!types.isUint8Array(bytes) || types.isSharedArrayBuffer(bytes.buffer) || bytes.byteLength > bound) {
        update({ observations: 'unverified' }); throw new Error('native source exceeded the owned chunk bound')
      }
      update({ observedBytes: facts.observedBytes + bytes.byteLength, eof: bytes.byteLength === 0 })
      inspect()
      if (facts.observedBytes > expected.sizeBytes) throw new Error('source exceeded its selected size')
      hash.update(bytes)
      return bytes
    } catch (error) { return fail(error) }
  }
  return Object.freeze({ get receipt() { return snapshot() }, readChunk: read,
    finish() {
      if (facts.outcome === 'finished') return snapshot()
      requireOpen()
      try {
        if (!facts.eof && read(1).byteLength !== 0) throw new Error('source was not completely consumed')
        inspect()
        update({ actualSha256: hash.digest('hex') })
        if (facts.observedBytes !== expected.sizeBytes) throw new Error('source ended before its selected size')
        update({ verification: 'observed' })
        const errors: unknown[] = []; release(errors)
        if (errors.length > 0) throw new AggregateError(errors)
        update({ outcome: 'finished' }); return snapshot()
      } catch (error) { return fail(error) }
    },
    close() {
      if (released) return
      update({ outcome: 'closed' })
      const errors: unknown[] = []; release(errors)
      if (errors.length > 0) fail(new AggregateError(errors))
    },
  })
}
