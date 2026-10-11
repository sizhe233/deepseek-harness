/** Retained readonly Windows sources with separate non-private observations and no pathname reopening. */
import { createHash } from 'node:crypto'
import { PrivateStorageError } from './error.ts'
import { SourceObservationError } from './stream-error.ts'
import { failWithWindowsCleanup, releaseWindowsResources, withWindowsInspection } from './windows-stream-cleanup.ts'
import { loadNativeStorage } from './native.ts'
import type { Handle, NativeFilesystemFacts, NativeSourceFacts, NativeStorageBackend as NativeStorage } from './native.ts'
import { sameIdentity, splitRootPath, validateName } from './policy.ts'
import { createBoundedSourceReader } from './source-reader.ts'
import { createObservedSourceReader, type ObservedSourceFileReaderOptions } from './observed-source-reader.ts'
import { readBoundedSourceDocument } from './source-document-reader.ts'
import type { SourceDocumentReadOptions, SourceDocumentReadResult } from './source-document-reader.ts'
import { validateStreamChunkSize } from './stream-policy.ts'
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts, SourceFileReader, SourceFileReaderOptions, StreamIdentity } from './stream-types.ts'
import type { SourceDirectoryEntry, SourceDirectoryFacts, SourceDirectoryListing } from './source-directory-types.ts'

/** Realm-bound readonly root; readers independently retain every ancestor when this wrapper closes. */
export interface WindowsSourceDirectory {
  readonly identity: StreamIdentity
  readonly policy: 'source'
  close(): void
}
interface Guard {
  readonly handle: Handle
  readonly name: string | null
  readonly facts: NativeSourceFacts
  readonly filesystem: NativeFilesystemFacts
  references: number
}
interface SourceState {
  readonly api: NativeStorage
  readonly sid: Buffer
  readonly guards: Guard[]
  readonly name: string | null
  file: Handle | null
  closed: boolean
}
const directories = new WeakMap<WindowsSourceDirectory, SourceState>()

