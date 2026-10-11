/** Byte-oriented private storage with retained Windows NTFS capabilities. */

import { randomBytes } from 'node:crypto'
import { PrivateStorageError } from './error.ts'
import { loadNativeStorage } from './native.ts'
import type { Handle, NativeFacts, NativeStorageBackend as NativeStorage } from './native.ts'
import { sameIdentity, splitRootPath, validateLimit, validateName } from './policy.ts'
import { createWindowsStreamFacade } from './windows-stream-facade.ts'
import { createStreamFacade } from './stream-facade.ts'
import type { WindowsWriterParent } from './windows-stream-writer.ts'
import type { PrivateFileWriter, PrivateFileWriterOptions, SourceFileReader, SourceFileReaderOptions, SourceFileFacts } from './stream-types.ts'
import type { PrivateStreamDirectory, SourceDirectory, ManagementLease, PrivateStreamDirectoryPublication, PrivateStreamDirectoryListing,
  PrivateStreamInspectedEntry, PrivateStreamCapacity } from './stream-directory-types.ts'
import type { PrivateRecordReadResult } from './private-record-reader.ts'
import type { ControlRecordOwner, StreamCapabilities } from './stream-facade-types.ts'
import type { PrivateLogSink } from './log-types.ts'
import type { SourceDocumentReadOptions, SourceDocumentReadResult } from './source-document-reader.ts'
import type { SourceDirectoryListing } from './source-directory-types.ts'
import type { SourceLinkObservation } from './source-link.ts'
import type { ObservedSourceFileReader, ObservedSourceFileReaderOptions } from './observed-source-reader.ts'
import type { PrivateStreamRootOpening } from './root-opening.ts'
import type {
  PrivateAuditLimits, PrivateDirectory, PrivateFacts, PrivateIdentity,
  PrivateStorageCapabilities, PrivateWriterLease, PublicationReceipt,
} from './types.ts'

export { PrivateStorageError } from './error.ts'
export { observeProcessBirth } from './process-observation.ts'
export { isManagementLeaseBusy } from './management-lease-error.ts'
export type { ProcessBirthObservation } from './process-observation.ts'
export { PrivateStreamError } from './stream-error.ts'
export { PrivateStreamRootError } from './root-opening.ts'
export type { PrivateStreamRootOpening, PrivateStreamRootReceipt } from './root-opening.ts'
export { PrivateFileWriterError } from './stream-writer.ts'
export { SourceFileReaderError } from './source-reader.ts'
export { ObservedSourceFileReaderError } from './observed-source-reader.ts'
export type { ObservedSourceFileReader, ObservedSourceFileReaderOptions, ObservedSourceFileReadReceipt } from './observed-source-reader.ts'
export type { PrivateStreamDirectory, SourceDirectory, ManagementLease, PrivateStreamDirectoryFacts, PrivateStreamDirectoryListing,
  PrivateStreamInspectedEntry, PrivateStreamFileFacts, PrivateStreamCapacity, PrivateStreamDirectoryPublication } from './stream-directory-types.ts'
export type { ControlRecordOwner, StreamCapabilities, StreamNativeArtifact } from './stream-facade-types.ts'
export type { ControlRecordWriterOptions, ControlRecordWriter, ControlRecordReceipt } from './control-record.ts'
export { ControlRecordWriterError } from './control-record.ts'
export type { SourceDocumentReadOptions, SourceDocumentReadResult } from './source-document-reader.ts'
export type { SourceDirectoryFacts, SourceDirectoryEntry, SourceDirectoryListing } from './source-directory-types.ts'
export type { SourceLinkFacts, SourceLinkObservation } from './source-link.ts'
export type { PrivateRecordReadResult } from './private-record-reader.ts'
export type { PrivateLogSink, PrivateLogReceipt } from './log-types.ts'
export { PrivateLogSinkError } from './log-error.ts'
export type { WindowsSourceDirectory } from './windows-source-reader.ts'
export type { PrivateStreamOperationId, PrivateFileWriter, PrivateFileWriterOptions, PrivateFilePublicationReceipt, SourceFileFacts, SourceFileReader, SourceFileReaderOptions, SourceFileReadReceipt, StreamIdentity, StreamMechanism } from './stream-types.ts'
export { MAX_STREAM_CHUNK_BYTES, MAX_STREAM_FILE_BYTES } from './stream-policy.ts'
export type { PrivateStorageErrorCode } from './error.ts'
export type {
  PrivateAuditLimits, PrivateDirectory, PrivateFacts, PrivateIdentity,
  PrivateStorageCapabilities, PrivateWriterLease, PublicationReceipt,
} from './types.ts'

interface Guard { handle: Handle; references: number }
interface DirectoryState { kind: 'directory'; api: NativeStorage; sid: Buffer; guards: Guard[]; identity: PrivateIdentity; closed: boolean }
interface LeaseState { kind: 'lease'; parentIdentity: PrivateIdentity; closed: boolean; api: NativeStorage; guards: Guard[]; handle: Handle; unlock: () => void }
const directories = new WeakMap<PrivateDirectory, DirectoryState>()
const leases = new WeakMap<PrivateWriterLease, LeaseState>()

