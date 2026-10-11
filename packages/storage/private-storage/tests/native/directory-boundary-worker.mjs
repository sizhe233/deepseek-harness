/** Installed-entry native interception. Only explicitly recorded buffers/returns are injected. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { cases, injectDirectoryRecord, installedBinding, queryBudget, sourceBinding } from './directory-boundary-support.mjs'

const [entry, rootPath, scenario] = process.argv.slice(2)
assert.equal(process.platform, 'win32', 'Actual Windows is required')
assert.equal(process.arch, 'x64')
assert.ok(cases.includes(scenario))
const binding = installedBinding(entry)
const fixture = sourceBinding()
const k = createRequire(entry)('koffi')
const original = { load: k.load, alloc: k.alloc, free: k.free, view: k.view }
const handles = new Map(), allocations = new Set(), descriptors = new Set(), inherited = new Set()
const trace = [], releaseErrors = [], protocolViolations = []
let generation = 0, nativeCalls = 0, queryCalls = 0, injections = 0
let active = false, faultInjected = false, writeFailureInjected = false, lastErrorOverride
let root, lease, outcome, poisonProbe, idempotence
const mode = scenario.replace(/^directory-enumeration-/u, '').replace(/^cleanup-real-/u, '').replace(/-return-failure$/u, '')
const view = (pointer, size) => Buffer.from(original.view(pointer, size))
const invariant = (condition, message) => {
  if (!condition) { protocolViolations.push(message); assert.fail(message) }
}
const kernel = original.load('kernel32.dll')
const handleInformation = kernel.func('__stdcall', 'GetHandleInformation', 'int', ['void *', 'void *'])
const trackHandle = (handle, role) => {
  assert.ok(handle !== 0n && handle !== 0xffffffffffffffffn)
  invariant(!handles.has(handle), 'An opened handle must not alias another live owned resource')
  const info = Buffer.alloc(4)
  assert.notEqual(handleInformation(handle, info), 0)
  if (info.readUInt32LE() & 1) inherited.add(++generation)
  else generation++
  handles.set(handle, { role, generation })
}
const nameOf = attributes => {
  const object = view(attributes, 48), unicode = view(object.readBigUInt64LE(16), 16)
  return view(unicode.readBigUInt64LE(8), unicode.readUInt16LE()).toString('utf16le')
}
const failure = error => ({ ok: false, name: error.name, code: error.code ?? null, reason: error.message,
  receipt: error.receipt ?? null, cleanupFailed: error.cleanupFailed ?? false,
  nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null })
const inject = (event, value, kind = 'test-owned-return', win32Code) => {
  event.injected = true; event.injectionOrigin = kind; event.visibleReturn = typeof value === 'bigint' ? 'non-null-pointer' : value
  faultInjected = true; injections++
  if (win32Code !== undefined) lastErrorOverride = win32Code
  return value
}
k.alloc = (...args) => {
  const pointer = original.alloc(...args)
  invariant(!allocations.has(pointer), 'Allocation returned another live owned address')
  allocations.add(pointer)
  return pointer
}
k.free = pointer => {
  invariant(allocations.delete(pointer), 'Never free an unowned or already freed allocation')
  try { original.free(pointer) }
  catch (error) { protocolViolations.push('Koffi free completion was not observed'); throw error }
}
k.load = (...loadArgs) => {
  const library = original.load(...loadArgs)
  return new Proxy(library, { get(target, property, receiver) {
    if (property !== 'func') return Reflect.get(target, property, receiver)
    return (...signature) => {
      const name = signature[1], call = target.func(...signature)
      return (...argv) => {
        nativeCalls++
        if (name === 'GetLastError' && lastErrorOverride !== undefined) {
          const value = lastErrorOverride; lastErrorOverride = undefined; return value
        }
        const owned = handles.get(argv[0])
        const event = { name, forwarded: false, ...(owned ? { resource: owned.generation, role: owned.role } : {}),
          ...(name === 'NtSetInformationFile' ? { informationClass: argv[4] } : {}) }
        if (active) { assert.ok(trace.length < 3000, 'Bounded native trace exceeded'); trace.push(event) }
        if (name === 'CloseHandle') invariant(Boolean(owned), 'Never close an unowned, released or reused handle')
        if (name === 'LocalFree') invariant(descriptors.has(argv[0]), 'Never free an unowned descriptor')
        if (['NtCreateFile', 'OpenProcessToken', 'OpenThreadToken'].includes(name)) {
          invariant(!trace.some(row => row.cleanupFault), 'No new handle may be opened after an injected cleanup return; numeric reuse must remain impossible')
        }
        if (active && name === 'NtQueryDirectoryFile') {
          queryCalls++
          assert.equal(argv[6], 65536); assert.equal(argv[7], 12)
          assert.equal(argv[10], queryCalls === 1 ? 1 : 0)
          if (queryCalls > queryBudget) {
            writeSync(1, `${JSON.stringify({ event: 'query-budget-exhausted', scenario, queryCalls, budget: queryBudget,
              entrySha256: binding.entrySha256, nativeBinarySha256: binding.nativeBinarySha256,
              fixtureSourceSha256: fixture.sha256, forwardedDirectoryQueries: queryCalls - 1,
              faultOrigin: 'test-owned-dot-only-pages', actualPendingRequest: false })}\n`)
            // Controller kills this exact owned process; no buffer is freed while the operation is live.
            readSync(0, Buffer.alloc(1), 0, 1, null)
            throw new Error('Controller must terminate an operation that exceeds its native-query budget')
          }
        }
        if (active && ['staging-close', 'staging-disposition'].includes(mode) && name === 'WriteFile' && !writeFailureInjected) {
          writeFailureInjected = true
          return inject(event, 0, 'test-owned-return', 29)
        }
        if (active && name === 'WaitForSingleObject' && mode.startsWith('pending-')) {
          assert.equal(argv[1], 0xffffffff)
          // The original request actually completed synchronously; a zero-time real wait cannot hang this fixture.
          argv[1] = 0; event.forwardedTimeoutMs = 0; event.requestedTimeoutMs = 0xffffffff
        }
        event.forwarded = true
        let result = call(...argv)
        event.actualReturn = typeof result === 'bigint' ? (result === 0n ? 0 : 'non-null-pointer') : result
        if (name === 'NtCreateFile' && result === 0) {
          const openedName = nameOf(argv[2])
          const role = argv[7] === 2 ? 'staging' : openedName === 'record.bin' ? 'file' : openedName === 'writer.lock' ? 'lease' : 'directory'
          trackHandle(view(argv[0], 8).readBigUInt64LE(), role)
        }
        if ((name === 'OpenProcessToken' || name === 'OpenThreadToken') && result) trackHandle(view(argv.at(-1), 8).readBigUInt64LE(), 'token')
        if (name === 'GetSecurityInfo' && result === 0) {
          const pointer = view(argv[7], 8).readBigUInt64LE()
          assert.notEqual(pointer, 0n); assert.equal(descriptors.has(pointer), false); descriptors.add(pointer)
        }
        if (name === 'CloseHandle' && result) { assert.equal(handles.delete(argv[0]), true); event.actuallyReleased = true }
        if (name === 'LocalFree' && (result === null || result === 0n)) { assert.equal(descriptors.delete(argv[0]), true); event.actuallyReleased = true }
        if (active && scenario.startsWith('directory-enumeration-') && name === 'NtQueryDirectoryFile') {
          const io = view(argv[4], 16), data = view(argv[5], argv[6])
          event.actualStatus = result >>> 0
          event.actualBytes = io.readBigUInt64LE(8).toString()
          if (mode === 'total-query-ceiling') {
            injectDirectoryRecord(mode, io, data); result = inject(event, 0, 'test-owned-buffer')
          } else if (!faultInjected && !['baseline', 'entry-ceiling'].includes(mode)) {
            assert.equal(result, 0, 'Inject only after observing a real successful enumeration')
            if (mode === 'native-failure' || mode === 'warning-return') {
              const status = mode === 'native-failure' ? -1073741823 : -2147483643
              io.writeInt32LE(status, 0); result = inject(event, status)
            } else if (mode.startsWith('pending-')) {
              if (mode !== 'pending-settled') io.writeInt32LE(0x103, 0)
              result = inject(event, 0x103)
            } else {
              injectDirectoryRecord(mode, io, data); result = inject(event, 0, 'test-owned-buffer')
            }
          }
        }
        if (active && name === 'WaitForSingleObject' && mode.startsWith('pending-')) {
          assert.equal(result, 0, 'The actual synchronous query must already be signaled')
          if (mode === 'pending-unsettled') result = inject(event, 0xffffffff)
          if (mode === 'pending-wait-error') {
            inject(event, null, 'test-owned-exception'); throw new Error('Injected wait return loss after completed zero-time native wait')
          }
        }
        const closeRole = { 'token-close': 'token', 'file-close': 'file', 'directory-close': 'directory', 'staging-close': 'staging' }[mode]
        const cleanupAlreadyInjected = trace.some(row => row.cleanupFault === true)
        if (active && !cleanupAlreadyInjected) {
          if (name === 'CloseHandle' && closeRole === owned?.role) {
            assert.notEqual(result, 0); event.cleanupFault = true; result = inject(event, 0, 'test-owned-return', 6)
          } else if (name === 'LocalFree' && mode === 'local-free') {
            assert.ok(result === null || result === 0n); event.cleanupFault = true; result = inject(event, argv[0])
          } else if (name === 'UnlockFileEx' && mode === 'unlock') {
            assert.notEqual(result, 0); event.cleanupFault = true; event.actuallyUnlocked = true; result = inject(event, 0, 'test-owned-return', 158)
          } else if (name === 'NtSetInformationFile' && argv[4] === 13 && mode === 'staging-disposition') {
            assert.equal(result, 0); event.cleanupFault = true; event.actualDeletionDisposition = true
            view(argv[1], 16).writeInt32LE(-1073741823, 0); result = inject(event, -1073741823)
          }
        }
        return result
      }
    }
  } })
}
let storage
try {
  storage = await import(pathToFileURL(entry).href)
  assert.equal(storage.capabilities().nativeArtifact.nativeBinarySha256, binding.nativeBinarySha256)
  root = storage.openPrivateDirectory(rootPath, { create: false })
  lease = storage.acquirePrivateWriterLease(root, 'writer.lock')
  if (mode === 'directory-close') { lease.close(); lease = undefined }
  active = true
  if (mode === 'unlock') lease.close()
  else if (mode === 'directory-close') root.close()
  else if (mode === 'staging-close' || mode === 'staging-disposition') storage.replacePrivateFile(root, 'record.bin', Buffer.from('synthetic unpublished replacement'))
  else outcome = { ok: true, audit: storage.auditPrivateTree(root, { maxEntries: mode === 'entry-ceiling' ? 1 : 8, maxDepth: 0 }, lease) }
  outcome ??= { ok: true }
} catch (error) {
  outcome = failure(error)
  if (mode === 'pending-unsettled' || mode === 'pending-wait-error') {
    const before = { calls: nativeCalls, allocations: allocations.size }
    try { storage.auditPrivateTree(root, { maxEntries: 8, maxDepth: 0 }, lease); poisonProbe = { rejected: false } }
    catch (next) { poisonProbe = { rejected: true, code: next.code, nativeCalls: nativeCalls - before.calls, allocationChange: allocations.size - before.allocations } }
  }
  if (mode === 'unlock' || mode === 'directory-close') {
    const before = nativeCalls
    try {
      if (mode === 'unlock') { lease.close(); lease.release() }
      else { root.close(); root.close() }
      idempotence = { repeatCloseNativeCalls: nativeCalls - before }
    } catch (next) { idempotence = { error: next.message } }
  }
} finally {
  active = false
  try { lease?.close() } catch (error) { releaseErrors.push({ resource: 'lease', reason: error.message }) }
  try { root?.close() } catch (error) { releaseErrors.push({ resource: 'root', reason: error.message }) }
  k.load = original.load; k.alloc = original.alloc; k.free = original.free; k.view = original.view
}
writeSync(1, `${JSON.stringify({ event: 'result', scenario, ...binding, fixtureSourceSha256: fixture.sha256,
  realNativeCalls: true, faultInjected, injections, writeFailureInjected, queryCalls, nativeCalls, outcome,
  remainingStorageHandles: handles.size, remainingBackingAllocations: allocations.size,
  remainingSecurityDescriptors: descriptors.size, inheritableStorageHandles: inherited.size,
  releaseErrors, protocolViolations, poisonProbe: poisonProbe ?? null, idempotence: idempotence ?? null, trace })}\n`)
