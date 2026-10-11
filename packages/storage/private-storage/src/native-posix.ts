/** POSIX source/private directory capabilities and adapters for the shared bounded stream lifecycle. */
import type { SourceDirectoryFacts, SourceDirectoryListing, SourceDirectoryEntry } from './source-directory-types.ts'
import type { SourceLinkFacts, SourceLinkObservation } from './source-link.ts'
import { createHash, randomBytes } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { PrivateStreamRootError, type PrivateStreamRootReceipt } from './root-opening.ts'
import { inspectPosixStorageRuntime, loadPosixStoragePrimitives, type PosixObjectFacts, type PosixStorageDirectory, type PosixStorageFile,
  type PosixStorageFacts, type PosixStorageCreationFacts, type PosixStorageLease, type PosixStorageReplacement, type PosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import { readBoundedSourceDocument, type SourceDocumentReadOptions, type SourceDocumentReadResult } from './source-document-reader.ts'
import { createBoundedSourceReader } from './source-reader.ts'
import { createObservedSourceReader, type ObservedSourceFileReaderOptions } from './observed-source-reader.ts'
import { PrivateStreamError, SourceObservationError } from './stream-error.ts'
import { readBoundedPrivateRecord, type PrivateRecordReadResult } from './private-record-reader.ts'
import { createBoundedControlRecordWriter, type ControlRecordWriter, type ControlRecordWriterOptions,
  type ControlRecordReplacementFacts, type ControlRecordResource } from './control-record.ts'
import { sameStreamIdentity } from './stream-policy.ts'
import { createBoundedFileWriter } from './stream-writer.ts'
import type { SourceReaderResource, StreamFileFacts, StreamWriterResource } from './stream-native.ts'
import type { PrivateStreamDirectoryFacts, PrivateStreamDirectoryListing, PrivateStreamInspectedEntry,
  PrivateStreamCapacity, PrivateStreamDirectoryPublication } from './stream-directory-types.ts'
import type { PrivateFileWriter, PrivateFileWriterOptions, SourceFileFacts, SourceFileReader,
  SourceFileReaderOptions, StreamIdentity, StreamMechanism } from './stream-types.ts'

/** Provider-bound retained source or destination directory; it is not a pathname authority. */
export interface PosixStreamDirectory {
  readonly identity: StreamIdentity
  readonly policy: 'source' | 'private'
  readonly facts: PosixStorageFacts
  /** Release this wrapper; readers/writers already opened retain their own parents. */
  close(): void
}

interface DirectoryState {
  readonly native: PosixStoragePrimitives
  readonly capability: PosixStorageDirectory
  readonly policy: 'source' | 'private'
  closed: boolean
}
const directories = new WeakMap<PosixStreamDirectory, DirectoryState>()

/** Provider-bound kernel lease; closing it never removes its lock record. */
export interface PosixManagementLease {
  readonly identity: StreamIdentity
  readonly parentIdentity: StreamIdentity
  /** Release the kernel lease once. */
  close(): void
}
interface LeaseState {
  readonly native: PosixStoragePrimitives
  readonly capability: PosixStorageLease
  readonly parentIdentity: StreamIdentity
  readonly name: string
  closed: boolean
}
const leases = new WeakMap<PosixManagementLease, LeaseState>()

/** Fixed generated-record namespace; it has no authority over arbitrary original Profile paths. */
export interface PosixControlRecordOwner {
  readonly names: readonly string[]
  /**
   * Read one admitted generated record.
   * @param name Name admitted when the owner was constructed.
   * @param options Explicit bound at most 64 MiB.
   * @returns Same-handle observations, detached bytes and computed digest.
   */
  read(name: string, options: { maxBytes: number }): PrivateRecordReadResult
  /**
   * Verify the current generated record before creating private replacement staging.
   * @param name Name admitted when the owner was constructed.
   * @param options Current digest/facts, revision verifier and replacement manifest.
   * @returns One bounded replacement writer retaining the current file; caller retains lease ownership.
   */
  replace(name: string, options: ControlRecordWriterOptions): ControlRecordWriter
}

function identity(value: PosixObjectFacts): StreamIdentity {
  return Object.freeze({ backend: 'posix', device: value.dev, inode: value.ino })
}
function boundedNumber(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('native size or link count is outside the supported integer range')
  return number
}
function sourceFacts(value: PosixStorageFacts): SourceFileFacts {
  if (value.kind !== 'regular' || !value.bindingVerified) throw new Error('source is not a bound regular file')
  const observations = Object.freeze({
    dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode, nlink: value.nlink,
    size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs,
    filesystemType: value.filesystem.type, filesystemName: value.filesystem.name,
    filesystemReadOnly: value.filesystem.readOnly, filesystemId: value.filesystem.fsid,
    filesystemBlockSize: value.filesystem.blockSize, aclModel: value.acl.model, aclEntries: value.acl.entries,
    aclDefaultEntries: value.acl.defaultEntries, aclSupported: value.acl.supported,
  })
  return Object.freeze({ identity: identity(value), sizeBytes: boundedNumber(value.size), links: boundedNumber(value.nlink),
    observations, changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
}
function sourceObservation<T>(operation: () => T): T {
  try { return operation() }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESTALE') {
      throw new SourceObservationError(error)
    }
    throw error
  }
}

function sourceResource(native: PosixStoragePrimitives, file: PosixStorageFile): SourceReaderResource {
  return { inspect: () => sourceObservation(() => sourceFacts(native.inspect(file))),
    read: count => sourceObservation(() => native.read(file, count)), close: () => { native.close(file) } }
}

function stateOf(directory: PosixStreamDirectory, policy: 'source' | 'private'): DirectoryState {
  const state = directories.get(directory)
  if (state === undefined || state.closed || state.policy !== policy) throw new Error('invalid, closed or wrong-policy POSIX directory capability')
  state.native.inspect(state.capability)
  return state
}
function wrapDirectory(native: PosixStoragePrimitives, capability: PosixStorageDirectory, policy: 'source' | 'private'): PosixStreamDirectory {
  const observed = native.inspect(capability)
  if (observed.kind !== 'directory' || !nativeBoolean(observed.bindingVerified, true)) throw new Error('native directory binding is unverified')
  const state: DirectoryState = { native, capability, policy, closed: false }
  const directory: PosixStreamDirectory = Object.freeze({
    identity: identity(observed), policy,
    facts: Object.freeze({ ...observed, filesystem: Object.freeze({ ...observed.filesystem }), acl: Object.freeze({ ...observed.acl }),
      creationSync: Object.freeze({ ...observed.creationSync }) }),
    close(): void { if (!state.closed) { state.closed = true; native.close(capability) } },
  })
  directories.set(directory, state)
  return directory
}
function openDirectory(path: string, policy: 'source' | 'private', create: boolean): PosixStreamDirectory {
  const native = loadPosixStoragePrimitives()
  const capability = native.openDirectory(path, policy, create)
  try { return wrapDirectory(native, capability, policy) }
  catch (error) {
    try { native.close(capability) } catch (releaseError) { throw new AggregateError([error, releaseError], 'directory admission and release failed') }
    throw error
  }
}

/**
 * Retain a component-wise no-follow readonly source root. Source mode/owner/ACLs are never repaired.
 * @param path Canonical absolute source directory, including supported shared/read-only local storage.
 * @returns A provider-bound source capability with actual filesystem observations.
 */
export function openPosixSourceDirectory(path: string): PosixStreamDirectory { return openDirectory(path, 'source', false) }

/**
 * @param directory Retained source parent.
 * @param name Literal leaf.
 * @param maximum Target byte ceiling.
 * @returns Same-object unresolved link facts.
 */
export function inspectPosixSourceLink(directory: PosixStreamDirectory, name: string, maximum: number): SourceLinkObservation {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32768) throw new RangeError('link target bound must be 1 through 32768')
  const state = stateOf(directory, 'source')
  const observed = sourceObservation(() => state.native.inspectSourceLink(state.capability, name, maximum))
  if (!nativeBoolean(observed.bindingVerified, true) || !nativeBoolean(observed.released, true) || observed.before.kind !== 'symlink'
    || observed.after.kind !== 'symlink' || !sameStat(observed.before, observed.after)) throw new SourceObservationError(new Error('native link observation is incomplete'))
  const bytes = Buffer.from(observed.targetBytes)
  const literalTarget = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (bytes.length < 1 || bytes.length > maximum || literalTarget.includes('\0')) throw new Error('invalid literal symbolic-link target')
  const project = (facts: PosixObjectFacts): SourceLinkFacts => {
    const observations = Object.freeze({ dev: facts.dev, ino: facts.ino, uid: facts.uid, gid: facts.gid, mode: facts.mode,
      size: facts.size, nlink: facts.nlink, mtimeNs: facts.mtimeNs, ctimeNs: facts.ctimeNs })
    const links = boundedNumber(facts.nlink)
    if (links < 1) throw new Error('live link observation required')
    return Object.freeze({ identity: identity(facts), links, observations,
      changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
  }
  return Object.freeze({ kind: 'symbolic-link', literalTarget, relative: !literalTarget.startsWith('/'),
    before: project(observed.before), after: project(observed.after) })
}

/**
 * Admit an owner-only private persistent directory; unsupported volumes fail before creation.
 * @param path Canonical absolute directory.
 * @param options Whether only the last absent component may be created and synchronized.
 * @returns A retained private capability; existing permissions remain untouched.
 */
export function openPosixPrivateDirectory(path: string, options: { create: boolean }): PosixStreamDirectory {
  return openDirectory(path, 'private', options.create)
}

/**
 * Open only the final root below an existing retained parent, preserving actual creation synchronization.
 * @param path Literal absolute root path.
 * @param options Whether the final absent component may be created.
 * @returns Private root and qualified opening facts; existing-root persistence remains unclaimed.
 */
export function openPosixPrivateStreamRoot(path: string, options: { create: boolean }): {
  directory: PosixStreamDirectory
  receipt: PrivateStreamRootReceipt
} {
  if (path === '/' || !path.startsWith('/') || path.endsWith('/')) throw new RangeError('root enrollment requires a literal final component')
  const name = pathPosix.basename(path), parent = openPosixSourceDirectory(pathPosix.dirname(path))
  const parentState = stateOf(parent, 'source')
  let directory: PosixStreamDirectory | undefined
  let parentReleaseAttempted = false, parentReleased = false
  let receipt: PrivateStreamRootReceipt = { kind: 'indeterminate', name, identity: null, parentIdentity: parent.identity,
    parentBefore: null, parentAfter: null, bindingVerification: 'unverified', privacyVerification: 'unverified',
    durability: 'unconfirmed', publications: [], release: 'released' }
  try {
    const before = parentState.native.inspect(parentState.capability)
    receipt = { ...receipt, parentBefore: observedDirectoryFacts(before) }
    directory = openPosixPrivateDirectory(path, options)
    const facts = directory.facts, binding = facts.parentBinding
    const after = parentState.native.inspect(parentState.capability)
    const created = nativeBoolean(facts.created, true)
    const synced = nativeBoolean(facts.creationSync.directory, true) && nativeBoolean(facts.creationSync.parent, true)
    const publication: PrivateStreamDirectoryPublication = { name, parentIdentity: parent.identity, identity: directory.identity,
      mechanism: facts.platform === 'linux' ? 'linux-directory-fsync-v1' : 'darwin-directory-fsync-v1',
      publication: 'published', bindingVerification: 'unverified', privacyVerification: 'verified',
      durability: synced ? 'synced' : 'unconfirmed', release: 'retained', synchronization: {
        child: nativeBoolean(facts.creationSync.directory, true) ? 'succeeded' : 'not-attempted',
        parent: nativeBoolean(facts.creationSync.parent, true) ? 'succeeded' : 'not-attempted' } }
    receipt = { ...receipt, identity: directory.identity, kind: created ? 'created' : 'existing-root',
      parentAfter: observedDirectoryFacts(after), publications: created ? [publication] : [], release: 'retained',
      privacyVerification: 'verified', durability: created ? synced ? 'synced' : 'unconfirmed' : 'not-attempted' }
    const securityUnchanged = before.uid === after.uid && before.gid === after.gid && before.mode === after.mode
      && JSON.stringify(before.acl) === JSON.stringify(after.acl)
    if (binding === undefined || binding.name !== name || !sameStreamIdentity(parent.identity, identity(binding.before))
      || !sameStreamIdentity(parent.identity, identity(binding.after)) || !sameStreamIdentity(parent.identity, identity(after))
      || !securityUnchanged || !facts.bindingVerified || (created && !synced)) throw new Error('root parent or creation facts changed')
    receipt = { ...receipt, bindingVerification: 'verified',
      publications: created ? [Object.freeze({ ...publication, bindingVerification: 'verified' })] : [] }
    parentReleaseAttempted = true
    parent.close()
    parentReleased = true
    return Object.freeze({ directory, receipt: Object.freeze(receipt) })
  } catch (error) {
    const failures = [error]
    if (directory === undefined && isCreationFailure(error)) {
      const known = error.creation
      receipt = { ...receipt, kind: known.entryCreationState === 'created' ? 'created' : 'indeterminate',
        identity: known.facts === null ? null : identity(known.facts),
        durability: known.creationSync.directory && known.creationSync.parent ? 'synced' : 'unconfirmed',
        release: known.release.attempted && !known.release.completed ? 'failed' : 'released' }
    }
    for (const capability of [directory, ...parentReleaseAttempted ? [] : [parent]]) {
      try { capability?.close() } catch (releaseError) { failures.push(releaseError) }
    }
    receipt = { ...receipt, release: receipt.release === 'failed' || failures.length > 1
      || (parentReleaseAttempted && !parentReleased) ? 'failed' : 'released' }
    throw new PrivateStreamRootError(receipt, failures.length === 1 ? error : new AggregateError(failures))
  }
}

/**
 * Open a sequential readonly source against exact planned identity/size/digest expectations.
 * @param directory Retained source directory from this provider instance.
 * @param name Literal source component.
 * @param options Frozen source manifest selection.
 * @returns A reader whose finish verifies EOF and complete observations before certification.
 */
export function openPosixSourceFileReader(
  directory: PosixStreamDirectory, name: string, options: SourceFileReaderOptions,
): SourceFileReader {
  const state = stateOf(directory, 'source')
  return createBoundedSourceReader(options, () => {
    const file = state.native.openSource(state.capability, name)
    return sourceResource(state.native, file)
  })
}
/**
 * @param directory Source parent.
 * @param name Literal leaf.
 * @param options Provisional facts and ceiling.
 * @returns Computed-digest observation stream.
 */
export function openPosixObservedSourceFileReader(directory: PosixStreamDirectory, name: string, options: ObservedSourceFileReaderOptions) {
  const state = stateOf(directory, 'source')
  return createObservedSourceReader(options, () => sourceResource(state.native, state.native.openSource(state.capability, name)))
}

/**
 * Create a fixed no-replace output with bounded input and truthful platform-specific publication receipts.
 * @param directory Retained private persistent directory from this provider instance.
 * @param name Literal final component.
 * @param options Exact manifest size/digest/executable policy and operation correlation.
 * @returns An append-only writer retaining its parent independently of this directory wrapper.
 */
export function createPosixPrivateFileWriter(
  directory: PosixStreamDirectory, name: string, options: PrivateFileWriterOptions,
): PrivateFileWriter {
  const state = stateOf(directory, 'private')
  const native = state.native
  const parent = native.inspect(state.capability)
  const mechanism: StreamMechanism = parent.platform === 'linux' ? 'linux-file-directory-fsync-v1' : 'darwin-file-directory-fullsync-v1'
  return createBoundedFileWriter(name, options, mechanism, () => writerResource(
    native, state.capability, parent, `.dsh-private-${randomBytes(20).toString('hex')}`, name, mechanism,
  ))
}

/**
 * Read an existing small private index, journal or reference record with its observed digest.
 * @param directory Retained private persistent directory.
 * @param name Literal record component.
 * @param options Explicit consumer ceiling, at most 64 MiB.
 * @returns Same-handle verified bytes and computed digest, without weakening shared-source expectations.
 */
export function readPosixPrivateRecord(
  directory: PosixStreamDirectory, name: string, options: { maxBytes: number },
): PrivateRecordReadResult {
  const state = stateOf(directory, 'private')
  return readBoundedPrivateRecord(options.maxBytes, () => {
    const file = state.native.openPrivateRecord(state.capability, name)
    return sourceResource(state.native, file)
  })
}

/**
 * Observe a readable source without certifying its complete contents or artifact identity.
 * @param directory Retained source directory from this provider instance.
 * @param name Literal source component.
 * @returns Complete same-handle observations for a later manifest-bound read; never a trusted digest.
 */
export function inspectPosixSourceFile(directory: PosixStreamDirectory, name: string): SourceFileFacts {
  const state = stateOf(directory, 'source')
  const file = state.native.openSource(state.capability, name)
  try { return sourceFacts(state.native.inspect(file)) } finally { state.native.close(file) }
}

/**
 * Acquire a native nonblocking management lease below an admitted private directory.
 * @param directory Private persistent directory from this provider instance.
 * @param name Literal generated lock-record name; no existing content is truncated.
 * @returns Same-parent kernel lease; a live competing holder fails without waiting.
 */
export function acquirePosixManagementLease(directory: PosixStreamDirectory, name: string): PosixManagementLease {
  const state = stateOf(directory, 'private')
  const capability = state.native.acquireLease(state.capability, name)
  try {
    const observed = state.native.inspect(capability)
    if (observed.leaseHeld !== true) throw new Error('native management lease is not held')
    const parentIdentity = identity(state.native.inspect(state.capability))
    const leaseState: LeaseState = { native: state.native, capability, parentIdentity, name, closed: false }
    const lease: PosixManagementLease = Object.freeze({ identity: identity(observed), parentIdentity,
      close(): void { if (!leaseState.closed) { leaseState.closed = true; leaseState.native.close(capability) } },
    })
    leases.set(lease, leaseState)
    return lease
  } catch (error) {
    try { state.native.close(capability) } catch (releaseError) { throw new AggregateError([error, releaseError], 'management lease admission and release failed') }
    throw error
  }
}
function leaseOf(lease: PosixManagementLease, state: DirectoryState): LeaseState {
  const selected = leases.get(lease)
  if (selected === undefined || selected.closed || selected.native !== state.native
    || !sameStreamIdentity(selected.parentIdentity, identity(state.native.inspect(state.capability)))) {
    throw new Error('invalid, closed, foreign or wrong-parent management lease')
  }
  if (selected.native.inspect(selected.capability).leaseHeld !== true) throw new Error('management lease is no longer held')
  return selected
}
function recordName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name) > 255 || name === '.' || name === '..'
    || /[\/\\\u0000-\u001f\u007f]/u.test(name) || name.startsWith('.dsh-private-')) throw new TypeError('invalid generated control-record name')
}
/**
 * Restrict replacement to an explicit generated private-control namespace under a live caller-owned lease.
 * @param directory Newly managed private control directory, never an original Profile directory.
 * @param lease Same-provider management lease; the returned owner never closes it.
 * @param names Fixed literal record names, excluding the management lock and staging namespace.
 * @returns Read/replace authority over only these generated records; namespace admission belongs to the managing caller.
 */
