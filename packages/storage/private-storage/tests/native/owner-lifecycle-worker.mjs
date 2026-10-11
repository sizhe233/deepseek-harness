/** Real Node-API owner lifetime fixture; no native function or platform is mocked. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
const { createOwner } = createRequire(import.meta.url)(workerData.addonPath)
assert.equal(typeof createOwner, 'function')
const owner = createOwner()
const initial = owner.statistics()
let directory
let lease
const retainedCapabilities = []

function openDirectory(path) {
  assert.match(path, /^[A-Za-z]:\\/u)
  let current = owner.open(null, `\\??\\${path.slice(0, 3)}`, 'directory', 'inspect', null)
  retainedCapabilities.push(current)
  try {
    for (const component of path.slice(3).split('\\').filter(Boolean)) {
      const next = owner.open(current, component, 'directory', 'inspect', null)
      retainedCapabilities.push(next)
      owner.close(current)
      current = next
    }
    return current
  } catch (error) {
    owner.close(current)
    throw error
  }
}

function close() {
  if (lease) { owner.close(lease); owner.close(lease) }
  if (directory) { owner.close(directory); owner.close(directory) }
  for (const capability of retainedCapabilities) owner.close(capability)
}

try {
  directory = openDirectory(win32.resolve(workerData.rootPath))
  const directoryIdentity = owner.fileId(directory).toString('hex')
  assert.equal(directoryIdentity.length, 48)
  if (workerData.mode === 'resource-limits') {
    const closed = []
    for (let index = 0; index < 16384 + 32; index++) {
      const file = owner.open(directory, 'owner.lock', 'file', 'inspect', null)
      owner.close(file)
      closed.push(file)
    }
    assert.equal(owner.statistics().openFiles, initial.openFiles + 1)
    for (const file of closed) assert.throws(() => owner.fileType(file), error => error.code === 'closed')
    const simultaneous = []
    for (let index = 0; index < 16384 - 1; index++) simultaneous.push(owner.open(directory, 'owner.lock', 'file', 'inspect', null))
    assert.throws(() => owner.open(directory, 'owner.lock', 'file', 'inspect', null), error => error.code === 'limit')
    owner.close(simultaneous.pop())
    simultaneous.push(owner.open(directory, 'owner.lock', 'file', 'inspect', null))
    for (const file of simultaneous) owner.close(file)
    close()
    const settled = owner.statistics()
    assert.equal(settled.openFiles, initial.openFiles)
    assert.ok(settled.fileRecords >= closed.length, 'Retained closed capabilities still own their native metadata')
    assert.equal(settled.heapBlocks, settled.owners + settled.fileRecords, 'No transient buffers remain at this quiescent barrier')
    parentPort.postMessage({ event: 'resource-limits', sequential: closed.length, simultaneousLimit: 16384, statistics: owner.statistics() })
    parentPort.close()
  } else if (workerData.mode === 'rollback') {
    const before = owner.statistics()
    for (let iteration = 0; iteration < 128; iteration++) {
      assert.throws(() => owner.open(directory, 'missing-file', 'file', 'inspect', null),
        error => error.code === 'not-found' && typeof error.nativeStatus === 'number'
          && error.cleanupFailed === false && error.pending === false)
      assert.deepEqual(owner.statistics(), before, 'A failed open must roll back its native record and transient buffers')
      assert.ok(owner.tokenUser().length >= 12)
      assert.ok(owner.security(directory).length >= 20)
      assert.deepEqual(owner.statistics(), before, 'Token and LocalAlloc security queries must release native allocations before returning')
    }
    close()
    parentPort.postMessage({ event: 'rollback', repetitions: 128, directoryIdentity, statistics: owner.statistics() })
    parentPort.close()
  } else {
    lease = owner.open(directory, 'owner.lock', 'file', 'lock', null)
    const leaseIdentity = owner.fileId(lease).toString('hex')
    if (workerData.mode === 'probe') {
      let acquired = false
      let refusal
      try { owner.lock(lease); acquired = true } catch (error) {
        refusal = { code: error.code, operation: error.operation, win32Code: error.win32Code }
      }
      if (acquired) owner.unlock(lease)
      close()
      parentPort.postMessage({ event: 'probe', acquired, refusal, directoryIdentity, leaseIdentity })
      parentPort.close()
    } else {
      owner.lock(lease)
      assert.equal(owner.statistics().openFiles, initial.openFiles + 2)
      parentPort.on('message', message => {
        if (message === 'close') {
          close()
          assert.equal(owner.statistics().openFiles, initial.openFiles)
          parentPort.postMessage({ event: 'closed', statistics: owner.statistics() })
        } else if (message === 'exit') {
          parentPort.close()
        } else {
          throw new Error('Unknown native owner worker command')
        }
      })
      parentPort.postMessage({ event: 'ready', directoryIdentity, leaseIdentity, statistics: owner.statistics() })
    }
  }
} catch (error) {
  close()
  throw error
}
