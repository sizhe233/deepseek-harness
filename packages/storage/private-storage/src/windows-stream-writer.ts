/** Retained Windows resources for the shared append-only publication lifecycle. */
import { randomBytes } from 'node:crypto'
import { PrivateStorageError } from './error.ts'
import type { Handle, NativeStorageBackend as NativeStorage } from './native.ts'
import { sameIdentity, validateName } from './policy.ts'
import type { PrivateIdentity } from './types.ts'
import type { StreamFileFacts, StreamWriterResource } from './stream-native.ts'
import type { StreamIdentity } from './stream-types.ts'
import { failWithWindowsCleanup, releaseWindowsResources, withWindowsInspection } from './windows-stream-cleanup.ts'

/** Internal independently retained directory authority; never exported by the package entry. */
export interface WindowsWriterParent {
  readonly api: NativeStorage
  readonly sid: Buffer
  readonly handle: Handle
  readonly identity: PrivateIdentity
  validate(): void
  release(): void
}
/** Internal generated-record replacement checks; public immutable writers never supply this authority. */
export interface WindowsWriterReplacement {
  beforeRename(): void
  afterRename(): void
}
interface WriterState {
  readonly replacement: WindowsWriterReplacement | undefined
  readonly parent: WindowsWriterParent
  readonly finalName: string
  readonly stagingName: string
  identity: PrivateIdentity | null
  source: Handle | null
  initializationAttempted: boolean
  publication: 'not-published' | 'published' | 'indeterminate'
  closed: boolean
  deletionPending: boolean
}

function release(state: WriterState): void {
  if (state.closed) return
  state.closed = true
  const source = state.source
  state.source = null
  releaseWindowsResources([
    () => { if (source !== null) state.parent.api.close(source) },
    () => { state.parent.release() },
  ])
}
const finalizers = new FinalizationRegistry<WriterState>((state) => {
  try { release(state) } catch (_error) { /* Explicit settlement reports release failure. */ }
})

function sourceOf(state: WriterState): Handle {
  if (state.closed) throw new PrivateStorageError('closed', 'live stream resource required')
  state.parent.validate()
  if (!state.initializationAttempted) {
    state.initializationAttempted = true
    let existing: Handle | null = null
    try { if (state.replacement === undefined) existing = state.parent.api.open(state.parent.handle, state.finalName, 'any', 'inspect', state.parent.sid) }
    catch (error) { if (!(error instanceof PrivateStorageError && error.code === 'not-found')) throw error }
    if (existing !== null) {
      releaseWindowsResources([() => { state.parent.api.close(existing) }])
      throw new PrivateStorageError('collision', 'stream destination exists')
    }
    state.source = state.parent.api.open(state.parent.handle, state.stagingName, 'file', 'create', state.parent.sid)
  }
  if (state.source === null) throw new PrivateStorageError('native', 'stream creation did not return an owned source')
  return state.source
}
function inspect(state: WriterState): StreamFileFacts {
  const handle = sourceOf(state)
  const facts = state.parent.api.inspect(handle, state.parent.sid)
  if (state.identity === null) {
    state.parent.api.verifyName(handle, state.stagingName)
    if (facts.kind !== 'file' || facts.links !== 1 || facts.sizeBytes !== 0n || !facts.writeThrough
      || facts.identity.volumeSerial !== state.parent.identity.volumeSerial) throw new PrivateStorageError('identity', 'fresh stream source admission')
    state.identity = facts.identity
  }
  if (facts.kind !== 'file' || facts.links !== 1 || !facts.writeThrough
    || !sameIdentity(facts.identity, state.identity) || facts.identity.volumeSerial !== state.parent.identity.volumeSerial) {
    throw new PrivateStorageError('identity', 'retained stream source changed')
  }
  const sizeBytes = Number(facts.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new PrivateStorageError('limit', 'stream source size')
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }),
    parentIdentity: Object.freeze({ backend: 'windows-ntfs', ...state.parent.identity }), sizeBytes, links: facts.links,
    privateVerified: true, executable: null })
}
function identityAt(state: WriterState, name: string): PrivateIdentity | null {
  state.parent.validate()
  let handle: Handle
  try { handle = state.parent.api.open(state.parent.handle, name, 'any', 'inspect', state.parent.sid) }
  catch (error) { if (error instanceof PrivateStorageError && error.code === 'not-found') return null; throw error }
  return withWindowsInspection(state.parent.api, handle, () => {
    state.parent.api.verifyName(handle, name)
    // Reconciliation admits no privacy claim; it needs only an actual identity of the observed object.
    return state.parent.api.inspectSource(handle).identity
  })
}

