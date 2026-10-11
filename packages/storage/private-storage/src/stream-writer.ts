/** One synchronous append/hash/publication lifecycle shared by native platform adapters. */
import { createHash } from 'node:crypto'
import { PrivateStreamError } from './stream-error.ts'
import { sameStreamIdentity, validateStreamChunk, validateWriterOptions } from './stream-policy.ts'
import type { StreamFileFacts, StreamWriterResource } from './stream-native.ts'
import type { PrivateFilePublicationReceipt, PrivateFileWriter, PrivateFileWriterOptions, StreamMechanism } from './stream-types.ts'

/** A failed stream retains publication and persistence facts independently of its exception. */
export class PrivateFileWriterError extends PrivateStreamError {
  /** Publication, verification, persistence and release facts preserved through failure. */
  readonly receipt: PrivateFilePublicationReceipt
  constructor(receipt: PrivateFilePublicationReceipt, cause: unknown) {
    super(`private-storage stream failed during ${receipt.phase}`, cause, receipt.cleanup === 'failed' || receipt.release === 'failed')
    this.name = 'PrivateFileWriterError'
    this.receipt = receipt
  }
}

function snapshot(value: PrivateFilePublicationReceipt): PrivateFilePublicationReceipt {
  return Object.freeze({ ...value,
    identity: value.identity === null ? null : Object.freeze({ ...value.identity }),
    parentIdentity: value.parentIdentity === null ? null : Object.freeze({ ...value.parentIdentity }),
    synchronization: Object.freeze({ ...value.synchronization }),
  })
}

/**
 * Construct a provider-owned writer after validating immutable manifest expectations.
 * @param name Already validated literal final component.
 * @param options Caller manifest; copied before invoking the native factory.
 * @param mechanism Actual platform synchronization sequence.
 * @param create Native owner factory; it must release resources if setup throws before returning.
 * @returns One bounded synchronous writer. This helper neither discovers paths nor admits storage itself.
 */