function releaseGuards(api: NativeStorage, guards: Guard[]): void {
  let failure: unknown
  for (const guard of guards.toReversed()) {
    guard.references--
    if (guard.references === 0) {
      try { api.close(guard.handle) } catch (error) { failure ??= error }
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new PrivateStorageError('native', 'resource release failed')
}

function releaseDirectory(state: DirectoryState): void {
  if (state.closed) return
  state.closed = true
  releaseGuards(state.api, state.guards)
}

function releaseLease(state: LeaseState): void {
  if (state.closed) return
  state.closed = true
  let failure: unknown
  try { state.unlock() } catch (error) { failure = error }
  try { state.api.close(state.handle) } catch (error) { failure ??= error }
  try { releaseGuards(state.api, state.guards) } catch (error) { failure ??= error }
  if (failure !== undefined) throw failure instanceof Error ? failure : new PrivateStorageError('native', 'resource release failed')
}

const finalizers = new FinalizationRegistry<DirectoryState | LeaseState>((state) => {
  try {
    if (state.kind === 'directory') releaseDirectory(state)
    else releaseLease(state)
  } catch (_error) { /* Explicit close reports failures; finalizers only release owned resources. */ }
})

function directory(
  api: NativeStorage, sid: Buffer, guards: Guard[], identity: PrivateIdentity, publications: readonly PublicationReceipt[],
): PrivateDirectory {
  const state: DirectoryState = { kind: 'directory', api, sid, guards, identity, closed: false }
  const capability = Object.freeze({ identity, publications: Object.freeze([...publications]), close() {
    finalizers.unregister(capability)
    releaseDirectory(state)
  } }) as PrivateDirectory
  directories.set(capability, state)
  finalizers.register(capability, state, capability)
  return capability
}

function stateOf(parent: PrivateDirectory): DirectoryState {
  const state = directories.get(parent)
  if (!state) throw new PrivateStorageError('closed', 'live directory capability required')
  validateDirectoryState(state)
  return state
}

function validateDirectoryState(state: DirectoryState): void {
  if (state.closed) throw new PrivateStorageError('closed', 'live directory capability required')
  if (!state.sid.equals(state.api.tokenUser())) throw new PrivateStorageError('privacy', 'TokenUser changed')
  const facts = state.api.inspect(handleOf(state), state.sid)
  if (facts.kind !== 'directory' || !sameIdentity(facts.identity, state.identity)) throw new PrivateStorageError('identity', 'directory changed')
  state.api.admitFilesystem(handleOf(state))
}

function handleOf(state: DirectoryState): Handle { return (state.guards.at(-1) as Guard).handle }
function retain(guards: Guard[]): Guard[] { for (const guard of guards) guard.references++; return [...guards] }
function newGuard(handle: Handle): Guard { return { handle, references: 1 } }

class RetainedWindowsWriterParent implements WindowsWriterParent {
  private readonly state: DirectoryState
  readonly api: NativeStorage
  readonly sid: Buffer
  readonly handle: Handle
  readonly identity: PrivateIdentity
  constructor(parent: PrivateDirectory) {
    const original = stateOf(parent)
    this.state = { ...original, guards: retain(original.guards), closed: false }
    this.api = original.api
    this.sid = original.sid
    this.handle = handleOf(original)
    this.identity = original.identity
  }
  validate(): void { validateDirectoryState(this.state) }
  release(): void { releaseDirectory(this.state) }
}

const windowsStreams = createWindowsStreamFacade({
  openDirectory: openPrivateDirectory, openChild: openPrivateChild, createChild: createPrivateChild,
  retainParent: parent => new RetainedWindowsWriterParent(parent), acquireLease: acquirePrivateWriterLease,
  rootParentIdentity(directory) {
    const state = stateOf(directory), parent = state.guards.at(-2) as Guard
    const facts = state.api.inspectSource(parent.handle)
    if (facts.kind !== 'directory') throw new PrivateStorageError('identity', 'retained root parent is not a directory')
    return facts.identity
  },
  assertLease(lease, parent, name) {
    const owned = leases.get(lease)
    parent.validate()
    if (owned === undefined || owned.closed || owned.api !== parent.api || !sameIdentity(owned.parentIdentity, parent.identity)) {
      throw new PrivateStorageError('closed', 'live same-provider same-parent lease required')
    }
    const observed = owned.api.inspect(owned.handle, parent.sid)
    owned.api.verifyName(owned.handle, name)
    if (observed.kind !== 'file' || !sameIdentity(observed.identity, lease.identity)) throw new PrivateStorageError('identity', 'management lease changed')
  },
})

const streams = createStreamFacade(windowsStreams, capabilities)

/**
 * Report actual stream backend availability without claiming platform acceptance or admitting a path.
 * @returns Selected native artifact and fixed stream limits, or an unavailable reason.
 */
export function streamCapabilities(): StreamCapabilities { return streams.capabilities() }

/**
 * Admit a private directory through the selected platform's retained capabilities.
 * @param path Literal private root.
 * @param options Explicit creation policy.
 * @returns Opaque stream directory.
 */
export function openPrivateStreamDirectory(path: string, options: { create: boolean }): PrivateStreamDirectory {
  return streams.openDirectory(path, options)
}
/**
 * Open a private root and report actual parent binding and creation persistence.
 * @param path Literal final component beneath an existing parent.
 * @param options Explicit final-component creation policy.
 * @returns Independently retained root and its opening receipt.
 */
export function openPrivateStreamRoot(path: string, options: { create: boolean }): PrivateStreamRootOpening {
  return streams.openRoot(path, options)
}
/**
 * Open an existing private child while independently retaining its ancestors.
 * @param parent Live private stream parent.
 * @param name Exact child component.
 * @returns Independently retained existing child.
 */
export function openPrivateStreamChild(parent: PrivateStreamDirectory, name: string): PrivateStreamDirectory {
  return streams.openChild(parent, name)
}
/**
 * Exclusively publish a private child directory with separate synchronization observations.
 * @param parent Live private stream parent.
 * @param name Absent child component.
 * @returns Published child and independent publication facts.
 */
export function createPrivateStreamChild(parent: PrivateStreamDirectory, name: string): {
  directory: PrivateStreamDirectory
  receipt: PrivateStreamDirectoryPublication
} { return streams.createChild(parent, name) }
/**
 * Create a bounded staging writer that publishes a new file without replacement.
 * @param parent Live admitted directory.
 * @param name Absent final name.
 * @param options Exact manifest.
 * @returns Append-only immutable writer.
 */
export function createPrivateFileWriter(
  parent: PrivateStreamDirectory | PrivateDirectory, name: string, options: PrivateFileWriterOptions,
): PrivateFileWriter { return streams.createWriter(parent, name, options) }
/**
 * Read a bounded private control record and compute its observed digest.
 * @param parent Live private root.
 * @param name Existing record.
 * @param options Explicit bounded read.
 * @returns Same-handle bytes/digest/facts.
 */
export function readPrivateRecord(parent: PrivateStreamDirectory, name: string, options: { maxBytes: number }): PrivateRecordReadResult {
  return streams.readRecord(parent, name, options)
}
/**
 * Read a private output against its planned identity, size and digest.
 * @param parent Live private root.
 * @param name Existing private output.
 * @param options Exact source expectation.
 * @returns Bounded strict reader.
 */
export function openPrivateFileReader(parent: PrivateStreamDirectory, name: string, options: SourceFileReaderOptions): SourceFileReader {
  return streams.openFileReader(parent, name, options)
}
/**
 * Enumerate a complete bounded inventory through the retained private directory.
 * @param parent Live private root.
 * @param maximum Complete enumeration ceiling.
 * @returns Full observed inventory, or a failure.
 */
export function listPrivateStreamDirectory(parent: PrivateStreamDirectory, maximum: number): PrivateStreamDirectoryListing {
  return streams.list(parent, maximum)
}
/**
 * Inspect an existing private file or directory through retained no-follow handles.
 * @param parent Live private root.
 * @param name Exact existing entry.
 * @returns Discriminated private directory/file admission facts.
 */
export function inspectPrivateStreamEntry(parent: PrivateStreamDirectory, name: string): PrivateStreamInspectedEntry {
  return streams.inspect(parent, name)
}
/**
 * Measure available destination capacity without reserving space.
 * @param parent Live private root.
 * @returns Native caller-available capacity observation; never a reservation.
 */
export function observePrivateStreamCapacity(parent: PrivateStreamDirectory): PrivateStreamCapacity {
  return streams.capacity(parent)
}
/**
 * Acquire a nonblocking kernel lease for cooperating management writers.
 * @param parent Live private root.
 * @param name Fixed lock entry.
 * @returns Nonblocking caller-owned same-parent kernel lease.
 */
export function acquireManagementLease(parent: PrivateStreamDirectory, name: string): ManagementLease {
  return streams.acquireLease(parent, name)
}
/**
 * Check that a management lease is live and belongs to the same provider and parent.
 * @param parent Live private root.
 * @param lease Caller-owned lease.
 */
export function assertManagementLease(parent: PrivateStreamDirectory, lease: ManagementLease): void {
  streams.assertLease(parent, lease)
}
/**
 * Restrict generated control-record reads and replacements to fixed names under a caller-held lease.
 * @param parent Managed private root.
 * @param lease Live same-parent lease.
 * @param names Fixed generated names.
 * @returns Scoped read/replace authority.
 */
export function createControlRecordOwner(
  parent: PrivateStreamDirectory, lease: ManagementLease, names: readonly string[],
): ControlRecordOwner {
  return streams.controlOwner(parent, lease, names)
}
/**
 * Open a retained append-only private log through the Windows provider.
 * @param parent Live private root.
 * @param name Fixed log entry.
 * @param options Explicit chunk ceiling.
 * @returns Retained append-only sink.
 */
export function openPrivateLogSink(parent: PrivateStreamDirectory, name: string, options: { maxChunkBytes: number }): PrivateLogSink {
  return streams.openLog(parent, name, options)
}

/**
 * Retain a readonly source directory without granting private destination authority.
 * @param path Literal readonly source root.
 * @returns Opaque independently closable shared-source authority.
 */
export function openSourceDirectory(path: string): SourceDirectory { return streams.openSource(path) }
/**
 * Observe one symbolic link without following its target or granting target authority.
 * @param parent Retained readonly source parent.
 * @param name Literal leaf component.
 * @param options Target UTF-8 byte limit at most 32768.
 * @returns Complete before/after link observations and the unchanged literal target.
 */
export function inspectSourceLink(parent: SourceDirectory, name: string, options: { maxBytes: number }): SourceLinkObservation {
  return streams.inspectSourceLink(parent, name, options)
}
/**
 * Stream a provisional source and compute its complete digest without prior artifact authority.
 * @param parent Retained readonly source parent.
 * @param name Literal source leaf.
 * @param options Exact provisional observations and a maximum of 1 GiB.
 * @returns Reader with chunks at most 1 MiB and independently reported observation/release facts.
 */
export function openObservedSourceFileReader(
  parent: SourceDirectory, name: string, options: ObservedSourceFileReaderOptions,
): ObservedSourceFileReader {
  return streams.openObservedSourceReader(parent, name, options)
}
/**
 * Open a readonly source child while independently retaining its admitted ancestors.
 * @param directory Retained readonly source parent.
 * @param name Literal child directory component.
 * @returns Independently retained child with the existing readonly source policy.
 */
export function openSourceChild(directory: SourceDirectory, name: string): SourceDirectory {
  return streams.openSourceChild(directory, name)
}
/**
 * Enumerate complete source names and distinguish entries not admitted for copying.
 * @param directory Retained readonly source directory.
 * @param maximum Complete-name ceiling from zero through 100000.
 * @returns Complete observed names; unadmitted entries grant no copy or link-reconstruction authority.
 */
export function listSourceDirectory(directory: SourceDirectory, maximum: number): SourceDirectoryListing {
  return streams.listSource(directory, maximum)
}
/**
 * Observe an existing source file without certifying its complete contents.
 * @param directory Live source root.
 * @param name Existing component.
 * @returns Provisional facts without a trusted digest claim.
 */
export function inspectSourceFile(directory: SourceDirectory, name: string): SourceFileFacts {
  return streams.inspectSource(directory, name)
}
/**
 * Read a source against its exact planned identity, size and digest.
 * @param directory Live source root.
 * @param name Existing component.
 * @param options Exact frozen source manifest.
 * @returns Strict bounded reader.
 */
export function openSourceFileReader(directory: SourceDirectory, name: string, options: SourceFileReaderOptions): SourceFileReader {
  return streams.openSourceReader(directory, name, options)
}

/**
 * Read an observed original/draft document without weakening artifact digest requirements.
 * @param directory Readonly source capability.
 * @param name Literal document component.
 * @param options Expected source observations and an independent byte ceiling at most64MiB.
 * @returns Same-handle bytes and computed digest after confirmed release.
 */
export function readSourceDocument(directory: SourceDirectory, name: string, options: SourceDocumentReadOptions): SourceDocumentReadResult {
  return streams.readSourceDocument(directory, name, options)
}


function contextualFailure(
  error: unknown, details: NonNullable<ConstructorParameters<typeof PrivateStorageError>[2]>,
): PrivateStorageError {
  return new PrivateStorageError(error instanceof PrivateStorageError ? error.code : 'native', 'operation failed', {
    ...(error instanceof PrivateStorageError && error.nativeStatus !== null ? { nativeStatus: error.nativeStatus } : {}),
    ...(error instanceof PrivateStorageError && error.win32Code !== null ? { win32Code: error.win32Code } : {}),
    ...(error instanceof PrivateStorageError && error.receipt !== undefined ? { receipt: error.receipt } : {}),
    ...details,
  })
}

function failAfterCleanup(error: unknown, cleanup: () => void, publications: readonly PublicationReceipt[] = []): never {
  let cleanupFailed = false
  try { cleanup() } catch (_cleanupError) { cleanupFailed = true }
  if (cleanupFailed || publications.length) throw contextualFailure(error, {
    cleanupFailed: cleanupFailed || (error instanceof PrivateStorageError && error.cleanupFailed), directoryPublications: publications,
  })
  throw error
}

function withHandle<T>(api: NativeStorage, handle: Handle, operation: () => T): T {
  let result: T
  try { result = operation() }
  catch (error) { failAfterCleanup(error, () => { api.close(handle) }) }
  api.close(handle)
  return result
}

function inspectNamed(state: DirectoryState, name: string, kind: 'file' | 'directory' | 'any', mode: 'inspect' | 'read' | 'lock' | 'delete'): { handle: Handle; facts: NativeFacts } {
  const handle = state.api.open(handleOf(state), name, kind, mode, state.sid)
  try {
    const facts = state.api.inspect(handle, state.sid)
    state.api.verifyName(handle, name)
    if (kind !== 'any' && facts.kind !== kind) throw new PrivateStorageError('identity', 'unexpected object type')
    return { handle, facts }
  } catch (error) { failAfterCleanup(error, () => { state.api.close(handle) }) }
}

function existingTarget(state: DirectoryState, name: string): NativeFacts | null {
  let opened: ReturnType<typeof inspectNamed>
  try { opened = inspectNamed(state, name, 'any', 'inspect') }
  catch (error) { if (error instanceof PrivateStorageError && error.code === 'not-found') return null; throw error }
  return withHandle(state.api, opened.handle, () => {
    if (opened.facts.kind !== 'file') throw new PrivateStorageError('identity', 'regular destination required')
    if ((opened.facts.attributes & 1) !== 0) throw new PrivateStorageError('unsupported', 'readonly destination')
    return opened.facts
  })
}

function reconcilePublication(state: DirectoryState, name: string, staging: string, identity: PrivateIdentity): PublicationReceipt['publication'] {
  const identityAt = (component: string): PrivateIdentity | null => {
    let handle: Handle
    try { handle = state.api.open(handleOf(state), component, 'any', 'inspect', state.sid) }
    catch (error) { if (error instanceof PrivateStorageError && error.code === 'not-found') return null; throw error }
    try {
      state.api.verifyName(handle, component)
      return state.api.inspect(handle, state.sid, false).identity
    } finally { state.api.close(handle) }
  }
  try {
    const final = identityAt(name)
    if (final && sameIdentity(final, identity)) return 'published'
    const temporary = identityAt(staging)
    if (temporary && sameIdentity(temporary, identity)) return 'not-published'
  } catch (_reconciliationError) { /* Incomplete read-only reconciliation cannot authorize cleanup. */ }
  return 'indeterminate'
}

function failureWithReceipt(error: unknown, receipt: PublicationReceipt): PrivateStorageError {
  return new PrivateStorageError(error instanceof PrivateStorageError ? error.code : 'native', 'publication failed', {
    receipt: Object.freeze(receipt),
    cleanupFailed: receipt.cleanup === 'failed' || (error instanceof PrivateStorageError && error.cleanupFailed),
    ...(error instanceof PrivateStorageError && error.nativeStatus !== null ? { nativeStatus: error.nativeStatus } : {}),
    ...(error instanceof PrivateStorageError && error.win32Code !== null ? { win32Code: error.win32Code } : {}),
  })
}

type PublishedReceipt = PublicationReceipt & { readonly identity: PrivateIdentity }
function publish(state: DirectoryState, name: string, bytes: null, replace: boolean): { receipt: PublishedReceipt; handle: Handle }
function publish(state: DirectoryState, name: string, bytes: Buffer, replace: boolean): { receipt: PublishedReceipt; handle: null }
function publish(
  state: DirectoryState, name: string, bytes: Buffer | null, replace: boolean,
): { receipt: PublishedReceipt; handle: Handle | null } {
  let source: Handle | null = null
  let publication: PublicationReceipt['publication'] = 'not-published'
  let durability: PublicationReceipt['durability'] = 'unconfirmed'
  let identity: PrivateIdentity | null = null
  let phase = 'validate'
  let cleanup: PublicationReceipt['cleanup'] = 'not-needed'
  let nativeStatus: number | null = null
  const staging = `.dsh-private-${randomBytes(20).toString('hex')}`
  const makeReceipt = (): PublicationReceipt => Object.freeze({
    publication, durability, phase, identity, parentIdentity: state.identity, nativeStatus, cleanup,
  })
  try {
    if (bytes !== null) existingTarget(state, name)
    phase = 'create'
    source = state.api.open(handleOf(state), staging, bytes === null ? 'directory' : 'file', 'create', state.sid)
    const created = state.api.inspect(source, state.sid)
    identity = created.identity
    if (created.kind !== (bytes === null ? 'directory' : 'file') || !created.writeThrough || identity.volumeSerial !== state.identity.volumeSerial) {
      throw new PrivateStorageError('unsupported', 'write-through same-volume staging required')
    }
    if (bytes !== null) {
      phase = 'write'
      state.api.write(source, bytes)
      phase = 'pre-publication-flush'
      state.api.flush(source)
    }
    const beforeRename = state.api.inspect(source, state.sid)
    if (!sameIdentity(beforeRename.identity, identity) || !beforeRename.writeThrough
      || (bytes !== null && beforeRename.sizeBytes !== BigInt(bytes.length))) throw new PrivateStorageError('changed', 'staging changed')
    phase = 'rename'
    publication = 'indeterminate'
    try { state.api.rename(source, handleOf(state), name, replace) }
    catch (error) {
      publication = reconcilePublication(state, name, staging, identity)
      if (error instanceof PrivateStorageError && error.nativeStatus !== null) nativeStatus = error.nativeStatus
      throw error
    }
    publication = 'published'
    if (bytes !== null) {
      phase = 'post-publication-flush'
      state.api.flush(source)
    }
    phase = 'verify'
    const final = inspectNamed(state, name, 'any', 'inspect')
    try {
      const sourceFacts = state.api.inspect(source, state.sid)
      if (!sameIdentity(final.facts.identity, identity) || !sameIdentity(sourceFacts.identity, identity)
        || final.facts.kind !== created.kind || !sourceFacts.writeThrough
        || (bytes !== null && sourceFacts.sizeBytes !== BigInt(bytes.length))) throw new PrivateStorageError('changed', 'published binding changed')
    } finally { state.api.close(final.handle) }
    // NTFS write-through source-handle rename is the directory namespace persistence operation.
    durability = 'synced'
    phase = 'close'
    const closing = source
    source = null
    try { state.api.close(closing) }
    catch (error) { cleanup = 'failed'; throw error }
    if (bytes === null) {
      phase = 'retain-directory-guard'
      source = state.api.open(handleOf(state), name, 'directory', 'inspect', state.sid)
      const guarded = state.api.inspect(source, state.sid)
      state.api.verifyName(source, name)
      state.api.admitFilesystem(source)
      if (!sameIdentity(guarded.identity, identity)) throw new PrivateStorageError('identity', 'published directory changed')
    }
    phase = 'complete'
    return { receipt: Object.freeze({ ...makeReceipt(), identity }), handle: source }
  } catch (error) {
    if (error instanceof PrivateStorageError && error.nativeStatus !== null) nativeStatus = error.nativeStatus
    if (source !== null) {
      if (publication === 'not-published') {
        try { state.api.remove(source); cleanup = 'delete-pending' } catch (_cleanupError) { cleanup = 'failed' }
      } else cleanup = 'withheld'
      try { state.api.close(source) } catch (_closeError) { cleanup = 'failed' }
    }
    throw failureWithReceipt(error, makeReceipt())
  }
}

/**
 * Report backend availability and actual native payload; this does not admit a storage location.
 * @returns Current OS/architecture selection and typed-unavailable reason where applicable.
 */
export function capabilities(): PrivateStorageCapabilities {
  const facts = { platform: process.platform, architecture: process.arch }
  try {
    const api = loadNativeStorage()
    return Object.freeze({ ...facts, available: true, backend: 'windows-ntfs', nativeArtifact: api.artifact,
      ...api.ownershipArtifact === undefined ? {} : { ownershipArtifact: api.ownershipArtifact } })
  }
  catch (error) { return Object.freeze({ ...facts, available: false, backend: null, reason: error instanceof PrivateStorageError ? error.message : 'native backend unavailable' }) }
}

/**
 * Walk literal local-drive ancestors, retaining non-delete-shared guards; admit or privately create the root.
 * The caller must trust ancestor owners. Existing objects are inspected, never repaired.
 * @param path - Literal absolute Windows drive path; junction ancestors are rejected.
 * @param options - Whether to publish missing levels with exact private descriptors.
 * @returns Opaque directory with separate receipts for newly published levels.
 */
export function openPrivateDirectory(path: string, options: { create: boolean }): PrivateDirectory {
  const { volume, components } = splitRootPath(path)
  const api = loadNativeStorage()
  const sid = api.tokenUser()
  const guards: Guard[] = []
  const publications: PublicationReceipt[] = []
  try {
    const volumeGuard = newGuard(api.open(null, volume, 'directory', 'inspect', sid))
    guards.push(volumeGuard)
    let parentFacts = api.inspect(volumeGuard.handle, sid, false)
    api.admitFilesystem(volumeGuard.handle)
    let privateChain = false
    for (const [index, name] of components.entries()) {
      const parent: DirectoryState = { kind: 'directory', api, sid, guards, identity: parentFacts.identity, closed: false }
      let handle: Handle
      try { handle = api.open(handleOf(parent), name, 'directory', 'inspect', sid) }
      catch (error) {
        if (!(options.create && error instanceof PrivateStorageError && error.code === 'not-found')) throw error
        try {
          const result = publish(parent, name, null, false)
          publications.push(result.receipt)
          handle = result.handle
          privateChain = true
        } catch (creationError) {
          if (!(creationError instanceof PrivateStorageError && creationError.code === 'collision'
            && creationError.receipt?.publication === 'not-published')) throw creationError
          handle = api.open(handleOf(parent), name, 'directory', 'inspect', sid)
          privateChain = true
        }
      }
      guards.push(newGuard(handle))
      api.verifyName(handle, name)
      parentFacts = api.inspect(handle, sid, privateChain || index === components.length - 1)
      if (parentFacts.kind !== 'directory') throw new PrivateStorageError('identity', 'directory required')
      api.admitFilesystem(handle)
    }
    return directory(api, sid, guards, parentFacts.identity, publications)
  } catch (error) { failAfterCleanup(error, () => { releaseGuards(api, guards) }, publications) }
}

/**
 * Open one existing exact-policy child while retaining the complete ancestor chain.
 * @param parent - Live admitted private directory.
 * @param name - Literal long-name component with exact stored casing.
 * @returns Independently closable retained child.
 */
export function openPrivateChild(parent: PrivateDirectory, name: string): PrivateDirectory {
  validateName(name)
  const state = stateOf(parent)
  const child = inspectNamed(state, name, 'directory', 'inspect')
  try { state.api.admitFilesystem(child.handle) }
  catch (error) { failAfterCleanup(error, () => { state.api.close(child.handle) }) }
  return directory(state.api, state.sid, [...retain(state.guards), newGuard(child.handle)], child.facts.identity, [])
}

/**
 * Publish an empty, protected child directory without replacing a collision winner.
 * @param parent - Live admitted private parent.
 * @param name - Literal destination component.
 * @returns Independently closable directory and its namespace publication receipt.
 */
export function createPrivateChild(parent: PrivateDirectory, name: string): { directory: PrivateDirectory; receipt: PublicationReceipt } {
  validateName(name)
  const state = stateOf(parent)
  const result = publish(state, name, null, false)
  const child = directory(state.api, state.sid, [...retain(state.guards), newGuard(result.handle)],
    result.receipt.identity, [result.receipt])
  return { directory: child, receipt: result.receipt }
}

/**
 * Inspect one exact-policy entry through one retained no-follow handle.
 * @param parent - Live private parent.
 * @param name - Literal component.
 * @returns Complete object facts; incomplete reads fail instead of returning partial facts.
 */
export function inspectPrivate(parent: PrivateDirectory, name: string): PrivateFacts {
  validateName(name)
  const state = stateOf(parent)
  const opened = inspectNamed(state, name, 'any', 'inspect')
  return withHandle(state.api, opened.handle, () => opened.facts)
}

/**
 * Read once-opened bytes with denied write sharing and pre/post identity, privacy and size checks.
 * @param parent - Live private parent.
 * @param name - Literal component.
 * @param maxBytes - Explicit maximum between zero and 64 MiB.
 * @returns A new bounded byte array; no JSON or text interpretation is performed.
 */
export function readPrivateFile(parent: PrivateDirectory, name: string, maxBytes: number): Uint8Array {
  validateName(name)
  validateLimit(maxBytes)
  const state = stateOf(parent)
  const opened = inspectNamed(state, name, 'file', 'read')
  return withHandle(state.api, opened.handle, () => {
    if (opened.facts.sizeBytes > BigInt(maxBytes)) throw new PrivateStorageError('limit', 'file exceeds read limit')
    const bytes = Buffer.alloc(Number(opened.facts.sizeBytes))
    let offset = 0
    while (offset < bytes.length) {
      const count = state.api.read(opened.handle, bytes.subarray(offset, Math.min(offset + 65536, bytes.length)))
      if (count === 0) throw new PrivateStorageError('changed', 'file truncated while reading')
      offset += count
    }
    if (state.api.read(opened.handle, Buffer.alloc(1)) !== 0) throw new PrivateStorageError('changed', 'file grew while reading')
    const after = state.api.inspect(opened.handle, state.sid)
    if (!sameIdentity(opened.facts.identity, after.identity) || opened.facts.sizeBytes !== after.sizeBytes
      || opened.facts.lastWriteTime !== after.lastWriteTime || opened.facts.changeTime !== after.changeTime) throw new PrivateStorageError('changed', 'file changed while reading')
    return bytes
  })
}

function publishFile(parent: PrivateDirectory, name: string, input: Uint8Array, replace: boolean): PublicationReceipt {
  validateName(name)
  validateLimit(input.byteLength)
  if (input.buffer instanceof SharedArrayBuffer) throw new PrivateStorageError('unsupported', 'shared input memory')
  const bytes = Buffer.from(input)
  return publish(stateOf(parent), name, bytes, replace).receipt
}

/**
 * Publish completely initialized, twice-flushed bytes under a previously absent final name.
 * @param parent - Live private parent; cooperative transaction locking remains caller-owned.
 * @param name - Literal final component.
 * @param bytes - Immutable operation input, copied before native work.
 * @returns Namespace and durability receipt; failures retain an honest receipt on the error.
 */
export function createPrivateFileExclusive(parent: PrivateDirectory, name: string, bytes: Uint8Array): PublicationReceipt {
  return publishFile(parent, name, bytes, false)
}

/**
 * Atomically replace a checked private single-link file, or create it if absent; not hostile-writer CAS.
 * @param parent - Live private parent; cooperating writers must serialize transactions with a lease.
 * @param name - Literal final component.
 * @param bytes - Immutable operation input, copied before native work.
 * @returns Namespace and durability receipt, preserving published/indeterminate failures.
 */
export function replacePrivateFile(parent: PrivateDirectory, name: string, bytes: Uint8Array): PublicationReceipt {
  return publishFile(parent, name, bytes, true)
}

/**
 * Acquire a fixed private file's nonblocking LockFileEx lease; leave the lock file in place forever.
 * The actual writer must acquire its own lease before application writes begin.
 * @param parent - Live private root.
 * @param name - Fixed literal lock-file component shared by all cooperating processes.
 * @returns Owned lease; process death releases the kernel lock, without PID-based recovery.
 */
export function acquirePrivateWriterLease(parent: PrivateDirectory, name: string): PrivateWriterLease {
  validateName(name)
  const state = stateOf(parent)
  let opened: ReturnType<typeof inspectNamed>
  try { opened = inspectNamed(state, name, 'file', 'lock') }
  catch (error) {
    if (!(error instanceof PrivateStorageError && error.code === 'not-found')) throw error
    try { publish(state, name, Buffer.alloc(0), false) }
    catch (creationError) {
      if (!(creationError instanceof PrivateStorageError && creationError.code === 'collision' && creationError.receipt?.publication === 'not-published')) throw creationError
    }
    opened = inspectNamed(state, name, 'file', 'lock')
  }
  let unlock: () => void
  try { unlock = state.api.lock(opened.handle) }
  catch (error) { failAfterCleanup(error, () => { state.api.close(opened.handle) }) }
  const guards = retain(state.guards)
  const lease: LeaseState = { kind: 'lease', parentIdentity: state.identity, closed: false, api: state.api, guards, handle: opened.handle, unlock }
  const capability = Object.freeze({ identity: opened.facts.identity, release() {
    finalizers.unregister(capability)
    releaseLease(lease)
  }, close() { capability.release() } }) as PrivateWriterLease
  leases.set(capability, lease)
  finalizers.register(capability, lease, capability)
  return capability
}

/**
 * Delete only a checked retained private entry; this does not promise crash-durable namespace deletion.
 * @param parent - Live private parent in the identity's capability domain.
 * @param name - Literal component.
 * @param expectedIdentity - Complete expected identity; an identity alone grants no access.
 * @returns Pending deletion fact after disposition succeeds and the owned handle closes.
 */
export function removeOwnedEntry(parent: PrivateDirectory, name: string, expectedIdentity: PrivateIdentity): { deletion: 'pending'; identity: PrivateIdentity } {
  validateName(name)
  const state = stateOf(parent)
  const opened = inspectNamed(state, name, 'any', 'delete')
  return withHandle(state.api, opened.handle, () => {
    if (!sameIdentity(opened.facts.identity, expectedIdentity)) throw new PrivateStorageError('identity', 'entry differs from expected identity')
    state.api.remove(opened.handle)
    return { deletion: 'pending' as const, identity: opened.facts.identity }
  })
}

/**
 * Audit every currently enumerated descendant under a live cooperative writer lease.
 * Future external creation and hostile same-user mutation remain outside this attestation.
 * @param parent - Live private root.
 * @param limits - Positive entry ceiling and nonnegative depth ceiling, bounded to avoid resource exhaustion.
 * @param writer - Live lease in this root's fixed lock domain.
 * @returns Complete bounded traversal count; any unknown object or exhausted limit fails closed.
 */
export function auditPrivateTree(
  parent: PrivateDirectory, limits: PrivateAuditLimits, writer: PrivateWriterLease,
): { complete: true; entries: number } {
  const state = stateOf(parent)
  const lease = leases.get(writer)
  if (!lease || lease.closed || !sameIdentity(lease.parentIdentity, state.identity)) throw new PrivateStorageError('closed', 'live root writer lease required')
  if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 100000
    || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > 128) throw new PrivateStorageError('limit', 'audit limits')
  let entries = 0
  const visit = (current: DirectoryState, depth: number): void => {
    const names = current.api.names(handleOf(current), limits.maxEntries - entries)
    entries += names.length
    if (entries > limits.maxEntries) throw new PrivateStorageError('limit', 'audit entries')
    for (const name of names) {
      validateName(name)
      const opened = inspectNamed(current, name, 'any', 'inspect')
      withHandle(current.api, opened.handle, () => {
        if (opened.facts.kind === 'directory') {
          if (depth === limits.maxDepth) throw new PrivateStorageError('limit', 'audit depth')
          const child = inspectNamed(current, name, 'directory', 'inspect')
          withHandle(current.api, child.handle, () => {
            if (!sameIdentity(child.facts.identity, opened.facts.identity)) throw new PrivateStorageError('identity', 'audit directory binding changed')
            current.api.admitFilesystem(child.handle)
            visit({ ...current, guards: [...current.guards, newGuard(child.handle)], identity: child.facts.identity }, depth + 1)
          })
        }
      })
    }
  }
  visit(state, 0)
  return { complete: true, entries }
}