export function createPosixControlRecordOwner(
  directory: PosixStreamDirectory, lease: PosixManagementLease, names: readonly string[],
): PosixControlRecordOwner {
  const state = stateOf(directory, 'private')
  const selected = leaseOf(lease, state)
  const allowed = new Set<string>()
  for (const name of names) {
    recordName(name)
    if (name === selected.name || allowed.has(name)) throw new TypeError('control-record names must be distinct from each other and the lease')
    allowed.add(name)
  }
  if (allowed.size === 0 || allowed.size > 1024) throw new RangeError('control owner requires 1 through 1024 record names')
  const select = (name: string): { state: DirectoryState; lease: LeaseState } => {
    if (!allowed.has(name)) throw new Error('record name is outside this generated namespace')
    const current = stateOf(directory, 'private')
    return { state: current, lease: leaseOf(lease, current) }
  }
  return Object.freeze({ names: Object.freeze([...allowed]),
    read(name: string, options: { maxBytes: number }): PrivateRecordReadResult {
      select(name)
      return readPosixPrivateRecord(directory, name, options)
    },
    replace(name: string, options: ControlRecordWriterOptions): ControlRecordWriter {
      const current = select(name)
      const parent = current.state.native.inspect(current.state.capability)
      const mechanism: StreamMechanism = parent.platform === 'linux' ? 'linux-file-directory-fsync-v1' : 'darwin-file-directory-fullsync-v1'
      return createBoundedControlRecordWriter(name, options, mechanism, () => controlResource(
        current.state.native, current.state.capability, parent, current.lease.capability, name, mechanism,
      ))
    },
  })
}
function replacementFacts(value: PosixStorageReplacement): ControlRecordReplacementFacts {
  const convert = (facts: PosixObjectFacts) => Object.freeze({
    identity: identity(facts), observations: Object.freeze({ ...facts }),
  })
  return Object.freeze({ replacedBefore: convert(value.replacedFacts), replacedAfter: convert(value.replacedAfterFacts),
    stagingParent: convert(value.stagingParentFacts), targetParent: convert(value.targetParentFacts),
    parentAfter: convert(value.parentAfterFacts) })
}
function controlResource(
  native: PosixStoragePrimitives, parentOwner: PosixStorageDirectory, parentFacts: PosixStorageFacts,
  leaseOwner: PosixStorageLease, name: string, mechanism: StreamMechanism,
): ControlRecordResource {
  let parent: PosixStorageDirectory | undefined = parentOwner, lease: PosixStorageLease | undefined = leaseOwner
  const target = native.openPrivateRecord(parent, name)
  let closed = false
  return {
    inspectCurrent: () => sourceObservation(() => sourceFacts(native.inspect(target))),
    readCurrent: count => sourceObservation(() => native.read(target, count)),
    createStaging: () => {
      if (parent === undefined || lease === undefined) throw new Error('control record staging was already created or closed')
      let replacement: ControlRecordReplacementFacts | null = null
      const stage = writerResource(native, parent, parentFacts, `.dsh-private-${randomBytes(20).toString('hex')}`, name, mechanism,
        { target, lease, observed: (value) => { replacement = replacementFacts(value) } })
      parent = undefined
      lease = undefined
      return { mechanism: stage.mechanism, stagingName: stage.stagingName,
        parentIdentity: stage.parentIdentity,
        inspect: () => stage.inspect(), write: (bytes) => { stage.write(bytes) },
        setExecutable: (executable) => { stage.setExecutable(executable) },
        syncFile: () => { stage.syncFile() }, syncDirectory: () => { stage.syncDirectory() },
        verifyFinal: () => stage.verifyFinal(), removeUnpublished: () => stage.removeUnpublished(), close: () => { stage.close() },
        replaceCurrent: () => { stage.publish(); return replacement as ControlRecordReplacementFacts },
        reconcileReplacement: () => ({ publication: stage.reconcile(), replacement }),
      }
    },
    close: () => { if (!closed) { closed = true; parent = undefined; lease = undefined; native.close(target) } },
  }
}

