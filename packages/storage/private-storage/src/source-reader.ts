/** Bounded same-object source reads; source policy never borrows destination privacy requirements. */
import { createHash } from 'node:crypto'
import { PrivateStreamError, SourceObservationError } from './stream-error.ts'
import { types } from 'node:util'
import { sameStreamIdentity, validateStreamChunkSize, validateStreamExpectation, validateStreamIdentity } from './stream-policy.ts'
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts, SourceFileReader, SourceFileReaderOptions, SourceFileReadReceipt } from './stream-types.ts'

/** Read failure retaining exact source observations, byte accounting and release outcome. */
export class SourceFileReaderError extends PrivateStreamError {
  /** Source completion and release facts; absent when initial admission produced no trustworthy observation. */
  readonly receipt: SourceFileReadReceipt | undefined
  constructor(receipt: SourceFileReadReceipt | undefined, cause: unknown, cleanupFailed = false) {
    super('private-storage source stream failed', cause, cleanupFailed || receipt?.release === 'failed')
    this.name = 'SourceFileReaderError'
    this.receipt = receipt
  }
}

function freezeFacts(facts: SourceFileFacts): SourceFileFacts {
  return Object.freeze({ ...facts, identity: Object.freeze({ ...facts.identity }), observations: Object.freeze({ ...facts.observations }) })
}

/**
 * Capture exact expected identity, size and digest before acquiring a retained readonly source.
 * @param options Frozen consumer plan fields; this helper never discovers a trusted digest itself.
 * @param open Native owner factory; it must release resources if it throws before returning.
 * @returns Sequential bounded reader; only finish certifies EOF, stable observations and the complete digest.
 */
export function createBoundedSourceReader(options: SourceFileReaderOptions, open: () => SourceReaderResource): SourceFileReader {
  validateStreamIdentity(options.expectedIdentity)
  const expected = Object.freeze({ ...options, expectedIdentity: Object.freeze({ ...options.expectedIdentity }) })
  validateStreamExpectation(expected)
  const resource = open()
  let source: SourceFileFacts
  try { source = freezeFacts(resource.inspect()) }
  catch (error) {
    try { resource.close() }
    catch (closeError) { throw new SourceFileReaderError(undefined, new AggregateError([error, closeError]), true) }
    throw new SourceFileReaderError(undefined, error)
  }
  const hash = createHash('sha256')
  let released = false
  let failure: SourceFileReaderError | undefined
  let facts: SourceFileReadReceipt = { source, expectedBytes: expected.expectedBytes, expectedSha256: expected.expectedSha256,
    observedBytes: 0, actualSha256: null, eof: false, observations: 'unchanged', verification: 'unverified', release: 'not-attempted', outcome: 'open' }
  const snapshot = (): SourceFileReadReceipt => {
    return Object.freeze({ ...facts, source: freezeFacts(facts.source) })
  }
  const update = (next: Partial<SourceFileReadReceipt>): void => {
    facts = { ...facts, ...next }
  }
  const release = (errors: unknown[]): void => {
    if (released) return
    released = true
    try { resource.close(); update({ release: 'released' }) }
    catch (error) { errors.push(error); update({ release: 'failed' }) }
  }
  const fail = (cause: unknown): never => {
    if (failure !== undefined && cause === failure) throw failure
    update({ outcome: 'failed', verification: facts.verification === 'verified' ? 'verified' : 'failed' })
    const errors = [cause]
    release(errors)
    failure = new SourceFileReaderError(snapshot(), errors.length === 1 ? cause : new AggregateError(errors))
    throw failure
  }
  const inspect = (): void => {
    let observed: SourceFileFacts
    try { observed = resource.inspect() }
    catch (error) { update({ observations: error instanceof SourceObservationError ? 'failed' : 'unverified' }); throw error }
    if (!sameStreamIdentity(observed.identity, facts.source.identity)
      || observed.sizeBytes !== facts.source.sizeBytes || observed.links !== facts.source.links
      || observed.changeToken !== facts.source.changeToken) {
      update({ observations: 'failed' })
      throw new Error('source observations changed')
    }
  }
  const requireOpen = (): void => {
    if (failure !== undefined) throw failure
    if (facts.outcome !== 'open') throw new SourceFileReaderError(snapshot(), new Error('source reader is closed'))
  }
  try {
    if (!sameStreamIdentity(source.identity, expected.expectedIdentity) || source.sizeBytes !== expected.expectedBytes) {
      throw new Error('source does not match expected identity or length')
    }
  } catch (error) { fail(error) }

  const read = (maxBytes: number): Uint8Array => {
    requireOpen()
    try {
      validateStreamChunkSize(maxBytes)
      inspect()
      const before = snapshot()
      const bound = Math.min(maxBytes, expected.expectedBytes - before.observedBytes + 1)
      let bytes: Uint8Array
      try { bytes = resource.read(bound) }
      catch (error) { update({ observations: error instanceof SourceObservationError ? 'failed' : 'unverified' }); throw error }
      if (!types.isUint8Array(bytes) || types.isSharedArrayBuffer(bytes.buffer) || bytes.byteLength > bound) {
        update({ observations: 'unverified' })
        throw new Error('native reader violated the owned buffer bound')
      }
      update({ observedBytes: before.observedBytes + bytes.byteLength, eof: bytes.byteLength === 0 })
      inspect()
      if (snapshot().observedBytes > expected.expectedBytes) throw new Error('source exceeds manifest length')
      hash.update(bytes)
      return bytes
    } catch (error) { return fail(error) }
  }
  return Object.freeze({
    get receipt(): SourceFileReadReceipt { return snapshot() },
    readChunk: read,
    finish(): SourceFileReadReceipt {
      if (facts.outcome === 'finished') return snapshot()
      requireOpen()
      try {
        if (!snapshot().eof && read(1).byteLength !== 0) throw new Error('source was not completely consumed')
        inspect()
        const actualSha256 = hash.digest('hex')
        update({ actualSha256 })
        if (snapshot().observedBytes !== expected.expectedBytes || actualSha256 !== expected.expectedSha256) {
          throw new Error('source length or digest differs from the frozen plan')
        }
        update({ verification: 'verified' })
        const errors: unknown[] = []
        release(errors)
        if (errors.length > 0) throw new AggregateError(errors)
        update({ outcome: 'finished' })
        return snapshot()
      } catch (error) { return fail(error) }
    },
    close(): void {
      if (released) return
      update({ outcome: 'closed' })
      const errors: unknown[] = []
      release(errors)
      if (errors.length > 0) fail(new AggregateError(errors))
    },
  })
}
