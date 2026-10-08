/** Bounded replacement of generated private control records under a caller-owned management lease. */
import { createBoundedSourceReader, SourceFileReaderError } from './source-reader.ts'
import { PrivateStreamError, SourceObservationError } from './stream-error.ts'
import { createBoundedFileWriter, PrivateFileWriterError } from './stream-writer.ts'
import { MAX_STREAM_CHUNK_BYTES, sameStreamIdentity, validateStreamExpectation,
  validateStreamIdentity, validateWriterOptions } from './stream-policy.ts'
import type { PrivateRecordReadResult } from './private-record-reader.ts'
import type { StreamWriterResource } from './stream-native.ts'
import type { PrivateFilePublicationReceipt, PrivateFileWriter, PrivateStreamOperationId,
  SourceFileFacts, SourceFileReadReceipt, StreamIdentity, StreamMechanism } from './stream-types.ts'

/** Generated records remain within the existing private byte-storage ceiling. */
export const MAX_CONTROL_RECORD_BYTES = 64 * 1024 * 1024

/** Frozen current selection and replacement manifest, with application-owned synchronous revision validation. */
export interface ControlRecordWriterOptions {
  readonly operationId: PrivateStreamOperationId
  readonly expectedCurrent: Readonly<{ source: SourceFileFacts; sha256: string }>
  readonly expectedBytes: number
  readonly expectedSha256: string
  /** @param current Fully verified current bytes. @returns Explicit completion before any staging side effect. */
  readonly validateCurrent: (current: PrivateRecordReadResult) => 'verified'
}

/** Native stat/security fields observed on one retained object, without inventing source-reader admission facts. */
export interface ControlRecordObjectObservation {
  readonly identity: StreamIdentity
  readonly observations: Readonly<Record<string, string | number | boolean | null>>
}

/** Actual retained-object observations returned by replacement or its reconciliation. */
export interface ControlRecordReplacementFacts {
  readonly replacedBefore: ControlRecordObjectObservation
  readonly replacedAfter: ControlRecordObjectObservation
  readonly stagingParent: ControlRecordObjectObservation
  readonly targetParent: ControlRecordObjectObservation
  readonly parentAfter: ControlRecordObjectObservation
}

/** Distinct replacement adapter; it cannot be passed directly to the immutable artifact writer. */
export interface ControlRecordStagingResource extends Omit<StreamWriterResource, 'publish' | 'reconcile'> {
  /** Replace only the admitted existing generated record after checking the same retained source, parent and live lease. */
  replaceCurrent(): ControlRecordReplacementFacts
  /** Observe retained bindings after a failed acknowledgement, without retrying replacement. */
  reconcileReplacement(): {
    publication: 'not-published' | 'published' | 'indeterminate'
    replacement: ControlRecordReplacementFacts | null
  }
}

/** Retained current record and private parent; the provider excludes original Profile paths and owns native admission. */
export interface ControlRecordResource {
  inspectCurrent(): SourceFileFacts
  readCurrent(maxBytes: number): Uint8Array
  /** Create an own private staging object only after current content and application revision are verified. */
  createStaging(): ControlRecordStagingResource
  /** Release retained current/parent resources once; never release the caller-owned management lease. */
  close(): void
}

/** Source verification excludes the verifier facade's logical release; actual resource release is reported separately. */
export type ControlRecordReadReceipt = Omit<SourceFileReadReceipt, 'release' | 'outcome'>

/** Replacement facts remain independent of staging persistence, cleanup and resource release failures. */
export interface ControlRecordReceipt {
  readonly operationId: PrivateStreamOperationId
  readonly finalName: string
  readonly expectedCurrent: Readonly<{ source: SourceFileFacts; sha256: string }>
  readonly current: ControlRecordReadReceipt | null
  readonly currentVerification: 'unverified' | 'verified' | 'failed'
  readonly revisionVerification: 'unverified' | 'verified' | 'failed'
  /** Shared byte and synchronization observations; publication means replacement of the admitted generated record here. */
  readonly staging: PrivateFilePublicationReceipt | null
  readonly replacement: ControlRecordReplacementFacts | null
  readonly replacementVerification: 'unverified' | 'verified' | 'failed'
  readonly release: 'not-attempted' | 'released' | 'failed'
  readonly managementLease: 'caller-owned'
  readonly outcome: 'open' | 'finished' | 'aborted' | 'failed' | 'closed'
  readonly phase: 'verify-current' | 'validate-revision' | 'create-staging' | 'append' | 'finish' | 'abort' | 'close' | 'finished'
}

/** One synchronous generated-record replacement; no seek, pathname fallback or hostile-writer compare-and-swap claim. */
export interface ControlRecordWriter {
  readonly receipt: ControlRecordReceipt
  /** @param chunk Nonempty unshared bytes, at most 1 MiB. */
  append(chunk: Uint8Array): void
  /** @returns Cached successful replacement receipt; failures never republish. */
  finish(): ControlRecordReceipt
  /** @returns Terminal receipt; cleanup is restricted to the operation's known unpublished staging object. */
  abort(): ControlRecordReceipt
  /** Release only; never replace or remove either record. */
  close(): void
}

