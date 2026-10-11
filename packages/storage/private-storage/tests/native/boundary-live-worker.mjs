/** Keep real opaque capabilities live until explicit close or abrupt Worker termination. */
import assert from 'node:assert/strict'
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { installOwnerObserver } from './owner-observer.mjs'
import { decodeFileIdentity, sdkHandleObserver } from './boundary-support.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
const snapshot = sdkHandleObserver(workerData.entry, workerData.sdkDirectory, workerData.rootPath)
const files = new Map()
const observer = installOwnerObserver(workerData.entry, (name, args, forward, owner) => {
  const result = forward()
  if (name === 'open') files.set(result, decodeFileIdentity(owner.fileId(result)))
  if (name === 'close') assert.equal(files.delete(args[0]), true)
  return result
})
const storage = await import(pathToFileURL(workerData.entry).href)
assert.equal(storage.capabilities().available, true)
let directory, lease
try {
  directory = storage.openPrivateDirectory(workerData.rootPath, { create: false })
  lease = storage.acquirePrivateWriterLease(directory, 'worker.lock')
} catch (error) {
  lease?.close()
  directory?.close()
  throw error
}
const observedHandles = snapshot.owned([...files.values()])
assert.ok(observedHandles.length > 1)
parentPort.on('message', message => {
  if (message !== 'close') throw new Error('Unknown native Worker control')
  lease.close()
  directory.close()
  assert.equal(files.size, 0)
  snapshot.assertReleased(observedHandles)
  observer.restore()
  parentPort.postMessage({ event: 'closed' })
  parentPort.close()
})
parentPort.postMessage({ event: 'ready', directoryIdentity: directory.identity, leaseIdentity: lease.identity,
  observedHandles, sdkDllSha256: snapshot.dllSha256, nativeOwnerBinding: observer.binding })
