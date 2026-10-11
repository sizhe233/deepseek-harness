/** One isolated source-instrumented native run; the packed native binary is byte-checked but never loaded. */
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ownerBinding, wrapOwner } from './owner-observer.mjs'
import { ownerFaultBinding, ownerFileDigest, ownerDigest } from './owner-fault-support.mjs'

const [entry, binary, rootPath, scenario] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const binding = ownerBinding(entry), instrumented = ownerFaultBinding(binary), require = createRequire(entry)
assert.equal(require.cache[binding.binary], undefined, 'Production native payload must not execute in a source-instrumented worker')
const fixture = require(binary), owners = [], capabilities = []
assert.deepEqual(Object.getOwnPropertyNames(fixture).sort(), ['arm', 'createOwner', 'report', 'reset'])
const replacement = new Module(binding.binary)
replacement.filename = binding.binary; replacement.loaded = true
replacement.exports = { createOwner() {
  const owner = fixture.createOwner(); owners.push(owner)
  return wrapOwner(owner, (name, args, forward) => {
    const result = forward()
    if (name === 'open') capabilities.push({ owner, value: result, kind: args[2], name: args[1] })
    return result
  })
} }
require.cache[binding.binary] = replacement
const storage = await import(pathToFileURL(entry).href)
let root, lease, outcome, poisonProbe, idempotence
const failure = error => ({ ok: false, code: error.code ?? null, operation: error.operation ?? null,
  reason: error.message, cleanupFailed: error.cleanupFailed ?? false, pending: error.pending ?? false,
  nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null, receipt: error.receipt ?? null })
const dynamic = /^native-one-shot-(publish-)?(alloc|view):(\d+)$/u.exec(scenario)
const publish = scenario.startsWith('native-publish-') || dynamic?.[1] === 'publish-'
let mode = dynamic ? dynamic[2] : scenario.replace(/^directory-enumeration-|^native-call-boundary-|^cleanup-real-/u, '').replace(/-return-failure$/u, '')
if (scenario.endsWith('-allocation-baseline') || scenario === 'verify') mode = 'baseline'
try {
  root = storage.openPrivateDirectory(rootPath, { create: false })
  lease = storage.acquirePrivateWriterLease(root, 'writer.lock')
  if (mode === 'lock-failure' || mode === 'directory-close') { lease.close(); lease = undefined }
  fixture.arm(mode, dynamic ? Number(dynamic[3]) : 0)
  if (scenario === 'verify') outcome = { ok: true, leaseIdentity: lease.identity }
  else if (mode === 'directory-close') root.close()
  else if (mode === 'unlock' || mode === 'unlock-failure') lease.close()
  else if (mode === 'lock-failure') lease = storage.acquirePrivateWriterLease(root, 'writer.lock')
  else if (['open-token', 'token-size', 'token-read', 'token-close'].includes(mode)) owners[0].tokenUser()
  else if (mode === 'volume' || mode === 'native-volume') {
    const directory = capabilities.find(capability => capability.kind === 'directory')
    if (mode === 'volume') directory.owner.volumeInfo(directory.value)
    else directory.owner.query(directory.value, 4, 8, true)
  } else if (scenario.startsWith('directory-enumeration-')) {
    outcome = { ok: true, audit: storage.auditPrivateTree(root, { maxEntries: mode === 'entry-ceiling' ? 1 : 8, maxDepth: 0 }, lease) }
  } else if (publish || mode === 'staging-close' || mode === 'staging-disposition') {
    outcome = { ok: true, receipt: storage.replacePrivateFile(root, 'record.bin', Buffer.from('synthetic source-instrumented replacement\n')) }
  } else {
    const bytes = storage.readPrivateFile(root, 'record.bin', 1048576)
    outcome = { ok: true, bytes: bytes.length, readSha256: ownerDigest(bytes) }
  }
  outcome ??= { ok: true }
} catch (error) {
  outcome = failure(error)
  if (mode === 'pending-unsettled' || mode === 'pending-wait-error') {
    const before = fixture.report()
    try { owners[0].tokenUser(); poisonProbe = { rejected: false } }
    catch (next) {
      const after = fixture.report()
      poisonProbe = { rejected: true, code: next.code, nativeCalls: after.trace.length - before.trace.length,
        allocationChange: after.allocations - before.allocations }
    }
  }
  if (mode === 'unlock' || mode === 'directory-close') {
    const before = fixture.report().trace.length
    try {
      if (mode === 'unlock') { lease.close(); lease.release() } else { root.close(); root.close() }
      idempotence = { repeatCloseNativeCalls: fixture.report().trace.length - before }
    } catch (next) { idempotence = { error: next.message } }
  }
} finally {
  // Leave instrumentation active during cleanup so injected release returns and retries remain observable.
  for (const value of [lease, root]) {
    try { value?.close() } catch (error) { outcome.cleanupReason ??= error.message }
  }
}
const detail = fixture.report(); fixture.reset()
assert.equal(require.cache[binding.binary], replacement)
assert.equal(ownerFileDigest(binding.binary), binding.sha256)
process.stdout.write(`${JSON.stringify({ event: 'result', scenario, evidence: 'source-instrumented-native-owner-faults',
  packedProductionBinaryExecution: false, realStorageFailureClaimed: false, actualAllocatorFailureClaimed: false,
  ...detail, fixtureSourceSha256: instrumented.fixtureSourceSha256, fixtureBinarySha256: instrumented.fixtureBinarySha256,
  productionBinarySha256: binding.sha256, entrySha256: ownerFileDigest(entry), outcome,
  poisonProbe: poisonProbe ?? null, idempotence: idempotence ?? null,
  backendBoundObserved: mode === 'total-query-ceiling' && outcome.code === 'limit' && !detail.overflow,
})}\n`)