/** Failure retaining source, revision, replacement, persistence and independent release observations. */
export class ControlRecordWriterError extends PrivateStreamError {
  /** Complete observations even when publication succeeded before a late failure. */
  readonly receipt: ControlRecordReceipt
  constructor(receipt: ControlRecordReceipt, cause: unknown) {
    super(`private control record failed during ${receipt.phase}`, cause,
      receipt.release === 'failed' || receipt.staging?.release === 'failed' || receipt.staging?.cleanup === 'failed')
    this.name = 'ControlRecordWriterError'
    this.receipt = receipt
  }
}

function freezeFacts(facts: SourceFileFacts): SourceFileFacts {
  return Object.freeze({ ...facts, identity: Object.freeze({ ...facts.identity }), observations: Object.freeze({ ...facts.observations }) })
}

function sameFacts(left: SourceFileFacts, right: SourceFileFacts): boolean {
  return sameStreamIdentity(left.identity, right.identity) && left.sizeBytes === right.sizeBytes
    && left.links === right.links && left.changeToken === right.changeToken
    && Object.keys(left.observations).length === Object.keys(right.observations).length
    && Object.entries(left.observations).every(([key, value]) =>
      Object.hasOwn(right.observations, key) && right.observations[key] === value)
}

function sourceReceipt(receipt: SourceFileReadReceipt): ControlRecordReadReceipt {
  const { release: _release, outcome: _outcome, ...facts } = receipt
  return Object.freeze(facts)
}

function freezeReplacement(facts: ControlRecordReplacementFacts): ControlRecordReplacementFacts {
  const freeze = (value: ControlRecordObjectObservation): ControlRecordObjectObservation => Object.freeze({
    identity: Object.freeze({ ...value.identity }), observations: Object.freeze({ ...value.observations }),
  })
  return Object.freeze({ replacedBefore: freeze(facts.replacedBefore), replacedAfter: freeze(facts.replacedAfter),
    stagingParent: freeze(facts.stagingParent), targetParent: freeze(facts.targetParent), parentAfter: freeze(facts.parentAfter) })
}

/**
 * Verify one retained current record and its application revision before creating replacement staging.
 * @param name Provider-validated literal generated-record component, never an original Profile pathname.
 * @param options Frozen source facts/digest and bounded output manifest; revision interpretation belongs to the consumer.
 * @param mechanism Actual native synchronization sequence.
 * @param open Factory retaining the private source/parent and checking a live same-parent caller-owned lease; failed setup self-releases.
 * @returns Bounded writer whose replacement operation checks the retained source and live lease again, without pathname reopening.
 */
