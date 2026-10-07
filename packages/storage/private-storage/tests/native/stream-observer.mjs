/** Test-only opaque-owner calls and quiescent native counters; never synthesized syscall traces. */
import assert from 'node:assert/strict'
import { installOwnerObserver } from './owner-observer.mjs'
import { decodeFileIdentity, sdkHandleObserver } from './boundary-support.mjs'

/** Forward actual native operations and inject only one explicitly labelled lost return after success. */
export function observeNative(entry, sdkDirectory, rootPath) {
  const sdk = sdkHandleObserver(entry, sdkDirectory, rootPath)
  const files = new Map(), calls = new Map(), faults = [], protocolViolations = []
  let generation = 0, nativeCalls = 0, armed = null
  let checkedStorageHandles = 0
  let writeBytes = 0, readBytes = 0, maxWriteRequestBytes = 0, maxReadRequestBytes = 0
  let flushes = 0, published = false, deletionsAfterPublish = 0
  const invariant = (condition, message) => {
    if (!condition) { protocolViolations.push(message); assert.fail(message) }
  }
  const observer = installOwnerObserver(entry, (name, args, invoke, owner) => {
    const owned = files.get(args[0]), key = name === 'query' ? `${name}/${args[1]}/${args[3]}` : name
    invariant(calls.has(key) || calls.size < 128, 'Native summary keys exceeded fixed bound')
    const record = calls.get(key) ?? { name, ...(name === 'query' ? { informationClass: args[1], volume: args[3] } : {}), count: 0, forwarded: 0 }
    const event = { name, forwarded: true, ...(owned ? { resource: owned.generation, role: owned.role } : {}) }
    if (name === 'close') invariant(Boolean(owned), 'Never retry a retired or unowned capability')
    nativeCalls++; record.count++; record.forwarded++
    let returned
    try { returned = invoke() }
    catch (error) {
      event.actualReturn = 'thrown-native'
      event.actualFailure = { nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null }
      record.first ??= { ...event }; record.last = { ...event }; calls.set(key, record)
      throw error
    }
    event.actualReturn = typeof returned === 'number' ? returned : returned === undefined ? 'completed-void' : 'completed-value'
    if (name === 'open') {
      invariant(!files.has(returned), 'A newly opened opaque capability cannot reuse a live capability')
      const identity = decodeFileIdentity(owner.fileId(returned))
      const prior = new Set([...files.values()].map(file => file.sdkRecord.handle))
      const observed = sdk.owned([...files.values()].map(file => file.identity).concat(identity))
      const added = observed.filter(record => !prior.has(record.handle))
      invariant(added.length === 1, 'A single native open must add one independently observed SDK handle')
      files.set(returned, { generation: ++generation, identity, sdkRecord: added[0],
        role: args[1].startsWith('.dsh-private-') ? 'staging' : args[1] === 'source.bin' ? 'source' : 'other' })
      checkedStorageHandles++
      event.requestedMode = args[3]; event.requestedKind = args[2]
    }
    if (name === 'close') {
      sdk.assertReleased([owned.sdkRecord])
      invariant(files.delete(args[0]), 'Close must retire one owned capability'); event.actuallyReleased = true
    }
    if (name === 'write' || name === 'read') {
      event.requestedBytes = name === 'write' ? args[1].byteLength : args[1]
      event.actualBytes = name === 'write' ? returned : returned.byteLength
      if (name === 'write') { writeBytes += event.actualBytes; maxWriteRequestBytes = Math.max(maxWriteRequestBytes, event.requestedBytes) }
      else { readBytes += event.actualBytes; maxReadRequestBytes = Math.max(maxReadRequestBytes, event.requestedBytes) }
    }
    if (name === 'flush') flushes++
    if (name === 'rename') { published = true; event.actualPublication = true }
    if (name === 'remove') { if (published) deletionsAfterPublish++; event.actualDeletionDisposition = true }
    const target = armed === 'stream-real-write-return-loss' ? 'write' : armed === 'source-real-read-return-loss' ? 'read'
      : armed === 'stream-real-rename-return-loss' ? 'rename' : armed === 'stream-real-postflush-return-loss' && flushes === 2 ? 'flush'
        : armed === 'stream-real-close-return-loss' && owned?.role === 'staging' ? 'close'
          : armed === 'source-real-close-return-loss' && owned?.role === 'source' ? 'close' : null
    const lost = name === target
    if (lost) {
      event.visibleReturn = 'thrown'; event.origin = 'test-owned-return-loss'
      if (name === 'read' || name === 'write') assert.ok(event.actualBytes > 0)
      faults.push({ ...event }); armed = null
    }
    record.first ??= { ...event }; record.last = { ...event }; calls.set(key, record)
    if (lost) throw Object.assign(new Error(`Injected lost return after successful native ${name}`),
      name === 'rename' ? { nativeStatus: 0xc0000001 } : { win32Code: name === 'close' ? 6 : name === 'read' ? 30 : 29, cleanupFailed: name === 'close' })
    return returned
  })
  return {
    arm(scenario) { assert.equal(armed, null); assert.equal(faults.length, 0); armed = scenario },
    snapshot() {
      invariant(observer.owners.length === 1, 'One admitted native owner must serve this installed provider')
      const counters = observer.owners[0].statistics()
      for (const value of Object.values(counters)) invariant(Number.isSafeInteger(value) && value >= 0, 'Native counters must be bounded nonnegative integers')
      const transient = counters.heapBlocks - counters.owners - counters.fileRecords
      invariant(transient >= 0, 'Reconcile separate native counters only at a controlled quiescent barrier')
      return { nativeCalls, observationLayer: 'opaque-native-owner-methods', counterObservation: 'controlled-quiescent-barrier',
        ownerBinding: observer.binding, nativeCounters: counters, calls: [...calls.values()].map(value => structuredClone(value)), faults: structuredClone(faults),
        writeBytes, readBytes, maxWriteRequestBytes, maxReadRequestBytes, flushes, deletionsAfterPublish,
        remainingStorageCapabilities: files.size, remainingStorageHandles: counters.openFiles,
        remainingTokenHandles: counters.openTokens, remainingBackingAllocations: transient,
        remainingSecurityDescriptors: counters.localAllocBlocks, pendingContexts: counters.pendingContexts,
        unconfirmedReleases: counters.unconfirmedReleases,
        inheritanceObservation: { status: 'verified', mechanism: 'current-process-sdk-snapshot', checkedStorageHandles,
          inheritableStorageHandles: 0, sdkDllSha256: sdk.dllSha256 },
        protocolViolations: [...protocolViolations] }
    },
    restore() { observer.restore() },
  }
}
