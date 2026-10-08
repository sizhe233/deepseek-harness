/** Private append-at-EOF logs with retained handles and explicit flush/release observations. */
import { types } from 'node:util'
import { PrivateStorageError } from './error.ts'
import type { Handle } from './native.ts'
import { sameIdentity, validateName } from './policy.ts'
import { PrivateLogSinkError } from './log-error.ts'
import type { PrivateIdentity } from './types.ts'
import type { PrivateLogReceipt, PrivateLogSink } from './log-types.ts'
import type { WindowsWriterParent } from './windows-stream-writer.ts'
import { releaseWindowsResources } from './windows-stream-cleanup.ts'

interface LogState {
  readonly parent: WindowsWriterParent
  readonly name: string
  readonly maximum: number
  file: Handle | null
  identity: PrivateIdentity | null
  initialSize: bigint | null
  accepted: bigint
  closed: boolean
  facts: PrivateLogReceipt
  failure: PrivateLogSinkError | null
}
function snapshot(state: LogState): PrivateLogReceipt {
  return Object.freeze({ ...state.facts, lastAppend: Object.freeze({ ...state.facts.lastAppend }) })
}
function observe(state: LogState): bigint {
  if (state.closed || state.file === null) throw new PrivateStorageError('closed', 'live private log required')
  state.parent.validate()
  const facts = state.parent.api.inspect(state.file, state.parent.sid)
  if (facts.kind !== 'file' || facts.links !== 1 || !facts.writeThrough || facts.identity.volumeSerial !== state.parent.identity.volumeSerial
    || state.identity !== null && !sameIdentity(facts.identity, state.identity)) throw new PrivateStorageError('identity', 'private log changed')
  state.parent.api.verifyName(state.file, state.name)
  if ((facts.attributes & 1) !== 0 || facts.sizeBytes < 0n) throw new PrivateStorageError('unsupported', 'writable private log required')
  if (state.identity === null) {
    state.identity = facts.identity
    state.initialSize = facts.sizeBytes
    state.facts = { ...state.facts, identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }), initialSizeBytes: facts.sizeBytes.toString() }
  }
  state.facts = { ...state.facts, observedSizeBytes: facts.sizeBytes.toString() }
  return facts.sizeBytes
}
function release(state: LogState): void {
  if (state.closed) return
  state.closed = true
  const file = state.file
  state.file = null
  try {
    releaseWindowsResources([() => { if (file !== null) state.parent.api.close(file) }, () => { state.parent.release() }])
    state.facts = { ...state.facts, release: 'released' }
  } catch (error) { state.facts = { ...state.facts, release: 'failed' }; throw error }
}
const finalizers = new FinalizationRegistry<LogState>((state) => {
  try { release(state) } catch (_error) { /* Finalizers release only; explicit close owns flush and its receipt. */ }
})
function fail(state: LogState, error: unknown): never {
  state.facts = { ...state.facts, outcome: 'failed' }
  state.failure = new PrivateLogSinkError(snapshot(state), error)
  throw state.failure
}
class WindowsLogSink implements PrivateLogSink {
  private readonly state: LogState
  constructor(state: LogState) { this.state = state; finalizers.register(this, state, this) }
  get receipt(): PrivateLogReceipt { return snapshot(this.state) }
  private requireOpen(): Handle {
    if (this.state.failure !== null) throw this.state.failure
    if (this.state.closed || this.state.file === null) throw new PrivateLogSinkError(this.receipt, new PrivateStorageError('closed', 'private log closed'))
    return this.state.file
  }
  append(chunk: Uint8Array): void {
    const file = this.requireOpen()
    const state = this.state
    state.facts = { ...state.facts, phase: 'append' }
    let before: bigint | null = null
    let bytes: Buffer | null = null
    let attempted = false
    try {
      if (!types.isUint8Array(chunk) || types.isSharedArrayBuffer(chunk.buffer)
        || chunk.byteLength < 1 || chunk.byteLength > state.maximum) throw new RangeError('private log chunk exceeds its owned byte bound')
      bytes = Buffer.from(chunk)
      before = observe(state)
      if (state.initialSize === null || before !== state.initialSize + state.accepted) throw new PrivateStorageError('changed', 'private log size changed')
      state.facts = { ...state.facts, durability: 'unconfirmed', synchronization: 'not-attempted', lastAppend: { requestedBytes: bytes.length, confirmedBytes: null, outcome: 'indeterminate' } }
      attempted = true
      state.parent.api.append(file, bytes)
      const after = observe(state)
      if (after !== before + BigInt(bytes.length)) throw new PrivateStorageError('changed', 'private log append length differs')
      state.accepted += BigInt(bytes.length)
      state.facts = { ...state.facts, acceptedBytes: state.accepted.toString(), lastAppend: {
        requestedBytes: bytes.length, confirmedBytes: bytes.length, outcome: 'appended',
      } }
    } catch (error) {
      if (attempted && before !== null && bytes !== null) {
        let confirmedBytes: number | null = null
        try { const delta = observe(state) - before; if (delta >= 0n && delta <= BigInt(bytes.length)) confirmedBytes = Number(delta) }
        catch (_observationError) { /* A failed independent observation cannot certify the append extent. */ }
        state.facts = { ...state.facts, lastAppend: { requestedBytes: bytes.length, confirmedBytes,
          outcome: confirmedBytes !== null && confirmedBytes < bytes.length ? 'partial' : 'indeterminate' } }
      }
      fail(state, error)
    }
  }
  flush(): PrivateLogReceipt {
    const file = this.requireOpen(), state = this.state
    state.facts = { ...state.facts, phase: 'flush' }
    try { observe(state) } catch (error) { fail(state, error) }
    try { state.parent.api.flush(file) }
    catch (error) { state.facts = { ...state.facts, durability: 'unconfirmed', synchronization: 'failed' }; fail(state, error) }
    state.facts = { ...state.facts, durability: 'synced', synchronization: 'succeeded' }
    try { observe(state) } catch (error) { fail(state, error) }
    return this.receipt
  }
  close(): PrivateLogReceipt {
    const state = this.state
    if (state.closed) {
      if (state.failure !== null) throw state.failure
      return this.receipt
    }
    let primary: unknown = state.failure
    if (primary === null) {
      try { this.flush() } catch (error) { primary = error }
    }
    state.facts = { ...state.facts, phase: 'close' }
    finalizers.unregister(this)
    try { release(state) } catch (error) { primary = primary === null ? error : new AggregateError([primary, error]) }
    if (primary !== null) fail(state, primary)
    state.facts = { ...state.facts, outcome: 'closed' }
    return this.receipt
  }
}

