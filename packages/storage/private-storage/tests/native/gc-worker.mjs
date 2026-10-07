/** Real C-owner resource regression, independently matched to SDK process-handle snapshots. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdirSync, writeSync } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { installOwnerObserver } from './owner-observer.mjs'
import { decodeFileIdentity, sdkHandleObserver } from './boundary-support.mjs'

const [entry, rootPath, kind, sdkDirectory] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(typeof global.gc, 'function', 'Launch this fixture with --expose-gc')
assert.ok(kind === 'directories' || kind === 'leases')
const snapshot = sdkHandleObserver(entry, sdkDirectory, rootPath)
const k = createRequire(entry)('koffi')
const kernel = k.load('kernel32.dll')
const currentProcess = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
const processHandleCount = kernel.func('__stdcall', 'GetProcessHandleCount', 'int', ['void *', 'void *'])
const handleCount = () => {
  const output = Buffer.alloc(4)
  assert.notEqual(processHandleCount(currentProcess(), output), 0)
  return output.readUInt32LE(0)
}
const files = new Map(), keys = new WeakMap(), failedCloses = []
let nextKey = 0, namespaceMutations = 0, finalizing = false
const observer = installOwnerObserver(entry, (name, args, forward, owner) => {
  if (finalizing && (name === 'open' && args[3] === 'create' || ['write', 'rename', 'remove'].includes(name))) namespaceMutations++
  let result
  try { result = forward() }
  catch (error) { if (name === 'close') failedCloses.push(error.message); throw error }
  if (name === 'open') {
    const key = ++nextKey
    keys.set(result, key)
    // The observer must not keep a native capability reachable during the GC sample.
    files.set(key, { reference: new WeakRef(result), identity: decodeFileIdentity(owner.fileId(result)) })
  }
  if (name === 'close') assert.equal(files.delete(keys.get(args[0])), true, 'Close must release an observed owned capability once')
  return result
})
const statistics = () => {
  assert.equal(observer.owners.length, 1)
  return observer.owners[0].statistics()
}
const cleanTransientState = value => ['openTokens', 'openProcesses', 'localAllocBlocks', 'pendingContexts', 'unconfirmedReleases']
  .every(name => value[name] === 0)
async function collectUntil(predicate, message) {
  const deadline = Date.now() + 30_000
  do {
    await nextTurn(); global.gc(); await nextTurn()
    if (predicate()) return
  } while (Date.now() < deadline)
  assert.fail(message)
}
const sdkOwned = () => {
  const identities = [...files.values()].map(file => {
    assert.notEqual(file.reference.deref(), undefined, 'A live tracked native capability must remain reachable until its observed close')
    return file.identity
  })
  return identities.length ? snapshot.owned(identities) : []
}
function closeSamples(values) {
  for (const capability of values) { capability.close(); capability.close() }
  values.length = 0
}
const sampleCount = 100
let root, outcome, empty
try {
  const storage = await import(pathToFileURL(entry).href)
  storage.openPrivateDirectory(rootPath, { create: false }).close()
  await collectUntil(() => {
    const value = statistics()
    return value.openFiles === 0 && value.fileRecords === 0 && cleanTransientState(value)
  }, 'Warmup must release every C-owned file and transient resource')
  empty = statistics()
  assert.equal(empty.heapBlocks, empty.owners)
  if (kind === 'leases') {
    root = storage.openPrivateDirectory(rootPath, { create: false })
    for (let i = 0; i < sampleCount; i++) storage.acquirePrivateWriterLease(root, 'gc-' + i + '.lock').close()
  }
  const namesBefore = readdirSync(rootPath).sort()
  const identitiesBefore = kind === 'leases' ? namesBefore.map(name => storage.inspectPrivate(root, name).identity) : []
  await collectUntil(() => {
    const value = statistics()
    return value.fileRecords === value.openFiles && value.heapBlocks === value.owners + value.fileRecords && cleanTransientState(value)
  }, 'Lease setup must release closed native metadata before sampling')
  const baselineNative = statistics(), baselineSdk = sdkOwned()
  assert.equal(baselineSdk.length, baselineNative.openFiles)
  const measure = () => {
    const native = statistics()
    assert.ok(cleanTransientState(native), 'No native transient resources or uncertain releases may survive a quiescent sample')
    return { processHandles: handleCount(), storageHandles: native.openFiles, backingAllocations: native.heapBlocks - empty.heapBlocks, native }
  }
  const baseline = measure()
  const acquireSample = index => kind === 'directories' ? storage.openPrivateDirectory(rootPath, { create: false })
    : storage.acquirePrivateWriterLease(root, 'gc-' + index + '.lock')
  const explicit = Array.from({ length: sampleCount }, (_, index) => acquireSample(index))
  const recordKey = record => record.handle + '/' + record.volumeSerial + '/' + record.fileId
  const explicitSdk = sdkOwned(), baselineKeys = new Set(baselineSdk.map(recordKey))
  const sampled = records => records.filter(record => !baselineKeys.has(recordKey(record)))
  assert.ok(handleCount() >= baseline.processHandles + sampleCount)
  assert.ok(statistics().openFiles >= baseline.storageHandles + sampleCount)
  assert.equal(explicitSdk.length, statistics().openFiles)
  closeSamples(explicit)
  await collectUntil(() => JSON.stringify(statistics()) === JSON.stringify(baselineNative), 'Explicit close and GC must retire all sampled C metadata')
  snapshot.assertReleased(sampled(explicitSdk))
  const explicitClose = measure()
  function droppedSamples() {
    return Array.from({ length: sampleCount }, (_, index) => new WeakRef(acquireSample(index)))
  }
  const references = droppedSamples(), peakSdk = sdkOwned(), peak = measure()
  assert.ok(peak.processHandles >= explicitClose.processHandles + sampleCount)
  assert.ok(peak.storageHandles >= baseline.storageHandles + sampleCount)
  assert.equal(peakSdk.length, peak.storageHandles)
  finalizing = true
  await collectUntil(() => references.every(reference => reference.deref() === undefined)
    && JSON.stringify(statistics()) === JSON.stringify(baselineNative), 'Dropped public and native capabilities must release every C-owned resource')
  finalizing = false
  snapshot.assertReleased(sampled(peakSdk))
  const afterGc = measure()
  assert.ok(afterGc.processHandles <= explicitClose.processHandles, 'Real process handle count must return to the explicit-close control')
  assert.equal(namespaceMutations, 0, 'Finalizers may only release resources, never create/write/rename/delete')
  assert.deepEqual(readdirSync(rootPath).sort(), namesBefore)
  if (kind === 'leases') {
    for (let index = 0; index < sampleCount; index++) storage.acquirePrivateWriterLease(root, 'gc-' + index + '.lock').close()
    assert.deepEqual(namesBefore.map(name => storage.inspectPrivate(root, name).identity), identitiesBefore)
  }
  assert.equal(failedCloses.length, 0, 'Explicit close followed by GC must not double-close native handles')
  outcome = { complete: true, kind, sampleCount, baseline, explicitClose, peak, afterGc, namespaceMutations,
    nativeOwnerBinding: observer.binding, sdkDllSha256: snapshot.dllSha256, independentlyMatchedHandles: { explicit: explicitSdk.length, gc: peakSdk.length },
    realNativeCalls: true, allLeasesReacquired: kind === 'leases', names: namesBefore, identities: identitiesBefore }
} catch (error) {
  outcome = { complete: false, kind, reason: error.message }
  process.exitCode = 1
} finally {
  finalizing = false
  try {
    root?.close(); root = undefined
    if (empty) await collectUntil(() => JSON.stringify(statistics()) === JSON.stringify(empty), 'Final cleanup must restore the empty C owner')
  } catch (error) { outcome.closeFailure = error.message; process.exitCode = 1 }
  if (observer.owners.length) {
    outcome.remainingNativeStatistics = statistics()
    outcome.remainingStorageHandles = statistics().openFiles
    outcome.remainingBackingAllocations = empty ? statistics().heapBlocks - empty.heapBlocks : null
  }
  observer.restore()
}
writeSync(1, JSON.stringify(outcome) + '\n')