function writerResource(
  native: PosixStoragePrimitives, initialParent: PosixStorageDirectory, parent: PosixStorageFacts,
  stagingName: string, name: string, mechanism: StreamMechanism,
  replacement?: { target: PosixStorageFile; lease: PosixStorageLease; observed(value: PosixStorageReplacement): void },
): StreamWriterResource & { readonly parentIdentity: StreamIdentity } {
  let parentCapability: PosixStorageDirectory | undefined = initialParent
  let published = false
  let file: PosixStorageFile | undefined
  let initialize: (() => PosixStorageFile) | undefined = () => {
    const retainedParent = parentCapability as PosixStorageDirectory
    parentCapability = undefined
    if (replacement === undefined && native.inspectBinding(retainedParent, name) !== null) throw new Error('private stream destination already exists')
    return native.createFile(retainedParent, stagingName)
  }
  let creation: PosixStorageCreationFacts | undefined
  let initializationError: unknown
  const retained = (): PosixStorageFile => {
    if (file !== undefined) return file
    throw initializationError instanceof Error ? initializationError : new Error('private staging resource has not been created', { cause: initializationError })
  }
  const convert = (value: PosixStorageFacts): StreamFileFacts => ({
    identity: identity(value), parentIdentity: identity(parent), sizeBytes: boundedNumber(value.size), links: boundedNumber(value.nlink),
    privateVerified: value.kind === 'regular' && value.bindingVerified && (value.mode & 0o077) === 0,
    executable: (value.mode & 0o100) !== 0,
  })
  const resource: StreamWriterResource & { readonly parentIdentity: StreamIdentity } = {
    mechanism, stagingName, parentIdentity: identity(parent),
    inspect: () => {
      if (initialize !== undefined) {
        const create = initialize
        initialize = undefined
        try { file = create() }
        catch (error) {
          initializationError = error
          if (isCreationFailure(error)) creation = error.creation
          throw error
        }
      }
      if (file !== undefined) return convert(native.inspect(retained()))
      if (creation?.facts != null) return {
        identity: identity(creation.facts), parentIdentity: identity(parent), sizeBytes: boundedNumber(creation.facts.size),
        links: boundedNumber(creation.facts.nlink), privateVerified: false, executable: (creation.facts.mode & 0o100) !== 0,
      }
      throw initializationError instanceof Error ? initializationError : new Error('private staging resource is unavailable', { cause: initializationError })
    },
    write: (bytes) => { native.write(retained(), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) },
    setExecutable: (executable) => { native.setExecutable(retained(), executable) },
    syncFile: () => { native.syncFile(retained(), parent.platform === 'darwin') },
    syncDirectory: () => { native.syncDirectory(retained()) },
    publish: () => {
      if (replacement === undefined) native.publish(retained(), name)
      else replacement.observed(native.replacePrivateRecord(retained(), replacement.target, replacement.lease))
      published = true
    },
    reconcile: () => {
      const current = native.inspect(retained())
      const final = native.inspectFileBinding(retained(), name)
      const staging = native.inspectFileBinding(retained(), stagingName)
      const same = (value: PosixObjectFacts | null): boolean => value !== null && value.dev === current.dev && value.ino === current.ino
      if (same(final) && !same(staging)) { published = true; return 'published' }
      if (same(staging) && !same(final)) return 'not-published'
      return 'indeterminate'
    },
    verifyFinal: () => {
      const current = native.inspect(retained())
      const final = native.inspectFileBinding(retained(), name)
      if (!published || final === null || final.dev !== current.dev || final.ino !== current.ino) throw new Error('final stream binding does not match retained output')
      return convert(current)
    },
    removeUnpublished: () => {
      if (file === undefined) return { deletion: creation !== undefined && creation.entryCreationState !== 'not-created' ? 'withheld' : 'not-needed', directorySynced: false }
      const result = native.removeUnpublished(retained())
      const removed = result.removed === true
      if (removed) native.syncDirectory(retained())
      return { deletion: removed ? 'removed' : 'withheld', directorySynced: removed }
    },
    close: () => {
      initialize = undefined
      parentCapability = undefined
      replacement = undefined
      if (file !== undefined) native.close(file)
      else if (creation !== undefined && creation.release.attempted && !creation.release.completed) throw initializationError
    },
  }
  return resource
}

