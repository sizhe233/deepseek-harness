/** Real Windows resource regression. Call wrappers observe actual handles/allocations, never emulate them. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdirSync, writeSync } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const [entry, rootPath, kind] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(typeof global.gc, 'function', 'Launch this fixture with --expose-gc')
assert.ok(kind === 'directories' || kind === 'leases')
const k = createRequire(entry)('koffi')
assert.equal(k.version, '3.1.1')
const original = { load: k.load, alloc: k.alloc, free: k.free }
const handles = new Set()
const allocations = new Set()
const failedCloses = []
let namespaceMutations = 0
let finalizing = false
const kernel = original.load('kernel32.dll')
const currentProcess = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
const processHandleCount = kernel.func('__stdcall', 'GetProcessHandleCount', 'int', ['void *', 'void *'])
const handleCount = () => {
  const output = Buffer.alloc(4)
  assert.notEqual(processHandleCount(currentProcess(), output), 0)
  return output.readUInt32LE(0)
}
k.alloc = (...args) => {
  const pointer = original.alloc(...args)
  allocations.add(pointer)
  return pointer
}
k.free = pointer => {
  original.free(pointer)
  assert.equal(allocations.delete(pointer), true, 'Every freed backing allocation must belong to this runtime')
}
k.load = (...args) => {
  const library = original.load(...args)
  return new Proxy(library, {
    get(target, property, receiver) {
      if (property !== 'func') return Reflect.get(target, property, receiver)
      return (...signature) => {
        const name = signature[1]
        const call = target.func(...signature)
        return (...arguments_) => {
          if (finalizing && ((name === 'NtCreateFile' && arguments_[7] === 2) || name === 'NtSetInformationFile' || name === 'WriteFile')) namespaceMutations++
          const result = call(...arguments_)
          if (name === 'NtCreateFile' && result === 0) handles.add(Buffer.from(k.view(arguments_[0], 8)).readBigUInt64LE(0))
          if (name === 'CloseHandle') {
            if (!result) failedCloses.push(String(arguments_[0]))
            else handles.delete(arguments_[0])
          }
          return result
        }
      }
    },
  })
}

const sampleCount = 100
let root
let outcome
try {
  const storage = await import(pathToFileURL(entry).href)
  // Resolve lazy DLL/native loading before taking the real process-handle baseline.
  storage.openPrivateDirectory(rootPath, { create: false }).close()
  if (kind === 'leases') {
    root = storage.openPrivateDirectory(rootPath, { create: false })
    for (let i = 0; i < sampleCount; i++) storage.acquirePrivateWriterLease(root, `gc-${i}.lock`).close()
  }
  const namesBefore = readdirSync(rootPath).sort()
  const identitiesBefore = kind === 'leases' ? namesBefore.map(name => storage.inspectPrivate(root, name).identity) : []
  await nextTurn(); global.gc(); await nextTurn()
  const baseline = { processHandles: handleCount(), storageHandles: handles.size, backingAllocations: allocations.size }
  const acquire = () => kind === 'directories'
    ? storage.openPrivateDirectory(rootPath, { create: false })
    : null
  const acquireSample = index => kind === 'directories' ? acquire() : storage.acquirePrivateWriterLease(root, `gc-${index}.lock`)
  const explicit = Array.from({ length: sampleCount }, (_, index) => acquireSample(index))
  assert.ok(handleCount() >= baseline.processHandles + sampleCount)
  assert.ok(handles.size >= baseline.storageHandles + sampleCount)
  for (const capability of explicit) { capability.close(); capability.close() }
  explicit.length = 0
  await nextTurn(); global.gc(); await nextTurn()
  assert.equal(handles.size, baseline.storageHandles)
  assert.equal(allocations.size, baseline.backingAllocations)
  const explicitClose = { processHandles: handleCount(), storageHandles: handles.size, backingAllocations: allocations.size }
  function droppedSamples() {
    const references = []
    for (let index = 0; index < sampleCount; index++) references.push(new WeakRef(acquireSample(index)))
    return references
  }
  const references = droppedSamples()
  const peak = { processHandles: handleCount(), storageHandles: handles.size, backingAllocations: allocations.size }
  assert.ok(peak.processHandles >= explicitClose.processHandles + sampleCount)
  assert.ok(peak.storageHandles >= baseline.storageHandles + sampleCount)
  finalizing = true
  const deadline = Date.now() + 30_000
  let collected = false
  do {
    await nextTurn()
    global.gc()
    await nextTurn()
    collected = references.every(reference => reference.deref() === undefined)
    if (collected && handles.size === baseline.storageHandles && allocations.size === baseline.backingAllocations) break
  } while (Date.now() < deadline)
  finalizing = false
  assert.equal(collected, true, 'Dropped opaque capabilities must become unreachable')
  assert.equal(handles.size, baseline.storageHandles, 'Finalizers must release all observed real storage handles')
  assert.equal(allocations.size, baseline.backingAllocations, 'Finalizers must release retained native backing allocations')
  const afterGc = { processHandles: handleCount(), storageHandles: handles.size, backingAllocations: allocations.size }
  assert.ok(afterGc.processHandles <= explicitClose.processHandles, 'Real process handle count must return to the explicit-close control')
  assert.equal(namespaceMutations, 0, 'Finalizers may only release resources, never create/write/rename/delete')
  assert.deepEqual(readdirSync(rootPath).sort(), namesBefore)
  if (kind === 'leases') {
    for (let index = 0; index < sampleCount; index++) {
      const lease = storage.acquirePrivateWriterLease(root, `gc-${index}.lock`)
      lease.close()
    }
    assert.deepEqual(namesBefore.map(name => storage.inspectPrivate(root, name).identity), identitiesBefore)
  }
  assert.equal(failedCloses.length, 0, 'Explicit close followed by GC must not double-close native handles')
  outcome = { complete: true, kind, sampleCount, baseline, explicitClose, peak, afterGc, namespaceMutations,
    realNativeCalls: true, allLeasesReacquired: kind === 'leases', names: namesBefore, identities: identitiesBefore }
} catch (error) {
  outcome = { complete: false, kind, reason: error.message }
  process.exitCode = 1
} finally {
  finalizing = false
  try { root?.close() } catch (error) { outcome.closeFailure = error.message; process.exitCode = 1 }
  outcome.remainingStorageHandles = handles.size
  outcome.remainingBackingAllocations = allocations.size
  k.load = original.load; k.alloc = original.alloc; k.free = original.free
}
writeSync(1, `${JSON.stringify(outcome)}\n`)