/**
 * Open or privately create a log without truncating, replacing or repairing an existing object.
 * @param parent Independently retained private directory, consumed on every result.
 * @param name Fixed literal log component.
 * @param maximum Positive per-call byte limit no greater than 65536.
 * @returns Append-only sink; the caller must retain it strongly and explicitly close after its input streams drain.
 */
export function openWindowsPrivateLogSink(parent: WindowsWriterParent, name: string, maximum: number): PrivateLogSink {
  const state: LogState = { parent, name, maximum, file: null, identity: null, initialSize: null, accepted: 0n,
    closed: false, failure: null,
    facts: { name, identity: null, parentIdentity: Object.freeze({ backend: 'windows-ntfs', ...parent.identity }), initialSizeBytes: null,
      acceptedBytes: '0', observedSizeBytes: null, lastAppend: { requestedBytes: 0, confirmedBytes: null, outcome: 'not-attempted' },
      durability: 'unconfirmed', synchronization: 'not-attempted', release: 'retained', phase: 'open', outcome: 'open' } }
  try {
    validateName(name)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536) throw new RangeError('private log bound must be from 1 through 65536')
    parent.validate()
    state.file = parent.api.open(parent.handle, name, 'file', 'log', parent.sid)
    observe(state)
    return new WindowsLogSink(state)
  } catch (error) {
    let failure = error
    try { release(state) } catch (closeError) { failure = new AggregateError([error, closeError]) }
    fail(state, failure)
  }
}