function isCreationFailure(error: unknown): error is { creation: PosixStorageCreationFacts } {
  // The native provider owns this diagnostic; it is never accepted as a resource capability.
  return error !== null && typeof error === 'object' && 'creation' in error && error.creation !== null
    && typeof error.creation === 'object' && 'entryCreated' in error.creation && 'release' in error.creation
}


/**
 * Check a live same-provider, same-parent management lease without taking ownership of it.
 * @param directory Admitted private directory.
 * @param lease Caller-held kernel lease.
 */
export function assertPosixManagementLease(directory: PosixStreamDirectory, lease: PosixManagementLease): void {
  leaseOf(lease, stateOf(directory, 'private'))
}

/**
 * Inspect actual provider loading and package bytes without claiming a destination or platform acceptance.
 * @returns Loaded POSIX provider identities or the exact unavailable failure.
 */
export function posixStreamCapabilities(): {
  readonly available: true
  readonly backend: 'posix'
  readonly nativeIdentity: ReturnType<typeof inspectPosixStorageRuntime>
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly maxStreamBytes: number
  readonly maxChunkBytes: number
  readonly acceptance: 'unverified'
} | {
  readonly available: false
  readonly backend: 'posix'
  readonly error: unknown
  readonly reason: string
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly maxStreamBytes: number
  readonly maxChunkBytes: number
  readonly acceptance: 'unverified'
} {
  const declared = { platform: process.platform, architecture: process.arch,
    maxStreamBytes: 1024 * 1024 * 1024, maxChunkBytes: 1024 * 1024 }
  try {
    const nativeIdentity = inspectPosixStorageRuntime()
    return Object.freeze({ ...declared, available: true, backend: 'posix', nativeIdentity,
      platform: nativeIdentity.platform, architecture: nativeIdentity.architecture, acceptance: 'unverified' })
  } catch (error) {
    return Object.freeze({ ...declared, available: false, backend: 'posix', error,
      reason: error instanceof Error ? error.message : 'POSIX native provider unavailable', acceptance: 'unverified' })
  }
}


