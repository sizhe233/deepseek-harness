/** Same-handle private record reads, retaining exact private admission independently of shared sources. */
import { createHash } from 'node:crypto'
import { PrivateStorageError } from './error.ts'
import type { Handle } from './native.ts'
import { sameIdentity, validateName } from './policy.ts'
import { SourceObservationError } from './stream-error.ts'
import { validateStreamChunkSize } from './stream-policy.ts'
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts } from './stream-types.ts'
import type { PrivateIdentity } from './types.ts'
import type { WindowsWriterParent } from './windows-stream-writer.ts'
import { failWithWindowsCleanup, releaseWindowsResources } from './windows-stream-cleanup.ts'

interface RecordState {
  readonly parent: WindowsWriterParent
  readonly name: string
  file: Handle | null
  identity: PrivateIdentity | null
  closed: boolean
}
type WindowsPrivateRecordFacts = SourceFileFacts & {
  readonly identity: Extract<SourceFileFacts['identity'], { backend: 'windows-ntfs' }>
}
function release(state: RecordState): void {
  if (state.closed) return
  state.closed = true
  const file = state.file
  state.file = null
  releaseWindowsResources([() => { if (file !== null) state.parent.api.close(file) }, () => { state.parent.release() }])
}
const finalizers = new FinalizationRegistry<RecordState>((state) => {
  try { release(state) } catch (_error) { /* Explicit close reports unconfirmed resource release. */ }
})
function observe(state: RecordState): WindowsPrivateRecordFacts {
  if (state.closed || state.file === null) throw new PrivateStorageError('closed', 'live private record required')
  state.parent.validate()
  const api = state.parent.api
  const facts = api.inspect(state.file, state.parent.sid)
  if (facts.kind !== 'file' || facts.links !== 1 || facts.identity.volumeSerial !== state.parent.identity.volumeSerial
    || state.identity !== null && !sameIdentity(facts.identity, state.identity)) {
    throw new SourceObservationError(new PrivateStorageError('identity', 'private record identity changed'))
  }
  api.verifyName(state.file, state.name)
  const source = api.inspectSource(state.file)
  if (!sameIdentity(source.identity, facts.identity) || source.sizeBytes !== facts.sizeBytes
    || source.links !== facts.links || source.attributes !== facts.attributes
    || source.lastWriteTime !== facts.lastWriteTime || source.changeTime !== facts.changeTime) {
    throw new SourceObservationError(new PrivateStorageError('changed', 'private record changed during inspection'))
  }
  const sizeBytes = Number(facts.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new PrivateStorageError('limit', 'private record size')
  state.identity ??= facts.identity
  const observations = Object.freeze({ volumeSerial: facts.identity.volumeSerial, fileId: facts.identity.fileId,
    sizeBytes: facts.sizeBytes.toString(), links: facts.links, lastWriteTime: facts.lastWriteTime.toString(),
    changeTime: facts.changeTime.toString(), attributes: facts.attributes, ownerSid: facts.ownerSid,
    daclProtected: facts.daclProtected, securityDescriptorSha256: source.securityDescriptorSha256 })
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }), sizeBytes,
    links: facts.links, observations, changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') })
}
/** Internal replacement observer; callers cannot extract the retained OS handle. */
export interface WindowsPrivateRecordResource extends SourceReaderResource {
  inspect(): WindowsPrivateRecordFacts
  observeRetired(): ReturnType<WindowsWriterParent['api']['inspectRetiredPrivate']>
}
class RecordResource implements WindowsPrivateRecordResource {
  private readonly state: RecordState
  constructor(state: RecordState) { this.state = state; finalizers.register(this, state, this) }
  inspect(): WindowsPrivateRecordFacts { return observe(this.state) }
  observeRetired(): ReturnType<WindowsWriterParent['api']['inspectRetiredPrivate']> {
    if (this.state.closed || this.state.file === null) throw new PrivateStorageError('closed', 'retained control record required')
    this.state.parent.validate()
    return this.state.parent.api.inspectRetiredPrivate(this.state.file, this.state.parent.sid)
  }
  read(maxBytes: number): Uint8Array {
    validateStreamChunkSize(maxBytes)
    const file = this.state.file
    if (file === null) throw new PrivateStorageError('closed', 'retained private record required')
    const before = observe(this.state)
    const output = Buffer.alloc(maxBytes)
    const count = this.state.parent.api.read(file, output)
    const after = observe(this.state)
    if (before.changeToken !== after.changeToken) throw new SourceObservationError(new PrivateStorageError('changed', 'private record changed during read'))
    return output.subarray(0, count)
  }
  close(): void { finalizers.unregister(this); release(this.state) }
}

/**
 * Admit one private record without reopening it to attach identity after reading.
 * @param parent Independently retained private parent, consumed on success and failure.
 * @param name Literal existing generated record component.
 * @param replacement Whether an internal control transaction must permit its own target replacement.
 * @returns Bounded native resource retaining its source and every parent until explicit release.
 */
export function openWindowsPrivateRecordResource(
  parent: WindowsWriterParent, name: string, replacement = false,
): WindowsPrivateRecordResource {
  const state: RecordState = { parent, name, file: null, identity: null, closed: false }
  try {
    validateName(name)
    parent.validate()
    state.file = parent.api.open(parent.handle, name, 'file', replacement ? 'read' : 'read-source', parent.sid)
    observe(state)
    return new RecordResource(state)
  } catch (error) { failWithWindowsCleanup(error, () => { release(state) }) }
}