class WindowsWriterResource implements StreamWriterResource {
  readonly mechanism = 'windows-ntfs-write-through-rename-v1' as const
  readonly stagingName: string
  readonly parentIdentity: StreamIdentity
  private readonly state: WriterState
  constructor(state: WriterState) {
    this.state = state
    this.stagingName = state.stagingName
    this.parentIdentity = Object.freeze({ backend: 'windows-ntfs', ...state.parent.identity })
    finalizers.register(this, state, this)
  }
  inspect(): StreamFileFacts { return inspect(this.state) }
  write(ownedBytes: Uint8Array): void {
    const handle = sourceOf(this.state)
    inspect(this.state)
    this.state.parent.api.write(handle, Buffer.from(ownedBytes.buffer, ownedBytes.byteOffset, ownedBytes.byteLength))
  }
  setExecutable(_executable: boolean): void { inspect(this.state) }
  syncFile(): void { this.state.parent.api.flush(sourceOf(this.state)) }
  syncDirectory(): void { throw new PrivateStorageError('unsupported', 'Windows stream does not use directory fsync') }
  publish(): void {
    const handle = sourceOf(this.state)
    inspect(this.state)
    this.state.replacement?.beforeRename()
    this.state.publication = 'indeterminate'
    this.state.parent.api.rename(handle, this.state.parent.handle, this.state.finalName, this.state.replacement !== undefined)
    this.state.publication = 'published'
    this.state.replacement?.afterRename()
  }
  reconcile(): 'not-published' | 'published' | 'indeterminate' {
    sourceOf(this.state)
    if (this.state.identity === null) return 'indeterminate'
    try {
      const final = identityAt(this.state, this.state.finalName)
      const staging = identityAt(this.state, this.state.stagingName)
      const atFinal = final !== null && sameIdentity(final, this.state.identity)
      const atStaging = staging !== null && sameIdentity(staging, this.state.identity)
      this.state.publication = atFinal && !atStaging ? 'published' : atStaging && !atFinal ? 'not-published' : 'indeterminate'
    } catch (_error) { this.state.publication = 'indeterminate' }
    return this.state.publication
  }
  verifyFinal(): StreamFileFacts {
    const source = sourceOf(this.state)
    const identity = this.state.identity
    if (this.state.publication !== 'published' || identity === null) throw new PrivateStorageError('identity', 'stream publication is not established')
    this.state.parent.api.verifyName(source, this.state.finalName)
    const final = this.state.parent.api.open(this.state.parent.handle, this.state.finalName, 'file', 'inspect', this.state.parent.sid)
    return withWindowsInspection(this.state.parent.api, final, () => {
      const facts = this.state.parent.api.inspect(final, this.state.parent.sid)
      this.state.parent.api.verifyName(final, this.state.finalName)
      const retained = inspect(this.state)
      if (facts.kind !== 'file' || !sameIdentity(facts.identity, identity)
        || facts.sizeBytes !== BigInt(retained.sizeBytes)) throw new PrivateStorageError('identity', 'final stream binding changed')
      return retained
    })
  }
  removeUnpublished(): { deletion: 'delete-pending' | 'withheld'; directorySynced: false } {
    if (this.state.publication !== 'not-published' || this.state.source === null || this.state.identity === null) return { deletion: 'withheld', directorySynced: false }
    const source = sourceOf(this.state)
    if (!this.state.deletionPending) {
      inspect(this.state)
      this.state.parent.api.remove(source)
      this.state.deletionPending = true
    }
    return { deletion: 'delete-pending', directorySynced: false }
  }
  close(): void { finalizers.unregister(this); release(this.state) }
}

/**
 * Exclusively create an inspected private source while retaining the supplied parent independently.
 * @param parent An already independently retained private directory authority, consumed on every outcome.
 * @param finalName Valid literal final component; native publication always refuses replacement.
 * @param replacement Internal fixed generated-record authority, absent for immutable writers.
 * @returns A release-only-finalized resource for the shared lifecycle; it exposes no raw handle publicly.
 */
export function createWindowsWriterResource(
  parent: WindowsWriterParent, finalName: string, replacement?: WindowsWriterReplacement,
): StreamWriterResource & { readonly parentIdentity: StreamIdentity } {
  try {
    validateName(finalName)
    const state: WriterState = { parent, replacement, source: null, identity: null, finalName,
      stagingName: `.dsh-private-${randomBytes(20).toString('hex')}`, initializationAttempted: false,
      publication: 'not-published', closed: false, deletionPending: false }
    return new WindowsWriterResource(state)
  } catch (error) { failWithWindowsCleanup(error, () => { parent.release() }) }
}