/** A directory creation may publish before admission, synchronization or wrapper release fails. */
export class PosixDirectoryPublicationError extends PrivateStreamError {
  /** Known independent publication and cleanup observations; unreturned capabilities are never reopened by path. */
  readonly receipt: PrivateStreamDirectoryPublication
  constructor(receipt: PrivateStreamDirectoryPublication, cause: unknown) {
    super('private child directory publication failed', cause, receipt.release === 'failed')
    this.name = 'PosixDirectoryPublicationError'
    this.receipt = Object.freeze({ ...receipt, synchronization: Object.freeze({ ...receipt.synchronization }) })
  }
}
/** Verify a native result at its untyped runtime boundary without truthiness coercion. */
function nativeBoolean(value: unknown, expected: boolean): boolean { return value === expected }
const statFields = ['kind', 'dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const
function sameStat(left: PosixObjectFacts, right: PosixObjectFacts): boolean { return statFields.every(key => left[key] === right[key]) }
function observedDirectoryFacts(value: PosixStorageFacts): SourceDirectoryFacts {
  if (value.kind !== 'directory' || !value.bindingVerified) throw new Error('directory observation is unbound')
  const observations = Object.freeze({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode,
    nlink: value.nlink, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs,
    filesystemId: value.filesystem.fsid, filesystemType: value.filesystem.type, filesystemReadOnly: value.filesystem.readOnly,
    aclModel: value.acl.model, aclEntries: value.acl.entries,
    aclDefaultEntries: value.acl.defaultEntries, aclSupported: value.acl.supported })
  return Object.freeze({
    identity: identity(value), links: boundedNumber(value.nlink), observations,
    changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
}
function directoryFacts(value: PosixStorageFacts): PrivateStreamDirectoryFacts {
  return Object.freeze({ ...observedDirectoryFacts(value), privateVerified: true })
}
/**
 * Open a child while retaining the exact private ancestor chain.
 * @param directory Admitted private parent.
 * @param name Literal child directory name.
 * @returns Independently retained private child.
 */
export function openPosixPrivateStreamChild(directory: PosixStreamDirectory, name: string): PosixStreamDirectory {
  const state = stateOf(directory, 'private'), child = state.native.openChild(state.capability, name)
  try { return wrapDirectory(state.native, child, 'private') }
  catch (error) {
    try { state.native.close(child) } catch (releaseError) { throw new AggregateError([error, releaseError], 'private child admission and release failed') }
    throw error
  }
}
/**
 * Exclusively create one empty private child with exact native publication receipts.
 * @param directory Admitted private parent.
 * @param name Absent literal child directory name.
 * @returns Independent child capability and acknowledged child/parent synchronization.
 */
export function createPosixPrivateStreamChild(directory: PosixStreamDirectory, name: string): {
  readonly directory: PosixStreamDirectory
  readonly receipt: PrivateStreamDirectoryPublication
} {
  const state = stateOf(directory, 'private'), parent = state.native.inspect(state.capability)
  let child: PosixStorageDirectory | undefined
  let receipt: PrivateStreamDirectoryPublication = { mechanism: parent.platform === 'linux' ? 'linux-directory-fsync-v1' : 'darwin-directory-fsync-v1',
    parentIdentity: identity(parent), identity: null, name, publication: 'not-published', bindingVerification: 'unverified',
    privacyVerification: 'unverified', durability: 'unconfirmed', synchronization: { child: 'not-attempted', parent: 'not-attempted' }, release: 'released' }
  try {
    const result = state.native.createPrivateChild(state.capability, name)
    child = result.capability
    const childSynced = nativeBoolean(result.creationSync.directory, true), parentSynced = nativeBoolean(result.creationSync.parent, true)
    receipt = { ...receipt, identity: identity(result.facts), publication: nativeBoolean(result.published, true) ? 'published' : 'indeterminate',
      bindingVerification: result.facts.bindingVerified ? 'verified' : 'unverified', privacyVerification: 'unverified',
      durability: childSynced && parentSynced ? 'synced' : 'unconfirmed',
      synchronization: { child: childSynced ? 'succeeded' : 'not-attempted', parent: parentSynced ? 'succeeded' : 'not-attempted' }, release: 'retained' }
    if (!sameStat(parent, result.parentBeforeFacts) || !childSynced || !parentSynced
      || !nativeBoolean(result.published, true) || !result.facts.bindingVerified) {
      throw new Error('private child parent/publication observation mismatch')
    }
    const admitted = wrapDirectory(state.native, child, 'private')
    receipt = { ...receipt, privacyVerification: 'verified' }
    return Object.freeze({ directory: admitted, receipt: Object.freeze(receipt) })
  } catch (error) {
    const failures = [error]
    if (child !== undefined) {
      try { state.native.close(child); receipt = { ...receipt, release: 'released' } }
      catch (releaseError) { failures.push(releaseError); receipt = { ...receipt, release: 'failed' } }
    } else if (isCreationFailure(error)) {
      const created = error.creation
      receipt = { ...receipt, identity: created.facts === null ? null : identity(created.facts),
        publication: created.entryCreationState === 'created' ? 'published' : created.entryCreationState === 'indeterminate' ? 'indeterminate' : 'not-published',
        bindingVerification: created.bindingVerified ? 'verified' : 'unverified',
        durability: created.creationSync.directory && created.creationSync.parent ? 'synced' : 'unconfirmed',
        synchronization: { child: created.creationSync.directory ? 'succeeded' : 'not-attempted', parent: created.creationSync.parent ? 'succeeded' : 'not-attempted' },
        release: created.release.attempted && !created.release.completed ? 'failed' : 'released' }
    }
    throw new PosixDirectoryPublicationError(receipt, failures.length === 1 ? error : new AggregateError(failures))
  }
}
/**
 * Enumerate complete literal children; unopened entry privacy remains unverified.
 * @param directory Admitted private directory.
 * @param options Maximum entries, at most 100000; zero admits only an empty directory.
 * @returns Complete stable observations or an exception; never a truncated successful list.
 */
export function listPosixPrivateStreamDirectory(
  directory: PosixStreamDirectory, options: { maxEntries: number },
): PrivateStreamDirectoryListing {
  const state = stateOf(directory, 'private'), before = state.native.inspect(state.capability)
  const listed = state.native.listDirectory(state.capability, options.maxEntries)
  const after = state.native.inspect(state.capability)
  if (!sameStat(before, listed.parentBeforeFacts) || !sameStat(after, listed.parentAfterFacts)
    || !sameStat(before, after) || !nativeBoolean(listed.complete, true)) {
    throw new Error('private directory changed during complete enumeration')
  }
  return Object.freeze({ before: directoryFacts(before), after: directoryFacts(after), complete: true,
    entries: Object.freeze(listed.entries.map(entry => Object.freeze({ name: entry.name, identity: identity(entry.facts),
      kind: entry.facts.kind === 'regular' ? 'file' : entry.facts.kind === 'directory' ? 'directory' : 'other' }))) })
}
/**
 * Inspect a private entry through a retained no-follow handle, with actual type/privacy observations.
 * @param directory Admitted private directory.
 * @param name Literal child name.
 * @returns Full regular-output or directory facts; links and unsupported types refuse.
 */
export function inspectPosixPrivateStreamEntry(directory: PosixStreamDirectory, name: string): PrivateStreamInspectedEntry {
  const state = stateOf(directory, 'private'), entry = state.native.inspectBinding(state.capability, name)
  if (entry === null) throw Object.assign(new Error('private entry missing'), { code: 'ENOENT' })
  const capability = entry.kind === 'directory' ? state.native.openChild(state.capability, name)
    : state.native.openPrivateOutput(state.capability, name)
  const failures: unknown[] = []
  let result: PrivateStreamInspectedEntry | undefined
  try {
    const facts = state.native.inspect(capability)
    if (!sameStat(entry, facts)) throw new Error('private entry changed before retained inspection')
    result = facts.kind === 'directory' ? { kind: 'directory', facts: directoryFacts(facts) }
      : { kind: 'file', facts: Object.freeze({ ...sourceFacts(facts), privateVerified: true, executable: (facts.mode & 0o100) !== 0 }) }
  } catch (error) { failures.push(error) }
  try { state.native.close(capability) } catch (error) { failures.push(error) }
  if (failures.length || result === undefined) throw new AggregateError(failures, 'private entry inspection failed')
  return Object.freeze(result)
}
/**
 * Read a generated regular output against immutable manifest expectations, without control-record replacement authority.
 * @param directory Admitted private parent.
 * @param name Literal regular output name.
 * @param options Exact expected identity, size and digest; native ceiling remains 1 GiB.
 * @returns Bounded same-handle reader; successful completion verifies EOF and full observations.
 */
export function openPosixPrivateFileReader(
  directory: PosixStreamDirectory, name: string, options: SourceFileReaderOptions,
): SourceFileReader {
  const state = stateOf(directory, 'private')
  return createBoundedSourceReader(options, () => sourceResource(state.native, state.native.openPrivateOutput(state.capability, name)))
}
/**
 * Observe actual destination capacity without asserting a global space reservation.
 * @param directory Admitted private directory.
 * @returns Native caller-available allocation facts bound to the retained directory and filesystem.
 */
export function observePosixPrivateStreamCapacity(directory: PosixStreamDirectory): PrivateStreamCapacity {
  const state = stateOf(directory, 'private'), before = state.native.inspect(state.capability)
  const observed = state.native.observeCapacity(state.capability), after = state.native.inspect(state.capability)
  if (!sameStat(before, observed.parentBeforeFacts) || !sameStat(after, observed.parentAfterFacts)
    || !sameStat(before, after) || observed.filesystem.fsid !== after.filesystem.fsid || !nativeBoolean(observed.reservation, false)) {
    throw new Error('private capacity observation changed its retained filesystem')
  }
  return Object.freeze({ directoryIdentity: identity(after), filesystemId: observed.filesystem.fsid,
    allocationUnitBytes: observed.allocationUnitBytes, availableBytes: observed.availableBytes,
    availableEntries: observed.availableEntries, scope: 'observed-filesystem-capacity' })
}


/**
 * Import an already observed original or editor draft without changing it or weakening artifact digest requirements.
 * @param directory Retained readonly source directory.
 * @param name Literal document name.
 * @param options Full expected observations and a bound at most 64 MiB.
 * @returns Verified readonly bytes and computed digest after same-handle completion.
 */
export function readPosixSourceDocument(
  directory: PosixStreamDirectory, name: string, options: SourceDocumentReadOptions,
): SourceDocumentReadResult {
  const state = stateOf(directory, 'source')
  return readBoundedSourceDocument(options, () => sourceResource(state.native, state.native.openSource(state.capability, name)))
}

/**
 * Open a readonly source child through its existing retained parent.
 * @param directory Admitted readonly source parent.
 * @param name Literal child directory component.
 * @returns Independently retained child with unchanged source permission policy.
 */
export function openPosixSourceChild(directory: PosixStreamDirectory, name: string): PosixStreamDirectory {
  const state = stateOf(directory, 'source'), child = state.native.openChild(state.capability, name)
  try { return wrapDirectory(state.native, child, 'source') }
  catch (error) {
    try { state.native.close(child) } catch (releaseError) { throw new AggregateError([error, releaseError], 'source child admission and release failed') }
    throw error
  }
}
/**
 * Enumerate complete readonly source names and identities without admitting symlinks or special files for copying.
 * @param directory Admitted readonly source parent.
 * @param maximum Complete-name ceiling from zero through 100000.
 * @returns Checked before/after observations and every name, including explicitly unadmitted entries.
 */
export function listPosixSourceDirectory(directory: PosixStreamDirectory, maximum: number): SourceDirectoryListing {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100000) throw new RangeError('source entry ceiling must be from 0 through 100000')
  const state = stateOf(directory, 'source'), before = state.native.inspect(state.capability)
  const listed = state.native.listSourceDirectory(state.capability, maximum), after = state.native.inspect(state.capability)
  if (!sameStat(before, listed.parentBeforeFacts) || !sameStat(after, listed.parentAfterFacts)
    || !sameStat(before, after) || !nativeBoolean(listed.complete, true)) {
    throw new SourceObservationError(new Error('source directory changed during enumeration'))
  }
  const entries: SourceDirectoryEntry[] = listed.entries.map(entry => entry.facts.kind === 'regular' || entry.facts.kind === 'directory'
    ? Object.freeze({ name: entry.name, kind: entry.facts.kind === 'regular' ? 'file' : 'directory', identity: identity(entry.facts) })
    : Object.freeze({ name: entry.name, kind: 'unadmitted', identity: identity(entry.facts),
      reason: `Source ${entry.facts.kind} has no admitted copy or link-target authority`, nativeStatus: null, win32Code: null }))
  return Object.freeze({ before: observedDirectoryFacts(before), after: observedDirectoryFacts(after),
    entries: Object.freeze(entries), complete: true,
    admission: entries.some(entry => entry.kind === 'unadmitted') ? 'unadmitted-entries' : 'complete' })
}