export function createBoundedFileWriter(
  name: string, options: PrivateFileWriterOptions, mechanism: StreamMechanism, create: () => StreamWriterResource,
): PrivateFileWriter {
  const expected = Object.freeze({ ...options })
  validateWriterOptions(expected)
  const hash = createHash('sha256')
  let resource: StreamWriterResource | undefined
  let released = false
  let inspectionStarted = false
  let failure: PrivateFileWriterError | undefined
  let facts: PrivateFilePublicationReceipt = {
    operationId: expected.operationId, finalName: name, stagingName: null, mechanism,
    identity: null, parentIdentity: null, expectedBytes: expected.expectedBytes, expectedSha256: expected.expectedSha256,
    acceptedBytes: 0, observedSizeBytes: null, confirmedPartialBytes: null, actualSha256: null,
    executable: expected.executable, metadataVerification: 'unverified',
    executableMetadata: mechanism === 'windows-ntfs-write-through-rename-v1' ? 'not-required' : 'unverified',
    outcome: 'open', phase: 'create', publication: 'not-published', contentVerification: 'unverified',
    bindingVerification: 'unverified', durability: 'unconfirmed', cleanup: 'not-needed', cleanupDurability: 'unconfirmed',
    release: 'not-attempted', synchronization: {
      preFile: 'not-attempted', directory: mechanism === 'windows-ntfs-write-through-rename-v1' ? 'not-required' : 'not-attempted',
      postFile: mechanism === 'linux-file-directory-fsync-v1' ? 'not-required' : 'not-attempted',
    },
  }
  const update = (next: Partial<PrivateFilePublicationReceipt>): void => { facts = { ...facts, ...next } }
  const release = (errors: unknown[]): void => {
    if (released || resource === undefined) return
    released = true
    try { resource.close(); update({ release: 'released' }) }
    catch (error) { errors.push(error); update({ release: 'failed' }) }
  }
  const clean = (errors: unknown[]): void => {
    if (resource === undefined) return
    if (facts.publication !== 'not-published') { update({ cleanup: 'withheld' }); return }
    try {
      const result = resource.removeUnpublished()
      update({ cleanup: result.deletion, cleanupDurability: result.directorySynced ? 'synced' : 'unconfirmed' })
    } catch (error) { errors.push(error); update({ cleanup: 'failed' }) }
  }
  const fail = (cause: unknown): never => {
    const errors = [cause]
    if (resource !== undefined && !released && inspectionStarted) {
      try {
        const observed = resource.inspect()
        update({ observedSizeBytes: observed.sizeBytes,
          identity: facts.identity ?? observed.identity, parentIdentity: facts.parentIdentity ?? observed.parentIdentity })
      }
      catch (error) { errors.push(error); update({ observedSizeBytes: null }) }
    }
    if (cause !== null && typeof cause === 'object' && 'confirmedBytes' in cause
      && typeof cause.confirmedBytes === 'number' && Number.isSafeInteger(cause.confirmedBytes) && cause.confirmedBytes >= 0) {
      update({ confirmedPartialBytes: cause.confirmedBytes })
    }
    clean(errors)
    release(errors)
    update({ outcome: 'failed' })
    failure = new PrivateFileWriterError(snapshot(facts), errors.length === 1 ? cause : new AggregateError(errors))
    throw failure
  }
  const inspect = (value: StreamFileFacts, executable: boolean): void => {
    update({ observedSizeBytes: value.sizeBytes })
    const executableMatches = mechanism === 'windows-ntfs-write-through-rename-v1'
      ? value.executable === null : value.executable === executable
    if (!executableMatches) update({ executableMetadata: 'failed' })
    if (!value.privateVerified || !executableMatches) {
      update({ metadataVerification: 'failed' })
      throw new Error('private stream access or executable metadata changed')
    }
    if (facts.identity === null || facts.parentIdentity === null
      || !sameStreamIdentity(value.identity, facts.identity) || !sameStreamIdentity(value.parentIdentity, facts.parentIdentity)
      || value.sizeBytes !== facts.acceptedBytes || value.links !== 1) {
      throw new Error('private stream identity, privacy, metadata or EOF changed')
    }
  }
  const requireOpen = (): StreamWriterResource => {
    if (failure !== undefined) throw failure
    if (facts.outcome !== 'open' || resource === undefined) throw new PrivateFileWriterError(snapshot(facts), new Error('writer is closed'))
    return resource
  }
  const sync = (key: 'preFile' | 'directory' | 'postFile', action: () => void): void => {
    update({ phase: key, synchronization: { ...facts.synchronization, [key]: 'indeterminate' } })
    try { action() }
    catch (error) { update({ synchronization: { ...facts.synchronization, [key]: 'failed' } }); throw error }
    update({ synchronization: { ...facts.synchronization, [key]: 'succeeded' } })
  }
  try {
    resource = create()
    update({ stagingName: resource.stagingName, parentIdentity: resource.parentIdentity ?? null })
    if (resource.mechanism !== mechanism) throw new Error('native stream mechanism mismatch')
    inspectionStarted = true
    const initial = resource.inspect()
    update({ identity: initial.identity, parentIdentity: facts.parentIdentity ?? initial.parentIdentity })
    inspect(initial, false)
  } catch (error) { fail(error) }

  return Object.freeze({
    get receipt(): PrivateFilePublicationReceipt { return snapshot(facts) },
    append(chunk: Uint8Array): void {
      const current = requireOpen()
      update({ phase: 'append' })
      try {
        validateStreamChunk(chunk, expected.expectedBytes - facts.acceptedBytes)
        inspect(current.inspect(), false)
        const owned = new Uint8Array(chunk)
        current.write(owned)
        hash.update(owned)
        update({ acceptedBytes: facts.acceptedBytes + owned.byteLength })
        inspect(current.inspect(), false)
      } catch (error) { fail(error) }
    },
    finish(): PrivateFilePublicationReceipt {
      if (facts.outcome === 'finished') return snapshot(facts)
      const current = requireOpen()
      update({ outcome: 'finishing', phase: 'verify-content' })
      try {
        inspect(current.inspect(), false)
        const actualSha256 = hash.digest('hex')
        update({ actualSha256 })
        if (facts.acceptedBytes !== expected.expectedBytes || actualSha256 !== expected.expectedSha256) {
          update({ contentVerification: 'failed' })
          throw new Error('stream length or digest does not match its manifest')
        }
        update({ contentVerification: 'verified', phase: 'metadata' })
        current.setExecutable(expected.executable)
        inspect(current.inspect(), expected.executable)
        sync('preFile', () => { current.syncFile() })
        inspect(current.inspect(), expected.executable)
        update({ phase: 'publish', publication: 'indeterminate' })
        try { current.publish(); update({ publication: 'published' }) }
        catch (error) {
          try { update({ publication: current.reconcile() }) }
          catch (reconcileError) { throw new AggregateError([error, reconcileError]) }
          throw error
        }
        if (facts.synchronization.directory !== 'not-required') sync('directory', () => { current.syncDirectory() })
        if (facts.synchronization.postFile !== 'not-required') sync('postFile', () => { current.syncFile() })
        update({ phase: 'verify-final' })
        try { inspect(current.verifyFinal(), expected.executable) }
        catch (error) { update({ bindingVerification: 'failed' }); throw error }
        update({ bindingVerification: 'verified', metadataVerification: 'verified', durability: 'synced', phase: 'release',
          executableMetadata: mechanism === 'windows-ntfs-write-through-rename-v1' ? 'not-required' : 'verified' })
        const errors: unknown[] = []
        release(errors)
        if (errors.length > 0) throw new AggregateError(errors)
        update({ outcome: 'finished', phase: 'finished' })
        return snapshot(facts)
      } catch (error) { return fail(error) }
    },
    abort(): PrivateFilePublicationReceipt {
      if (facts.outcome !== 'open') return snapshot(facts)
      update({ phase: 'abort' })
      const errors: unknown[] = []
      clean(errors)
      release(errors)
      update({ outcome: errors.length === 0 ? 'aborted' : 'failed' })
      if (errors.length > 0) {
        failure = new PrivateFileWriterError(snapshot(facts), new AggregateError(errors))
        throw failure
      }
      return snapshot(facts)
    },
    close(): void {
      if (released) return
      update({ phase: 'close', outcome: 'closed', cleanup: 'withheld' })
      const errors: unknown[] = []
      release(errors)
      if (errors.length > 0) {
        update({ outcome: 'failed' })
        failure = new PrivateFileWriterError(snapshot(facts), new AggregateError(errors))
        throw failure
      }
    },
  })
}
