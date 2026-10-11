/** A separate V8 worker cannot turn a cloned identity into a live directory capability. */
import assert from 'node:assert/strict'
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
const storage = await import(pathToFileURL(workerData.entry).href)
assert.equal(storage.capabilities().available, true)
let rejected = false
try { storage.readPrivateFile(workerData.capability, 'record.bin', 1024 * 1024) }
catch (error) {
  assert.equal(error.name, 'PrivateStorageError')
  assert.equal(error.code, 'closed')
  rejected = true
}
assert.equal(rejected, true)
parentPort.postMessage({ complete: true, realWorkerRealm: true, clonedIdentityRejected: true })