export function createBoundedControlRecordWriter(
  name: string, options: ControlRecordWriterOptions, mechanism: StreamMechanism, open: () => ControlRecordResource,
): ControlRecordWriter {
  const expected = Object.freeze({ ...options, expectedCurrent: Object.freeze({
    source: freezeFacts(options.expectedCurrent.source), sha256: options.expectedCurrent.sha256,
  }) })
  const manifest = Object.freeze({ operationId: expected.operationId, expectedBytes: expected.expectedBytes,
    expectedSha256: expected.expectedSha256, executable: false, replace: false as const })
  validateWriterOptions(manifest)
  validateStreamIdentity(expected.expectedCurrent.source.identity)
  validateStreamExpectation({ expectedBytes: expected.expectedCurrent.source.sizeBytes, expectedSha256: expected.expectedCurrent.sha256 })
  if (expected.expectedBytes > MAX_CONTROL_RECORD_BYTES || expected.expectedCurrent.source.sizeBytes > MAX_CONTROL_RECORD_BYTES) {
    throw new RangeError('private control records must not exceed 67108864 bytes')
  }
  let resource: ControlRecordResource | undefined
  let writer: PrivateFileWriter | undefined
  let released = false
  let failure: ControlRecordWriterError | undefined
  let facts: ControlRecordReceipt = {
    operationId: expected.operationId, finalName: name, expectedCurrent: expected.expectedCurrent,
    current: null, currentVerification: 'unverified', revisionVerification: 'unverified', staging: null, replacement: null,
    replacementVerification: 'unverified',
    release: 'not-attempted', managementLease: 'caller-owned', outcome: 'open', phase: 'verify-current',
  }
  const update = (next: Partial<ControlRecordReceipt>): void => { facts = { ...facts, ...next } }
  const snapshot = (): ControlRecordReceipt => Object.freeze({ ...facts, staging: writer?.receipt ?? facts.staging })
  const recordReplacement = (observed: ControlRecordReplacementFacts | null): void => {
    if (observed === null) return
    const replacement = freezeReplacement(observed)
    const parentIdentity = writer?.receipt.parentIdentity
    const verified = sameStreamIdentity(replacement.replacedBefore.identity, expected.expectedCurrent.source.identity)
      && sameStreamIdentity(replacement.replacedAfter.identity, expected.expectedCurrent.source.identity)
      && parentIdentity !== null && parentIdentity !== undefined
      && [replacement.stagingParent, replacement.targetParent, replacement.parentAfter]
        .every(value => sameStreamIdentity(value.identity, parentIdentity))
    update({ replacement, replacementVerification: verified ? 'verified' : 'failed' })
  }
  const release = (errors: unknown[]): void => {
    if (released || resource === undefined) return
    released = true
    try { resource.close(); update({ release: 'released' }) }
    catch (error) { errors.push(error); update({ release: 'failed' }) }
  }
  const fail = (cause: unknown): never => {
    if (failure !== undefined && cause === failure) throw failure
    if (cause instanceof SourceFileReaderError) {
      update({ current: cause.receipt === undefined ? null : sourceReceipt(cause.receipt) })
    }
    if (facts.phase === 'verify-current') update({ currentVerification: 'failed' })
    if (facts.phase === 'validate-revision') update({ revisionVerification: 'failed' })
    if (cause instanceof PrivateFileWriterError) update({ staging: cause.receipt })
    const errors = [cause]
    release(errors)
    update({ outcome: 'failed' })
    failure = new ControlRecordWriterError(snapshot(), errors.length === 1 ? cause : new AggregateError(errors))
    throw failure
  }
  const requireOpen = (): PrivateFileWriter => {
    if (failure !== undefined) throw failure
    if (facts.outcome !== 'open' || writer === undefined) throw new ControlRecordWriterError(snapshot(), new Error('control record writer is closed'))
    return writer
  }
  const settle = (outcome: 'finished' | 'aborted' | 'closed'): ControlRecordReceipt => {
    const errors: unknown[] = []
    release(errors)
    if (errors.length > 0) fail(new AggregateError(errors))
    update({ outcome, ...outcome === 'finished' ? { phase: 'finished' as const } : {} })
    return snapshot()
  }
  try {
    const current = open()
    resource = current
    const reader = createBoundedSourceReader({ expectedIdentity: expected.expectedCurrent.source.identity,
      expectedBytes: expected.expectedCurrent.source.sizeBytes, expectedSha256: expected.expectedCurrent.sha256 }, () => ({
      inspect: () => {
        const observed = current.inspectCurrent()
        if (!sameFacts(observed, expected.expectedCurrent.source)) throw new SourceObservationError(new Error('current record facts differ'))
        return observed
      },
      read: maxBytes => current.readCurrent(maxBytes),
      // Only the verification facade closes here; the actual current descriptor remains retained through replacement.
      close: () => {},
    }))
    const bytes = new Uint8Array(expected.expectedCurrent.source.sizeBytes)
    let offset = 0
    while (true) {
      const chunk = reader.readChunk(MAX_STREAM_CHUNK_BYTES)
      if (chunk.byteLength === 0) break
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    update({ current: sourceReceipt(reader.finish()), currentVerification: 'verified', phase: 'validate-revision' })
    const revision: unknown = expected.validateCurrent(Object.freeze({ bytes,
      sha256: expected.expectedCurrent.sha256, source: expected.expectedCurrent.source }))
    if (revision !== 'verified') throw new Error('current revision validation did not complete synchronously')
    update({ revisionVerification: 'verified', phase: 'create-staging' })
    writer = createBoundedFileWriter(name, manifest, mechanism, () => {
      const stage = current.createStaging()
      return {
        mechanism: stage.mechanism, stagingName: stage.stagingName,
        ...stage.parentIdentity === undefined ? {} : { parentIdentity: stage.parentIdentity },
        inspect: () => stage.inspect(), write: (chunk) => { stage.write(chunk) },
        setExecutable: (value) => { stage.setExecutable(value) },
        syncFile: () => { stage.syncFile() }, syncDirectory: () => { stage.syncDirectory() },
        publish: () => { recordReplacement(stage.replaceCurrent()) },
        reconcile: () => {
          const observed = stage.reconcileReplacement()
          recordReplacement(observed.replacement)
          return observed.publication
        },
        verifyFinal: () => {
          if (facts.replacementVerification !== 'verified') throw new Error('replacement object or parent observations differ')
          return stage.verifyFinal()
        },
        removeUnpublished: () => stage.removeUnpublished(), close: () => { stage.close() },
      }
    })
  } catch (error) { fail(error) }
  return Object.freeze({
    get receipt(): ControlRecordReceipt { return snapshot() },
    append(chunk: Uint8Array): void {
      const current = requireOpen()
      update({ phase: 'append' })
      try { current.append(chunk) } catch (error) { fail(error) }
    },
    finish(): ControlRecordReceipt {
      if (facts.outcome === 'finished') return snapshot()
      const current = requireOpen()
      update({ phase: 'finish' })
      try { current.finish(); return settle('finished') } catch (error) { return fail(error) }
    },
    abort(): ControlRecordReceipt {
      if (facts.outcome !== 'open') return snapshot()
      const current = requireOpen()
      update({ phase: 'abort' })
      try { current.abort(); return settle('aborted') } catch (error) { return fail(error) }
    },
    close(): void {
      if (released) return
      const current = requireOpen()
      update({ phase: 'close' })
      try { current.close(); settle('closed') } catch (error) { fail(error) }
    },
  })
}
