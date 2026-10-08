/** Real owner calls paused at observed boundaries; raw handles exist only in the test SDK observer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, readSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { installOwnerObserver } from './owner-observer.mjs'
import { decodeFileIdentity, sdkHandleObserver, sdkInheritanceBinding } from './boundary-support.mjs'

const [entry, rootPath, scenario, targetName, sdkDirectory] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(scenario.startsWith('fault:'), false, 'C-internal fault rows remain explicitly blocked in the matrix')
const k = createRequire(entry)('koffi')
assert.equal(k.version, '3.1.1')
const kernel = k.load('kernel32.dll')
const files = new Map(), trace = [], failedCloses = []
let active = false, source, sourceName, sourceMode, readFile, paused = false, flushes = 0, readCalls = 0
let writtenBytes = 0, root, outcome, ownerCalls = 0, faultInjected = false, lease, liveWorker
let nextCapability = 1
const controlSlot = Buffer.alloc(8), sdkChildSlot = Buffer.alloc(8)
let closeControl, stopSdkChild
const hash = value => createHash('sha256').update(value).digest('hex')
const snapshot = ['inheritance', 'lifetime', 'live-worker-close', 'live-worker-terminate'].includes(scenario)
  ? sdkHandleObserver(entry, sdkDirectory, rootPath) : undefined
const identities = () => [...files.values()].map(file => file.identity)
const barrier = phase => {
  assert.equal(paused, false, 'Each fixture owns exactly one barrier')
  paused = true
  writeSync(1, `${JSON.stringify({ event: 'barrier', phase, sourceName: sourceName ?? null,
    sourceMode: sourceMode ?? null, readCalls, realNativeCalls: true, observation: 'opaque-owner-method',
    storageCapabilities: files.size })}\n`)
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('Boundary controller disappeared')
}
const observer = installOwnerObserver(entry, (name, args, forward, owner) => {
  ownerCalls++
  const creating = name === 'open' && args[3] === 'create'
  const retainedSource = args[0] === source && source !== undefined
  const event = { name, forwarded: false,
    ...(files.has(args[0]) ? { capability: files.get(args[0]).id } : {}),
    ...(retainedSource ? { retainedSource: true } : {}),
    ...(name === 'open' ? { mode: args[3] } : {}) }
  if (active) {
    assert.ok(trace.length < 3000, 'Owner boundary trace exceeded its bound')
    trace.push(event)
    if (!paused) {
      if (name === 'read' && scenario === 'read-held') { readFile = args[0]; barrier('read-held') }
      if (creating && scenario === 'before-create') barrier('before-create')
      if (name === 'rename' && retainedSource && scenario === 'before-rename') barrier('before-rename')
    }
    if (name === 'write' && retainedSource && scenario === 'publish-prewrite-failure') {
      if (!paused) barrier('before-failing-write')
      faultInjected = true; event.injected = true
      throw Object.assign(new Error('Test-owned prewrite rejection at the coarse owner call'), { code: 'native', win32Code: 29 })
    }
  }
  event.forwarded = true
  let result
  try { result = forward() }
  catch (error) { if (name === 'close') failedCloses.push(error.message); throw error }
  if (name === 'open') {
    assert.equal(files.has(result), false)
    files.set(result, { id: nextCapability++, identity: decodeFileIdentity(owner.fileId(result)) })
    if (scenario === 'ancestor-held' && !paused && args[1] === basename(dirname(rootPath))) barrier('ancestor-held')
    if (active && creating) {
      source = result; sourceName = args[1]; sourceMode = args[3]
      if (!paused && scenario === 'after-create') barrier('after-create')
    }
  }
  if (name === 'close') assert.equal(files.delete(args[0]), true)
  if (active && name === 'read') {
    readCalls++; readFile = args[0]
    if (!paused && scenario === 'read-after-chunk') barrier('read-after-chunk')
  }
  if (active && name === 'write' && retainedSource) {
    writtenBytes += result
    if (!paused && scenario === 'after-write' && writtenBytes === 256 * 1024) barrier('after-write')
  }
  if (active && name === 'flush' && retainedSource) {
    flushes++
    if (!paused && scenario === (flushes === 1 ? 'after-pre-flush' : 'after-post-flush')) barrier(scenario)
  }
  if (active && !paused && name === 'rename' && retainedSource && scenario === 'after-rename') barrier('after-rename')
  return result
})

try {
  const storage = await import(pathToFileURL(entry).href)
  root = storage.openPrivateDirectory(rootPath, { create: false })
  if (scenario === 'root-held') barrier('root-held')
  active = true
  if (scenario === 'capability-domain') {
    active = false
    liveWorker = new Worker(new URL('boundary-capability-worker.mjs', import.meta.url), {
      workerData: { entry, capability: { identity: root.identity, publications: root.publications } },
    })
    const messages = []
    await new Promise((resolve, reject) => {
      liveWorker.on('message', message => messages.push(message))
      liveWorker.once('error', reject)
      liveWorker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Capability Worker exited ${code}`)))
    })
    assert.deepEqual(messages, [{ complete: true, realWorkerRealm: true, clonedIdentityRejected: true }])
    outcome = { ok: true, ...messages[0], sha256: hash(storage.readPrivateFile(root, targetName, 1024 * 1024)) }
  } else if (scenario === 'live-worker-close' || scenario === 'live-worker-terminate') {
    active = false
    root.close()
    liveWorker = new Worker(new URL('boundary-live-worker.mjs', import.meta.url), { workerData: { entry, rootPath, sdkDirectory } })
    const exit = new Promise(resolve => { liveWorker.once('exit', resolve) })
    const messages = []
    let wake
    let workerError
    liveWorker.on('error', error => { workerError = error; wake?.() })
    liveWorker.on('message', message => { messages.push(message); wake?.() })
    const next = async () => {
      while (!messages.length && !workerError) await new Promise(resolve => { wake = resolve })
      wake = undefined
      if (workerError) throw workerError
      return messages.shift()
    }
    const ready = await next()
    assert.equal(ready.event, 'ready')
    const contender = storage.openPrivateDirectory(rootPath, { create: false })
    try {
      assert.deepEqual(contender.identity, ready.directoryIdentity)
      assert.throws(() => storage.acquirePrivateWriterLease(contender, 'worker.lock'), error => error.code === 'busy' || error.code === 'sharing')
    } finally { contender.close() }
    if (scenario === 'live-worker-close') {
      liveWorker.postMessage('close')
      assert.deepEqual(await next(), { event: 'closed' })
      assert.equal(await exit, 0)
    } else {
      assert.equal(await liveWorker.terminate(), 1)
      assert.equal(await exit, 1)
    }
    assert.ok(Array.isArray(ready.observedHandles) && ready.observedHandles.length > 1 && ready.observedHandles.length <= 1024)
    assert.equal(ready.sdkDllSha256, snapshot.dllSha256)
    snapshot.assertReleased(ready.observedHandles)
    const afterExit = observer.owners[0].statistics()
    for (const field of ['openFiles', 'openTokens', 'localAllocBlocks', 'pendingContexts', 'unconfirmedReleases']) assert.equal(afterExit[field], 0)
    assert.equal(afterExit.heapBlocks - afterExit.owners - afterExit.fileRecords, 0)
    root = storage.openPrivateDirectory(rootPath, { create: false })
    lease = storage.acquirePrivateWriterLease(root, 'worker.lock')
    assert.deepEqual(lease.identity, ready.leaseIdentity, 'Worker exit must release, never replace, the fixed lease file')
    lease.close()
    const bytes = storage.readPrivateFile(root, targetName, 1024 * 1024)
    root.close()
    const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32'])
    assert.notEqual(move(rootPath, `${rootPath}-worker-exited`, 0), 0, 'No Worker leaf-directory guard may survive its exit')
    assert.notEqual(move(`${rootPath}-worker-exited`, rootPath, 0), 0)
    outcome = { ok: true, actualWorkerTerminated: scenario === 'live-worker-terminate',
      explicitCloseControl: scenario === 'live-worker-close', leaseIdentityPreserved: true,
      observedWorkerHandlesReleased: ready.observedHandles.length, sdkDllSha256: snapshot.dllSha256,
      sdkCurrentProcessSnapshot: true, rootRelocatedAfterExit: true, sha256: hash(bytes) }
  } else if (scenario === 'inheritance') {
    active = false
    assert.equal(typeof sdkDirectory, 'string')
    const dllPath = join(sdkDirectory, 'boundary-inheritance.dll')
    const childPath = join(sdkDirectory, 'boundary-inheritance-child.exe')
    const childBinding = sdkInheritanceBinding(sdkDirectory, 'inheritance-child')
    const helper = snapshot.helper
    const openControl = helper.func('__stdcall', 'dsh_open_inheritable_control', 'uint32', ['str16', 'void *'])
    closeControl = helper.func('__stdcall', 'dsh_close_control', 'uint32', ['void *'])
    stopSdkChild = helper.func('__stdcall', 'dsh_stop_child', 'uint32', ['void *', 'uint32', 'void *'])
    const launch = helper.func('__stdcall', 'dsh_launch_inheritance', 'uint32',
      ['str16', 'str16', 'str16', 'uint32', 'void *', 'void *', 'void *', 'void *'])
    lease = storage.acquirePrivateWriterLease(root, 'inheritance.lock')
    const storageHandles = snapshot.owned(identities())
    assert.ok(storageHandles.some(identity => identity.volumeSerial === root.identity.volumeSerial && identity.fileId === root.identity.fileId),
      'Observe the actual retained private leaf handle')
    assert.ok(storageHandles.some(identity => identity.volumeSerial === lease.identity.volumeSerial && identity.fileId === lease.identity.fileId),
      'Observe the actual retained kernel lease handle')
    const probe = (name, observed, expectedMatches) => {
      const specification = join(rootPath, `inheritance-${name}.txt`)
      const reportPath = join(rootPath, `inheritance-${name}.json`)
      const lines = observed.map(({ handle, volumeSerial, fileId }) => `${handle} ${volumeSerial} ${fileId}`)
      writeFileSync(specification, `DSH-INHERITANCE-v1\n${lines.join('\n')}\n`, { flag: 'wx' })
      const exit = Buffer.alloc(4), timeout = Buffer.alloc(4), stopped = Buffer.alloc(4)
      assert.deepEqual(sdkInheritanceBinding(sdkDirectory, 'inheritance-child'), childBinding)
      const error = launch(childPath, specification, reportPath, 10_000, exit, timeout, stopped, sdkChildSlot)
      assert.equal(error, 0, `SDK child launch failed: ${error}`)
      assert.equal(timeout.readUInt32LE(), 0)
      assert.equal(stopped.readUInt32LE(), 1)
      assert.equal(sdkChildSlot.readBigUInt64LE(), 0n)
      assert.equal(exit.readUInt32LE(), 0)
      assert.deepEqual(sdkInheritanceBinding(sdkDirectory, 'inheritance-child'), childBinding)
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      assert.equal(report.complete, true)
      assert.equal(report.sdkChild, true)
      assert.equal(report.records, observed.length)
      assert.equal(report.matchingInheritedIdentities, expectedMatches)
      return report
    }
    const denied = probe('storage', storageHandles, 0)
    assert.equal(openControl(rootPath, controlSlot), 0)
    const control = controlSlot.readBigUInt64LE()
    assert.notEqual(control, 0n)
    const found = snapshot.capture([root.identity]).find(record => record.handle === control.toString(16).padStart(16, '0'))
    assert.ok(found)
    assert.equal(found.flags & 1, 1)
    const positive = probe('positive-control', [...storageHandles, found], 1)
    assert.equal(closeControl(controlSlot), 0)
    outcome = { ok: true, actualCreateProcessInheritHandles: true, storageHandles: storageHandles.length,
      liveLeaseAndAllAncestorGuardsObserved: true, sdkCurrentProcessSnapshot: true,
      denied, positive, sdkDllSha256: hash(readFileSync(dllPath)), sdkChildSha256: hash(readFileSync(childPath)),
      sha256: hash(storage.readPrivateFile(root, targetName, 1024 * 1024)) }
  } else if (scenario === 'lifetime') {
    active = false
    const old = root
    const released = snapshot.owned(identities())
    const releasedHandles = new Set(released.map(record => record.handle))
    old.close()
    assert.equal(files.size, 0)
    snapshot.assertReleased(released)
    let reused = false
    let attempts = 0
    for (; attempts < 256; attempts++) {
      root = storage.openPrivateDirectory(rootPath, { create: false })
      reused = snapshot.owned(identities()).some(record => releasedHandles.has(record.handle))
      if (reused) break
      root.close()
    }
    assert.equal(reused, true, 'This fixture requires observed real kernel handle-value reuse')
    const before = ownerCalls
    old.close()
    old.close()
    assert.throws(() => storage.readPrivateFile(old, targetName, 1024 * 1024), error => error.code === 'closed')
    assert.throws(() => storage.readPrivateFile({ identity: root.identity, publications: [] }, targetName, 1024 * 1024), error => error.code === 'closed')
    assert.equal(ownerCalls, before, 'Stale or forged capabilities must fail before any owner call')
    snapshot.owned(identities())
    const bytes = storage.readPrivateFile(root, targetName, 1024 * 1024)
    assert.throws(() => structuredClone(root), error => error.name === 'DataCloneError')
    outcome = { ok: true, realKernelHandleValueReused: true, attempts: attempts + 1,
      staleCapabilityNativeCalls: 0, observation: 'opaque-owner-method', sdkCurrentProcessSnapshot: true,
      sdkDllSha256: snapshot.dllSha256, structuredCloneRejected: true, sha256: hash(bytes) }
  } else if (scenario === 'cooperating-publisher' || scenario === 'cooperating-contender') {
    lease = storage.acquirePrivateWriterLease(root, 'writer.lock')
    if (scenario === 'cooperating-publisher') barrier('writer-lease-held')
    const bytes = Buffer.alloc(256 * 1024, scenario === 'cooperating-publisher' ? 0x4e : 0x52)
    const receipt = storage.replacePrivateFile(root, targetName, bytes)
    outcome = { ok: true, receipt, leaseIdentity: lease.identity, sha256: hash(bytes) }
  } else if (scenario.startsWith('read-') || scenario === 'root-held' || scenario === 'ancestor-held') {
    const bytes = storage.readPrivateFile(root, targetName, 1024 * 1024)
    outcome = { ok: true, byteLength: bytes.length, sha256: hash(bytes) }
  } else {
    const bytes = Buffer.alloc(256 * 1024, 0x4e)
    const receipt = storage.replacePrivateFile(root, targetName, bytes)
    outcome = { ok: true, receipt, byteLength: bytes.length, sha256: hash(bytes) }
  }
} catch (error) {
  outcome = { ok: false, name: error.name, code: error.code ?? null, reason: error.message,
    receipt: error.receipt ?? null, nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null }
} finally {
  active = false
  // The outer owned process bounds even a Worker stuck inside a native call.
  if (liveWorker) await liveWorker.terminate()
  if (sdkChildSlot.readBigUInt64LE() !== 0n && stopSdkChild) {
    const stopped = Buffer.alloc(4)
    const error = stopSdkChild(sdkChildSlot, 5000, stopped)
    if (error) outcome.sdkStopFailure = error
    if (stopped.readUInt32LE() !== 1 || sdkChildSlot.readBigUInt64LE() !== 0n) outcome.unsettledSdkChild = true
  }
  if (controlSlot.readBigUInt64LE() !== 0n && closeControl) {
    const error = closeControl(controlSlot)
    if (error) outcome.sdkControlCloseFailure = error
  }
  try { lease?.close() } catch (error) { outcome.leaseCloseFailure = error.message }
  try { root?.close() } catch (error) { outcome.closeFailure = error.message }
  observer.restore()
}
const statistics = observer.owners[0]?.statistics() ?? null
writeSync(1, `${JSON.stringify({ event: 'result', scenario, paused, realNativeCalls: true,
  observation: 'opaque-owner-method', nativeOwnerBinding: observer.binding, outcome,
  readCalls, readHandleObserved: readFile !== undefined, writtenBytes, flushes, sourceName: sourceName ?? null,
  sourceMode: sourceMode ?? null, remainingCapabilities: files.size, statistics,
  faultInjected, faultOrigin: faultInjected ? 'test-owned-coarse-owner-prewrite-rejection' : 'none', failedCloses, trace })}\n`)