function releaseError(failure: unknown): Error {
  if (failure instanceof Error) return failure
  const error = new PrivateStorageError('native', 'resource release failed')
  error.cause = failure
  return error
}
function releaseGuards(api: NativeStorage, guards: Guard[]): void {
  let failure: unknown
  for (const guard of guards.toReversed()) {
    guard.references--
    if (guard.references === 0) {
      try { api.close(guard.handle) } catch (error) { failure ??= error }
    }
  }
  if (failure !== undefined) throw releaseError(failure)
}
function release(state: SourceState): void {
  if (state.closed) return
  state.closed = true
  const handle = state.file
  state.file = null
  let failure: unknown
  try { if (handle !== null) state.api.close(handle) } catch (error) { failure = error }
  try { releaseGuards(state.api, state.guards) } catch (error) { failure ??= error }
  if (failure !== undefined) throw releaseError(failure)
}
const finalizers = new FinalizationRegistry<SourceState>((state) => {
  try { release(state) } catch (_error) { /* Explicit close reports release uncertainty. */ }
})
function parentOf(state: SourceState): Guard {
  return state.guards.at(-1) as Guard
}
function validate(state: SourceState): void {
  if (state.closed) throw new PrivateStorageError('closed', 'live source capability required')
  if (!state.sid.equals(state.api.tokenUser())) throw new PrivateStorageError('privacy', 'source TokenUser changed')
  for (const guard of state.guards) {
    const current = state.api.inspectSource(guard.handle)
    if (current.kind !== 'directory' || !sameIdentity(current.identity, guard.facts.identity)
      || current.attributes !== guard.facts.attributes || current.securityDescriptorSha256 !== guard.facts.securityDescriptorSha256) {
      throw new SourceObservationError(new PrivateStorageError('changed', 'source ancestor identity or security changed'))
    }
    if (guard.name !== null) {
      try { state.api.verifyName(guard.handle, guard.name) }
      catch (error) { if (error instanceof PrivateStorageError && error.code === 'name') throw new SourceObservationError(error); throw error }
    }
    const filesystem = state.api.admitSourceFilesystem(guard.handle)
    if (filesystem.flags !== guard.filesystem.flags || filesystem.deviceCharacteristics !== guard.filesystem.deviceCharacteristics) {
      throw new SourceObservationError(new PrivateStorageError('changed', 'source filesystem observations changed'))
    }
  }
}
function retain(state: SourceState, name: string): SourceState {
  validate(state)
  for (const guard of state.guards) guard.references++
  return { api: state.api, sid: state.sid, guards: [...state.guards], name, file: null, closed: false }
}
function inspectFile(state: SourceState): SourceFileFacts {
  validate(state)
  const file = state.file as Handle, name = state.name as string
  const facts = state.api.inspectSource(file)
  if (facts.kind !== 'file' || facts.identity.volumeSerial !== parentOf(state).facts.identity.volumeSerial) {
    throw new SourceObservationError(new PrivateStorageError('identity', 'regular same-volume source required'))
  }
  try { state.api.verifyName(file, name) }
  catch (error) { if (error instanceof PrivateStorageError && error.code === 'name') throw new SourceObservationError(error); throw error }
  const sizeBytes = Number(facts.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new PrivateStorageError('limit', 'source size')
  const filesystem = parentOf(state).filesystem
  const observations = Object.freeze({ volumeSerial: facts.identity.volumeSerial, fileId: facts.identity.fileId,
    sizeBytes: facts.sizeBytes.toString(), links: facts.links, lastWriteTime: facts.lastWriteTime.toString(),
    changeTime: facts.changeTime.toString(),
    attributes: facts.attributes, securityDescriptorSha256: facts.securityDescriptorSha256,
    filesystem: filesystem.filesystem, filesystemFlags: filesystem.flags, deviceType: filesystem.deviceType,
    deviceCharacteristics: filesystem.deviceCharacteristics })
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }), sizeBytes, links: facts.links,
    observations, changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
}
class WindowsSourceResource implements SourceReaderResource {
  private readonly state: SourceState
  constructor(state: SourceState) { this.state = state; finalizers.register(this, state, this) }
  inspect(): SourceFileFacts { return inspectFile(this.state) }
  read(maxBytes: number): Uint8Array {
    validateStreamChunkSize(maxBytes)
    const before = inspectFile(this.state)
    const output = Buffer.alloc(maxBytes)
    const file = this.state.file as Handle
    const count = this.state.api.read(file, output)
    const after = inspectFile(this.state)
    if (after.changeToken !== before.changeToken) throw new SourceObservationError(new PrivateStorageError('changed', 'source changed during read'))
    return output.subarray(0, count)
  }
  close(): void { finalizers.unregister(this); release(this.state) }
}
function openResource(directory: WindowsSourceDirectory, name: string): SourceReaderResource {
  validateName(name)
  const state = directories.get(directory)
  if (state === undefined) throw new PrivateStorageError('closed', 'source directory belongs to another provider or realm')
  const owned = retain(state, name)
  try {
    owned.file = owned.api.open(parentOf(owned).handle, name, 'file', 'read-source', owned.sid)
    inspectFile(owned)
    return new WindowsSourceResource(owned)
  } catch (error) { failWithWindowsCleanup(error, () => { release(owned) }) }
}
function directoryState(directory: WindowsSourceDirectory): SourceState {
  const state = directories.get(directory)
  if (state === undefined) throw new PrivateStorageError('closed', 'source directory belongs to another provider or realm')
  return state
}
function wrapDirectory(state: SourceState): WindowsSourceDirectory {
  const directory: WindowsSourceDirectory = Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...parentOf(state).facts.identity }),
    policy: 'source', close() { finalizers.unregister(directory); release(state) } })
  directories.set(directory, state)
  finalizers.register(directory, state, directory)
  return directory
}

/**
 * Walk a literal local source root without reparsing or repairing existing security.
 * @param path Absolute Windows local-drive path; shared ACLs and readonly NTFS may be admitted.
 * @returns An opaque root retaining every directory component under non-delete sharing.
 */
