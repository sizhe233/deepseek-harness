/** Packed-entry negative branch using a copied native descriptor; no disk ACL is changed. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { installOwnerObserver } from './owner-observer.mjs'
import { decodeFileIdentity } from './boundary-support.mjs'
import { absentDaclCopy } from './descriptor-buffer-support.mjs'

const [entry, rootPath, name] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const hash = value => createHash('sha256').update(value).digest('hex')
let target, operation, root, result
const injections = [], refusals = []
const observer = installOwnerObserver(entry, (method, args, forward, owner) => {
  const returned = forward()
  if (!operation || method !== 'security') return returned
  const identity = decodeFileIdentity(owner.fileId(args[0]))
  if (identity.volumeSerial !== target.volumeSerial || identity.fileId !== target.fileId) return returned
  const original = Buffer.from(returned), modified = absentDaclCopy(returned)
  assert.deepEqual(Buffer.from(returned), original)
  injections.push({ operation, forwarded: true, originalSha256: hash(original), modifiedSha256: hash(modified),
    originalControl: original.readUInt16LE(2), modifiedControl: modified.readUInt16LE(2),
    originalDaclOffset: original.readUInt32LE(16), modifiedDaclOffset: modified.readUInt32LE(16), identity })
  return modified
})
try {
  const storage = await import(pathToFileURL(entry).href)
  root = storage.openPrivateDirectory(rootPath, { create: false })
  target = storage.inspectPrivate(root, name).identity
  for (const [action, invoke] of [['read', () => storage.readPrivateFile(root, name, 1024)],
    ['replace', () => storage.replacePrivateFile(root, name, Buffer.from('synthetic forbidden replacement'))]]) {
    operation = action
    assert.throws(invoke, error => {
      assert.equal(error.name, 'PrivateStorageError'); assert.equal(error.code, 'privacy')
      assert.notEqual(error.cleanupFailed, true)
      refusals.push({ operation: action, name: error.name, code: error.code })
      return true
    })
    operation = undefined
  }
  assert.deepEqual(injections.map(event => event.operation), ['read', 'replace'])
  result = { complete: true, evidence: 'instrumented-descriptor-buffer', actualDiskAbsentDacl: false,
    filesystemSecurityModified: false, nativeSecurityCallsForwarded: true, injections, refusals, target,
    nativeOwnerBinding: observer.binding }
} catch (error) {
  result = { complete: false, reason: error.message }; process.exitCode = 1
} finally {
  operation = undefined
  try { root?.close() } catch (error) { result.closeFailure = error.message; process.exitCode = 1 }
  observer.restore()
}
writeSync(1, JSON.stringify(result) + '\n')