export function openWindowsSourceDirectory(path: string): WindowsSourceDirectory {
  const parsed = /^[A-Za-z]:\\$/u.test(path) ? { volume: `\\??\\${path[0]}:\\`, components: [] } : splitRootPath(path)
  const api = loadNativeStorage(), sid = api.tokenUser()
  const state: SourceState = { api, sid, guards: [], name: null, file: null, closed: false }
  const appendGuard = (parent: Handle | null, name: string, bootstrap: boolean): void => {
    const handle = api.open(parent, name, 'directory', 'inspect', sid)
    try {
      const facts = api.inspectSource(handle), filesystem = api.admitSourceFilesystem(handle)
      if (facts.kind !== 'directory') throw new PrivateStorageError('identity', 'source directory required')
      if (!bootstrap) {
        api.verifyName(handle, name)
        if (facts.identity.volumeSerial !== parentOf(state).facts.identity.volumeSerial) throw new PrivateStorageError('identity', 'source volume changed')
      }
      state.guards.push({ handle, name: bootstrap ? null : name, facts, filesystem, references: 1 })
    } catch (error) { failWithWindowsCleanup(error, () => { api.close(handle) }) }
  }
  try {
    appendGuard(null, parsed.volume, true)
    for (const name of parsed.components) appendGuard(parentOf(state).handle, name, false)
    validate(state)
    return wrapDirectory(state)
  } catch (error) { failWithWindowsCleanup(error, () => { release(state) }) }
}

/**
 * Open one literal readonly child while independently retaining the existing admitted ancestors.
 * @param directory Live source directory.
 * @param name Literal child directory component; links and cross-volume transitions refuse.
 * @returns Independently closable readonly child, without repairing its owner or ACL.
 */
export function openWindowsSourceChild(directory: WindowsSourceDirectory, name: string): WindowsSourceDirectory {
  validateName(name)
  const state = retain(directoryState(directory), name)
  let handle: Handle | null = null
  try {
    handle = state.api.open(parentOf(state).handle, name, 'directory', 'inspect', state.sid)
    const facts = state.api.inspectSource(handle), filesystem = state.api.admitSourceFilesystem(handle)
    state.api.verifyName(handle, name)
    if (facts.kind !== 'directory' || facts.identity.volumeSerial !== parentOf(state).facts.identity.volumeSerial) {
      throw new SourceObservationError(new PrivateStorageError('identity', 'same-volume source directory required'))
    }
    state.guards.push({ handle, name, facts, filesystem, references: 1 }); handle = null
    validate(state)
    return wrapDirectory(state)
  } catch (error) {
    const closing = handle
    failWithWindowsCleanup(error, () => {
      releaseWindowsResources([() => { if (closing !== null) state.api.close(closing) }, () => { release(state) }])
    })
  }
}

function observedDirectory(state: SourceState): SourceDirectoryFacts {
  validate(state)
  const parent = parentOf(state), facts = state.api.inspectSource(parent.handle)
  if (facts.kind !== 'directory' || !sameIdentity(facts.identity, parent.facts.identity)
    || !Number.isSafeInteger(facts.links) || facts.links < 1) throw new SourceObservationError(new PrivateStorageError('changed', 'source directory changed'))
  const observations = Object.freeze({ lastWriteTime: facts.lastWriteTime.toString(), changeTime: facts.changeTime.toString(),
    attributes: facts.attributes, securityDescriptorSha256: facts.securityDescriptorSha256,
    volumeSerial: facts.identity.volumeSerial, fileId: facts.identity.fileId })
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }), links: facts.links, observations,
    changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
}

/** @param directory Live readonly source directory. @returns Current complete retained-directory observations. */
export function inspectWindowsSourceDirectory(directory: WindowsSourceDirectory): SourceDirectoryFacts {
  return observedDirectory(directoryState(directory))
}

/**
 * @param directory Retained source parent.
 * @param name Literal leaf.
 * @param maximum Target byte ceiling.
 * @returns Unresolved link observations.
 */
export function inspectWindowsSourceLink(directory: WindowsSourceDirectory, name: string, maximum: number) {
  validateName(name)
  const state = retain(directoryState(directory), name)
  try {
    const before = observedDirectory(state)
    const result = state.api.observeLink(parentOf(state).handle, name, maximum)
    if (observedDirectory(state).changeToken !== before.changeToken) throw new SourceObservationError(new PrivateStorageError('changed', 'source parent changed'))
    release(state)
    return result
  } catch (error) { failWithWindowsCleanup(error, () => { release(state) }) }
}

/**
 * Enumerate every source name while retaining the directory and checking complete before/after observations.
 * @param directory Live readonly source directory.
 * @param maximum Complete-name ceiling from zero through 100000; zero admits only empty directories.
 * @returns Names and admitted regular/directory identities; every refused entry stays explicitly unadmitted.
 */
export function listWindowsSourceDirectory(directory: WindowsSourceDirectory, maximum: number): SourceDirectoryListing {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100000) throw new RangeError('source entry ceiling must be from 0 through 100000')
  const state = retain(directoryState(directory), 'source-inventory')
  let result: SourceDirectoryListing
  try {
    const before = observedDirectory(state), names = state.api.names(parentOf(state).handle, maximum)
    const entries: SourceDirectoryEntry[] = [], seen = new Set<string>()
    for (const name of names) {
      validateName(name)
      if (seen.has(name.toLowerCase())) throw new PrivateStorageError('name', 'duplicate source component')
      seen.add(name.toLowerCase())
      try {
        const handle = state.api.open(parentOf(state).handle, name, 'any', 'inspect', state.sid)
        entries.push(withWindowsInspection(state.api, handle, () => {
          state.api.verifyName(handle, name)
          const facts = state.api.inspectSource(handle)
          if (facts.identity.volumeSerial !== parentOf(state).facts.identity.volumeSerial) {
            throw new PrivateStorageError('identity', 'source child volume changed')
          }
          return Object.freeze({ name, kind: facts.kind, identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }) })
        }))
      } catch (error) {
        if (!(error instanceof PrivateStorageError) || error.cleanupFailed || ['not-found', 'changed', 'identity', 'name'].includes(error.code)) throw error
        entries.push(Object.freeze({ name, kind: 'unadmitted', identity: null, reason: error.message,
          nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null }))
      }
    }
    const after = observedDirectory(state)
    if (before.changeToken !== after.changeToken) throw new SourceObservationError(new PrivateStorageError('changed', 'source directory changed during enumeration'))
    result = Object.freeze({ before, after, entries: Object.freeze(entries), complete: true,
      admission: entries.some(entry => entry.kind === 'unadmitted') ? 'unadmitted-entries' : 'complete' })
  } catch (error) { failWithWindowsCleanup(error, () => { release(state) }) }
  releaseWindowsResources([() => { release(state) }])
  return result
}

/**
 * Observe a source for planning without certifying a content digest or stable snapshot.
 * @param directory Live readonly root from this provider instance.
 * @param name Literal file component.
 * @returns Complete provisional same-handle facts; a strict reader must later verify its frozen expectation.
 */
export function inspectWindowsSourceFile(directory: WindowsSourceDirectory, name: string): SourceFileFacts {
  const resource = openResource(directory, name)
  let facts: SourceFileFacts
  try { facts = resource.inspect() }
  catch (error) { failWithWindowsCleanup(error, () => { resource.close() }) }
  releaseWindowsResources([() => { resource.close() }])
  return facts
}

/**
 * Open an independently retained readonly file against an exact frozen source plan.
 * @param directory Live readonly root from this provider instance.
 * @param name Literal file component.
 * @param options Full expected identity, size and digest; validated before native opening.
 * @returns Bounded sequential reader whose finish certifies exact EOF and unchanged observations.
 */
export function openWindowsSourceFileReader(
  directory: WindowsSourceDirectory, name: string, options: SourceFileReaderOptions,
): SourceFileReader {
  validateName(name)
  return createBoundedSourceReader(options, () => openResource(directory, name))
}
/**
 * @param directory Source parent.
 * @param name Literal leaf.
 * @param options Provisional facts and ceiling.
 * @returns Computed-digest observation stream.
 */
export function openWindowsObservedSourceFileReader(
  directory: WindowsSourceDirectory, name: string, options: ObservedSourceFileReaderOptions,
) {
  validateName(name)
  return createObservedSourceReader(options, () => openResource(directory, name))
}

/**
 * Import an observed readonly document without treating its computed digest as artifact authorization.
 * @param directory Live source capability.
 * @param name Exact original or draft component.
 * @param options Complete provisional observations and an independent ceiling at most64MiB.
 * @returns Detached bytes and computed digest after complete same-handle verification and close.
 */
export function readWindowsSourceDocument(
  directory: WindowsSourceDirectory, name: string, options: SourceDocumentReadOptions,
): SourceDocumentReadResult {
  validateName(name)
  return readBoundedSourceDocument(options, () => openResource(directory, name))
}
