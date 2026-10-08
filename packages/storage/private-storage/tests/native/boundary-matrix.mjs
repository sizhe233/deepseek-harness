/** Deterministic native races and process death against one independently packed storage entry. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownerBinding } from './owner-observer.mjs'
import { createFixtureRoot, ownerOnlyDaclSddl, Blocked, digest, fileDigest, fixtureEnvironment, options, oracle, startChild, summary, nativeFaultMapping } from './boundary-support.mjs'

const args = options(process.argv.slice(2))
const entry = args.get('--entry')
const sdk = args.get('--oracle')
const output = args.get('--output')
const workerPath = fileURLToPath(new URL('boundary-worker.mjs', import.meta.url))
const oldBytes = Buffer.alloc(256 * 1024, 0x31)
const newBytes = Buffer.alloc(256 * 1024, 0x4e)
const report = { schemaVersion: 1, evidence: 'packed-native-boundary-matrix',
  nativeExecution: process.platform === 'win32' && process.arch === 'x64', platform: process.platform,
  architecture: process.arch, node: process.version, osRelease: release(), entrySha256: fileDigest(entry),
  sourceSha: process.env.CANDIDATE_SHA ?? null, oracleSha256: fileDigest(sdk),
  oracleSourceSha256: fileDigest(fileURLToPath(new URL('windows-oracle.c', import.meta.url))),
  inheritanceSourceSha256: fileDigest(fileURLToPath(new URL('boundary-inheritance.c', import.meta.url))),
  observation: 'opaque-owner-methods-and-current-process-sdk-snapshot',
  sourceFiles: Object.fromEntries(['boundary-worker.mjs', 'boundary-live-worker.mjs', 'boundary-support.mjs', 'owner-observer.mjs']
    .map(name => [name, fileDigest(fileURLToPath(new URL(name, import.meta.url)))])),
  results: nativeFaultMapping.map(row => ({ ...row })) }
let temporary
let env
let storage
let native
let tokenUser
let unsettledDescendant = false
const children = new Set()
let counter = 0

async function check(name, operation) {
  try {
    const detail = await operation()
    report.results.push({ name, status: 'passed', detail })
  } catch (error) {
    report.results.push({ name, status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message })
  }
}
const inspect = path => oracle(sdk, env, 'inspect', path)
const hashAt = path => digest(readFileSync(path))

function makeCase(name) {
  const rootPath = join(temporary, `case-${++counter}-${name}`)
  oracle(sdk, env, 'create', rootPath, 'directory', 'private')
  const root = storage.openPrivateDirectory(rootPath, { create: false })
  try {
    const receipt = storage.createPrivateFileExclusive(root, 'record.bin', oldBytes)
    assert.equal(receipt.publication, 'published')
    assert.equal(receipt.durability, 'synced')
  } finally { root.close() }
  return { rootPath, path: join(rootPath, 'record.bin'), before: inspect(join(rootPath, 'record.bin')) }
}

function start(rootPath, scenario) {
  const child = startChild(process.execPath, [workerPath, entry, rootPath, scenario, 'record.bin', dirname(sdk)], env)
  children.add(child)
  return child
}

async function finish(child) {
  const result = await child.next()
  assert.equal(result.event, 'result')
  if (result.outcome.unsettledSdkChild) unsettledDescendant = true
  assert.equal(result.outcome.unsettledSdkChild, undefined)
  assert.equal(result.outcome.sdkStopFailure, undefined)
  assert.equal(result.outcome.sdkControlCloseFailure, undefined)
  assert.equal(result.realNativeCalls, true)
  assert.equal(result.observation, 'opaque-owner-method')
  assert.deepEqual(result.nativeOwnerBinding, report.nativeOwnerBinding)
  assert.equal(result.remainingCapabilities, 0)
  for (const field of ['openFiles', 'openTokens', 'localAllocBlocks', 'pendingContexts', 'unconfirmedReleases']) assert.equal(result.statistics[field], 0)
  for (const field of ['heapBlocks', 'owners', 'fileRecords']) assert.ok(Number.isSafeInteger(result.statistics[field]) && result.statistics[field] >= 0)
  assert.equal(result.statistics.heapBlocks - result.statistics.owners - result.statistics.fileRecords, 0,
    'Closed capability metadata is distinct from transient native allocations')
  assert.deepEqual(result.failedCloses, [])
  assert.equal(result.outcome.closeFailure, undefined)
  assert.equal(result.outcome.leaseCloseFailure, undefined)
  await child.complete()
  return result
}

function kernelCalls() {
  const k = createRequire(entry)('koffi')
  assert.equal(k.version, '3.1.1')
  const kernel = k.load('kernel32.dll')
  const security = k.load('advapi32.dll')
  const call = (name, result, parameters) => kernel.func('__stdcall', name, result, parameters)
  return {
    open: call('CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    close: call('CloseHandle', 'int', ['void *']),
    error: call('GetLastError', 'uint32', []),
    seek: call('SetFilePointerEx', 'int', ['void *', 'int64', 'void *', 'uint32']),
    write: call('WriteFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *']),
    truncate: call('SetEndOfFile', 'int', ['void *']),
    move: call('MoveFileExW', 'int', ['str16', 'str16', 'uint32']),
    information: call('GetFileInformationByHandleEx', 'int', ['void *', 'int', 'void *', 'uint32']),
    setTime: call('SetFileTime', 'int', ['void *', 'void *', 'void *', 'void *']),
    setAttributes: call('SetFileAttributesW', 'int', ['str16', 'uint32']),
    descriptor: security.func('__stdcall', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void *', 'void *']),
    dacl: security.func('__stdcall', 'GetSecurityDescriptorDacl', 'int', ['void *', 'void *', 'void *', 'void *']),
    setSecurity: security.func('__stdcall', 'SetSecurityInfo', 'uint32', ['void *', 'uint32', 'uint32', 'void *', 'void *', 'void *', 'void *']),
    localFree: call('LocalFree', 'void *', ['void *']),
  }
}

// Owned synthetic file only. A second ACE grants the same already-full-access
// TokenUser no extra effective access, but deliberately violates exact policy.
function setOwnedOwnerOnlyDacl(path, duplicate, ownerSidText) {
  const handle = native.open(path, 0x60000, 7, null, 3, 0x80, null)
  assert.ok(handle !== null && handle !== 0n && handle !== 0xffffffffffffffffn)
  const descriptor = Buffer.alloc(8)
  try {
    const sddl = ownerOnlyDaclSddl(ownerSidText, duplicate)
    assert.notEqual(native.descriptor(sddl, 1, descriptor, null), 0, `SDDL conversion failed: ${native.error()}`)
    const pointer = descriptor.readBigUInt64LE()
    assert.notEqual(pointer, 0n)
    const present = Buffer.alloc(4), dacl = Buffer.alloc(8), inherited = Buffer.alloc(4)
    assert.notEqual(native.dacl(pointer, present, dacl, inherited), 0)
    assert.equal(present.readUInt32LE(), 1)
    assert.notEqual(dacl.readBigUInt64LE(), 0n)
    assert.equal(native.setSecurity(handle, 1, 0x80000004, null, null, dacl.readBigUInt64LE(), null), 0)
  } finally {
    try {
      if (descriptor.readBigUInt64LE() !== 0n) assert.ok([null, 0n].includes(native.localFree(descriptor.readBigUInt64LE())))
    } finally { assert.notEqual(native.close(handle), 0) }
  }
}

function openWriter(path) {
  const handle = native.open(path, 0x40000000, 7, null, 3, 0x80, null)
  if (handle === 0xffffffffffffffffn || handle === null || handle === 0n) return { ok: false, error: native.error() }
  return { ok: true, handle }
}

function mutate(path, operation) {
  const result = openWriter(path)
  if (!result.ok) return result
  try {
    assert.notEqual(native.seek(result.handle, 0n, null, operation === 'grow' ? 2 : 0), 0)
    if (operation === 'truncate') assert.notEqual(native.truncate(result.handle), 0)
    else {
      const count = Buffer.alloc(4)
      assert.notEqual(native.write(result.handle, Buffer.from('MUT!'), 4, count, null), 0)
      assert.equal(count.readUInt32LE(), 4)
    }
    return { ok: true }
  } finally { assert.notEqual(native.close(result.handle), 0) }
}

function privateFileFacts(path, expectedIdentity) {
  const facts = inspect(path)
  assert.equal(facts.ownerSid, tokenUser)
  assert.equal(facts.daclPresent, true)
  assert.equal(facts.daclNull, false)
  assert.equal(facts.daclProtected, true)
  assert.equal(facts.directory, false)
  assert.equal(facts.links, 1)
  assert.equal(facts.reparseTag, 0)
  assert.deepEqual(facts.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })), [
    { type: 0, flags: 0, mask: 0x001f01ff, sid: tokenUser },
  ])
  if (expectedIdentity) assert.deepEqual(facts.identity, expectedIdentity)
  return facts
}

try {
  if (!report.nativeExecution) throw new Blocked('Requires actual Windows x64, never a mocked platform or Wine substitute')
  assert.match(report.sourceSha ?? '', /^[0-9a-f]{40}$/, 'Verified runner must supply CANDIDATE_SHA')
  report.temporaryRoot = createFixtureRoot('dsh-storage-boundaries-')
  temporary = report.temporaryRoot.path
  const home = join(temporary, 'home')
  mkdirSync(home)
  env = fixtureEnvironment(home, temporary)
  tokenUser = oracle(sdk, env, 'token').userSid
  report.nativeOwnerBinding = ownerBinding(entry)
  storage = await import(pathToFileURL(entry).href)
  assert.equal(storage.capabilities().available, true)
  native = kernelCalls()

  for (const phase of ['read-held', 'read-after-chunk']) {
    await check(`retained-read-rejects-growth-truncation-and-same-size-write-${phase}`, async () => {
      const f = makeCase(phase)
      const child = start(f.rootPath, phase)
      try {
        const barrier = await child.next()
        assert.equal(barrier.phase, phase)
        if (phase === 'read-after-chunk') assert.equal(barrier.readCalls, 1)
        const attempts = ['grow', 'truncate', 'same-size'].map(operation => ({ operation, ...mutate(f.path, operation) }))
        for (const attempt of attempts) assert.deepEqual(attempt, { operation: attempt.operation, ok: false, error: 32 })
        assert.equal(hashAt(f.path), digest(oldBytes))
        child.resume()
        const result = await finish(child)
        assert.deepEqual(result.outcome, { ok: true, byteLength: oldBytes.length, sha256: digest(oldBytes) })
        privateFileFacts(f.path, f.before.identity)
        return { actualWin32SharingDenials: attempts, boundedReadCalls: result.readCalls }
      } finally { await child.kill(); children.delete(child) }
    })
  }

  await check('existing-writer-prevents-private-read-admission', async () => {
    const f = makeCase('existing-writer')
    const writer = openWriter(f.path)
    assert.equal(writer.ok, true)
    let child
    try {
      child = start(f.rootPath, 'read-once')
      const result = await finish(child)
      assert.equal(result.outcome.ok, false)
      assert.equal(result.outcome.code, 'sharing')
      assert.equal(result.readCalls, 0)
      assert.equal(hashAt(f.path), digest(oldBytes))
      return { existingNativeWriter: true, rejectedBeforeRead: true }
    } finally {
      assert.notEqual(native.close(writer.handle), 0)
      if (child) { await child.kill(); children.delete(child) }
    }
  })

  await check('post-read-metadata-drift-rejects-without-returning-partial-bytes', async () => {
    const f = makeCase('metadata-drift')
    const child = start(f.rootPath, 'read-after-chunk')
    let attributes
    try {
      assert.equal((await child.next()).phase, 'read-after-chunk')
      // Win32 sharing excludes data writes, not FILE_WRITE_ATTRIBUTES. This
      // actual metadata update exercises the post-read check independently.
      attributes = native.open(f.path, 0x180, 7, null, 3, 0x80, null)
      assert.ok(attributes !== null && attributes !== 0n && attributes !== 0xffffffffffffffffn)
      const before = Buffer.alloc(40)
      assert.notEqual(native.information(attributes, 0, before, before.length), 0)
      const lastWrite = Buffer.alloc(8)
      lastWrite.writeBigInt64LE(before.readBigInt64LE(16) + 10_000_000n)
      assert.notEqual(native.setTime(attributes, null, null, lastWrite), 0)
      const after = Buffer.alloc(40)
      assert.notEqual(native.information(attributes, 0, after, after.length), 0)
      assert.notEqual(after.readBigInt64LE(16), before.readBigInt64LE(16))
      assert.notEqual(native.close(attributes), 0)
      attributes = undefined
      child.resume()
      const result = await finish(child)
      assert.equal(result.outcome.ok, false)
      assert.equal(result.outcome.code, 'changed')
      assert.equal(result.outcome.sha256, undefined)
      assert.equal(result.outcome.byteLength, undefined)
      assert.equal(hashAt(f.path), digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      return { realMetadataMutation: true, dataBytesUnchanged: true, rejectedAfterRead: true }
    } finally {
      if (attributes !== undefined && attributes !== null && attributes !== 0n && attributes !== 0xffffffffffffffffn) native.close(attributes)
      await child.kill(); children.delete(child)
    }
  })

  for (const phase of ['read-held', 'read-after-chunk']) {
    await check(`leaf-substitution-preserves-opened-identity-${phase}`, async () => {
      const f = makeCase(`leaf-substitution-${phase}`)
      const child = start(f.rootPath, phase)
      const displaced = join(f.rootPath, 'retained-original.bin')
      try {
        assert.equal((await child.next()).phase, phase)
        renameSync(f.path, displaced)
        const parent = storage.openPrivateDirectory(f.rootPath, { create: false })
        try {
          const receipt = storage.createPrivateFileExclusive(parent, 'record.bin', newBytes)
          assert.equal(receipt.publication, 'published')
          assert.equal(receipt.durability, 'synced')
        } finally { parent.close() }
        const replacement = privateFileFacts(f.path)
        assert.notDeepEqual(replacement.identity, f.before.identity)
        privateFileFacts(displaced, f.before.identity)
        child.resume()
        const result = await finish(child)
        // A once-opened read may return its complete retained snapshot, or
        // reject an observed rename timestamp change. Never return lookalike data.
        if (result.outcome.ok) {
          assert.equal(result.outcome.sha256, digest(oldBytes))
          assert.equal(result.outcome.byteLength, oldBytes.length)
        } else {
          assert.equal(result.outcome.code, 'changed')
          assert.equal(result.outcome.sha256, undefined)
          assert.equal(result.outcome.byteLength, undefined)
        }
        assert.equal(hashAt(displaced), digest(oldBytes))
        assert.equal(hashAt(f.path), digest(newBytes))
        privateFileFacts(f.path, replacement.identity)
        return { realLeafRenameAndReplacement: true, originalIdentityRetained: true,
          replacementNeverRead: true, outcome: result.outcome.ok ? 'complete-original-snapshot' : 'rejected-observed-change' }
      } finally { await child.kill(); children.delete(child) }
    })
  }

  await check('post-read-canonical-acl-drift-rejected-without-returning-bytes', async () => {
    const f = makeCase('acl-drift')
    const child = start(f.rootPath, 'read-after-chunk')
    let changed = false
    try {
      assert.equal((await child.next()).phase, 'read-after-chunk')
      // No additional principal or effective permission is granted by this
      // fixture: both ACEs name the same already-full-access owner.
      assert.equal(f.before.ownerSid, tokenUser)
      changed = true
      setOwnedOwnerOnlyDacl(f.path, true, f.before.ownerSidText)
      const drifted = inspect(f.path)
      assert.equal(drifted.daclProtected, true)
      assert.equal(drifted.aces.length, 2)
      for (const ace of drifted.aces) assert.equal(ace.sid, tokenUser)
      assert.deepEqual(drifted.identity, f.before.identity)
      child.resume()
      const result = await finish(child)
      assert.equal(result.outcome.ok, false)
      assert.equal(result.outcome.code, 'privacy')
      assert.equal(result.outcome.sha256, undefined)
      assert.equal(result.outcome.byteLength, undefined)
      assert.equal(hashAt(f.path), digest(oldBytes))
      return { actualDaclMutation: true, effectiveOwnerAccessUnchanged: true,
        originalIdentityRetained: true, postReadPrivacyRejection: true }
    } finally {
      await child.kill(); children.delete(child)
      if (changed) { setOwnedOwnerOnlyDacl(f.path, false, f.before.ownerSidText); privateFileFacts(f.path, f.before.identity) }
    }
  })

  await check('retained-intermediate-parent-prevents-substitution-and-relocation', async () => {
    const container = makeCase('intermediate-parent')
    const rootPath = join(container.rootPath, 'nested-private')
    const root = storage.openPrivateDirectory(rootPath, { create: true })
    try { assert.equal(storage.createPrivateFileExclusive(root, 'record.bin', oldBytes).durability, 'synced') }
    finally { root.close() }
    const parentIdentity = inspect(container.rootPath).identity
    const leafIdentity = inspect(rootPath).identity
    const moved = `${container.rootPath}-relocated`
    assert.notEqual(native.move(container.rootPath, moved, 0), 0, 'Owned intermediate parent must be movable before the guard')
    assert.notEqual(native.move(moved, container.rootPath, 0), 0)
    const child = start(rootPath, 'ancestor-held')
    try {
      assert.equal((await child.next()).phase, 'ancestor-held')
      const deletion = native.open(container.rootPath, 0x10000, 7, null, 3, 0x02000000, null)
      if (deletion !== null && deletion !== 0n && deletion !== 0xffffffffffffffffn) {
        native.close(deletion)
        assert.fail('Retained intermediate parent unexpectedly allowed DELETE access')
      }
      assert.equal(native.error(), 32)
      assert.equal(native.move(container.rootPath, moved, 0), 0)
      const error = native.error()
      assert.ok([5, 32].includes(error), `Unexpected retained-parent rename result ${error}`)
      assert.deepEqual(inspect(container.rootPath).identity, parentIdentity)
      assert.deepEqual(inspect(rootPath).identity, leafIdentity)
      assert.equal(readdirSync(temporary).includes(moved.slice(temporary.length + 1)), false)
      child.resume()
      const result = await finish(child)
      assert.equal(result.outcome.ok, true)
      assert.equal(result.outcome.sha256, digest(oldBytes))
      assert.notEqual(native.move(container.rootPath, moved, 0), 0, 'Owned parent must become movable again after guard release')
      assert.notEqual(native.move(moved, container.rootPath, 0), 0)
      return { observedIntermediateGuard: true, realParentRenameDenied: error,
        replacementNamespaceNeverCreated: true, originalChildIdentityRetained: true }
    } finally { await child.kill(); children.delete(child) }
  })

  await check('retained-root-cannot-be-renamed-during-operation', async () => {
    const f = makeCase('root-guard')
    const identity = inspect(f.rootPath).identity
    const child = start(f.rootPath, 'root-held')
    try {
      assert.equal((await child.next()).phase, 'root-held')
      const attempted = native.open(f.rootPath, 0x10000, 7, null, 3, 0x02000000, null)
      if (attempted !== 0xffffffffffffffffn && attempted !== null && attempted !== 0n) {
        native.close(attempted)
        assert.fail('Retained root unexpectedly allowed a DELETE handle')
      }
      assert.equal(native.error(), 32)
      assert.equal(native.move(f.rootPath, `${f.rootPath}-moved`, 0), 0)
      const renameError = native.error()
      assert.ok([5, 32].includes(renameError), `Unexpected directory-rename error ${renameError}`)
      assert.deepEqual(inspect(f.rootPath).identity, identity)
      child.resume()
      assert.equal((await finish(child)).outcome.ok, true)
      return { actualDeleteHandleSharingDenial: 32, renameError, originalRootIdentityRetained: true }
    } finally { await child.kill(); children.delete(child) }
  })

  await check('retained-source-publication-ignores-staging-path-lookalike', async () => {
    const f = makeCase('source-binding')
    const child = start(f.rootPath, 'before-rename')
    try {
      const barrier = await child.next()
      assert.equal(barrier.phase, 'before-rename')
      assert.equal(barrier.sourceMode, 'create')
      assert.match(barrier.sourceName, /^\.dsh-private-[0-9a-f]{40}$/)
      const staging = join(f.rootPath, barrier.sourceName)
      const original = privateFileFacts(staging)
      const displaced = join(f.rootPath, 'displaced-source.bin')
      const deletion = native.open(staging, 0x10000, 7, null, 3, 0x80, null)
      if (deletion !== null && deletion !== 0n && deletion !== 0xffffffffffffffffn) {
        native.close(deletion)
        assert.fail('A live staging object unexpectedly allowed an external DELETE handle')
      }
      assert.equal(native.error(), 32)
      const moved = native.move(staging, displaced, 0)
      const moveError = native.error()
      assert.equal(moved, 0)
      assert.equal(moveError, 32)
      assert.throws(() => writeFileSync(staging, 'synthetic staging lookalike', { flag: 'wx' }), { code: 'EEXIST' })
      const reader = native.open(staging, 0x80000000, 7, null, 3, 0x80, null)
      assert.ok(reader !== null && reader !== 0n && reader !== 0xffffffffffffffffn, 'Independent readonly inspection remains compatible')
      assert.notEqual(native.close(reader), 0)
      assert.equal(hashAt(staging), digest(newBytes))
      privateFileFacts(staging, original.identity)
      assert.equal(hashAt(f.path), digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      child.resume()
      const result = await finish(child)
      assert.equal(result.outcome.ok, true)
      assert.equal(result.sourceMode, 'create')
      assert.equal(result.flushes, 2)
      assert.equal(result.writtenBytes, newBytes.length)
      const renames = result.trace.filter(event => event.name === 'rename')
      assert.equal(renames.length, 1)
      assert.equal(renames[0].forwarded, true)
      assert.equal(renames[0].retainedSource, true)
      const publicationSteps = result.trace.filter(event => event.retainedSource && ['flush', 'rename'].includes(event.name))
      assert.deepEqual(publicationSteps.map(event => event.name), ['flush', 'rename', 'flush'])
      for (const step of publicationSteps) {
        assert.equal(step.forwarded, true)
        assert.equal(step.capability, renames[0].capability)
      }
      assert.equal(result.outcome.receipt.publication, 'published')
      assert.equal(result.outcome.receipt.durability, 'synced')
      assert.deepEqual(result.outcome.receipt.identity, original.identity)
      assert.equal(hashAt(f.path), digest(newBytes))
      privateFileFacts(f.path, original.identity)
      assert.deepEqual(readdirSync(f.rootPath), ['record.bin'])
      assert.notEqual(native.move(f.path, displaced, 0), 0, 'Published source must become movable after writer release')
      privateFileFacts(displaced, original.identity)
      assert.notEqual(native.move(displaced, f.path, 0), 0)
      assert.equal(hashAt(f.path), digest(newBytes))
      privateFileFacts(f.path, original.identity)
      return { stagingDeleteDenied: 32, stagingRenameDenied: moveError, lookalikeCreationDenied: true,
        independentReadAndSdkInspection: true, sourceHandleIdentityPublished: true,
        sameHandlePreAndPostFlush: true, observation: 'same-opaque-capability-and-independent-sdk-full-identity',
        requestedShareEvidence: 'source-pinned-native-owner-open-policy', postReleaseRenameControl: true }
    } finally { await child.kill(); children.delete(child) }
  })

  await check('prewrite-failure-cannot-delete-externally-published-staging', async () => {
    const f = makeCase('prewrite-cleanup-race')
    const child = start(f.rootPath, 'publish-prewrite-failure')
    try {
      const barrier = await child.next()
      assert.equal(barrier.phase, 'before-failing-write')
      assert.equal(barrier.sourceMode, 'create')
      assert.match(barrier.sourceName, /^\.dsh-private-[0-9a-f]{40}$/)
      const staging = join(f.rootPath, barrier.sourceName)
      const created = privateFileFacts(staging)
      assert.equal(hashAt(staging), digest(Buffer.alloc(0)))
      const moved = native.move(staging, f.path, 1)
      const moveError = native.error()
      assert.equal(moved, 0, 'External replacement must be denied while source staging is retained')
      assert.equal(moveError, 32)
      assert.equal(hashAt(f.path), digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      privateFileFacts(staging, created.identity)
      child.resume()
      const result = await finish(child)
      assert.equal(result.outcome.ok, false)
      assert.equal(result.outcome.code, 'native')
      assert.equal(result.outcome.win32Code, 29)
      assert.equal(result.faultInjected, true)
      assert.equal(result.faultOrigin, 'test-owned-coarse-owner-prewrite-rejection')
      assert.equal(result.writtenBytes, 0)
      assert.equal(result.flushes, 0)
      assert.equal(result.sourceMode, 'create')
      assert.equal(result.outcome.receipt.publication, 'not-published')
      assert.equal(result.outcome.receipt.phase, 'write')
      assert.equal(result.outcome.receipt.cleanup, 'delete-pending')
      assert.deepEqual(result.outcome.receipt.identity, created.identity)
      const writes = result.trace.filter(event => event.name === 'write')
      assert.equal(writes.length, 1)
      assert.equal(writes[0].forwarded, false)
      assert.equal(writes[0].injected, true)
      assert.equal(result.trace.some(event => event.name === 'rename'), false)
      assert.equal(hashAt(f.path), digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      assert.deepEqual(readdirSync(f.rootPath), ['record.bin'])
      return { externalStagingToFinalMoveDenied: moveError, labelledPrewriteFault: 29, faultOrigin: result.faultOrigin,
        originalFinalIdentityAndBytesPreserved: true, onlyOwnedUnpublishedStagingRemoved: true }
    } finally { await child.kill(); children.delete(child) }
  })

  await check('readonly-target-rejects-publication-without-changing-original', async () => {
    const f = makeCase('readonly-target')
    let child
    assert.notEqual(native.setAttributes(f.path, 1), 0)
    try {
      child = start(f.rootPath, 'publish-readonly')
      const result = await finish(child)
      assert.equal(result.outcome.ok, false)
      assert.equal(result.outcome.code, 'unsupported')
      assert.equal(result.outcome.receipt.publication, 'not-published')
      assert.equal(result.outcome.receipt.phase, 'validate')
      assert.equal(result.sourceName, null)
      assert.equal(hashAt(f.path), digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      assert.deepEqual(readdirSync(f.rootPath), ['record.bin'])
      return { actualReadonlyAttribute: true, rejectedBeforeStaging: true, originalIdentityAndBytesPreserved: true }
    } finally {
      if (child) { await child.kill(); children.delete(child) }
      assert.notEqual(native.setAttributes(f.path, 0x80), 0)
    }
  })

  await check('cooperating-publishers-serialize-through-fixed-native-lease', async () => {
    const f = makeCase('cooperating-publishers')
    const first = start(f.rootPath, 'cooperating-publisher')
    let blocked, successor
    try {
      assert.equal((await first.next()).phase, 'writer-lease-held')
      const originalLease = privateFileFacts(join(f.rootPath, 'writer.lock'))
      blocked = start(f.rootPath, 'cooperating-contender')
      const denied = await finish(blocked)
      assert.equal(denied.outcome.ok, false)
      assert.ok(['busy', 'sharing'].includes(denied.outcome.code))
      assert.equal(denied.sourceName, null)
      assert.equal(hashAt(f.path), digest(oldBytes))
      first.resume()
      const published = await finish(first)
      assert.equal(published.outcome.ok, true)
      assert.equal(published.outcome.receipt.publication, 'published')
      assert.equal(published.outcome.receipt.durability, 'synced')
      assert.deepEqual(published.outcome.leaseIdentity, originalLease.identity)
      assert.equal(hashAt(f.path), digest(newBytes))
      successor = start(f.rootPath, 'cooperating-contender')
      const resumed = await finish(successor)
      assert.equal(resumed.outcome.ok, true)
      assert.equal(resumed.outcome.receipt.publication, 'published')
      assert.equal(resumed.outcome.receipt.durability, 'synced')
      assert.deepEqual(resumed.outcome.leaseIdentity, originalLease.identity)
      assert.equal(hashAt(f.path), digest(Buffer.alloc(256 * 1024, 0x52)))
      privateFileFacts(join(f.rootPath, 'writer.lock'), originalLease.identity)
      assert.deepEqual(readdirSync(f.rootPath).sort(), ['record.bin', 'writer.lock'])
      return { overlappingNativeContenderDenied: true, subsequentWriterProven: true,
        fixedLeaseIdentityRetained: true, serializedWholeFilePublications: 2 }
    } finally {
      for (const child of [first, blocked, successor].filter(Boolean)) { await child.kill(); children.delete(child) }
    }
  })

  for (const phase of ['before-create', 'after-create', 'after-write', 'after-pre-flush', 'before-rename', 'after-rename', 'after-post-flush']) {
    await check(`process-death-${phase}`, async () => {
      const f = makeCase(phase)
      const child = start(f.rootPath, phase)
      try {
        const barrier = await child.next()
        assert.equal(barrier.phase, phase)
        await child.kill()
        const published = phase === 'after-rename' || phase === 'after-post-flush'
        assert.equal(hashAt(f.path), digest(published ? newBytes : oldBytes))
        const final = privateFileFacts(f.path, published ? undefined : f.before.identity)
        if (published) assert.notDeepEqual(final.identity, f.before.identity)
        const staging = readdirSync(f.rootPath).filter(name => name.startsWith('.dsh-private-'))
        assert.equal(staging.length, phase === 'before-create' || published ? 0 : 1)
        if (staging.length) {
          const path = join(f.rootPath, staging[0])
          privateFileFacts(path)
          assert.equal(readFileSync(path).length, phase === 'after-create' ? 0 : newBytes.length)
          if (phase !== 'after-create') assert.equal(hashAt(path), digest(newBytes))
        }
        // All retained guards must be gone after the actual process exit.
        assert.notEqual(native.move(f.rootPath, `${f.rootPath}-recovered`, 0), 0)
        assert.notEqual(native.move(`${f.rootPath}-recovered`, f.rootPath, 0), 0)
        return { actualOwnedProcessTerminated: true, namespace: published ? 'new' : 'old',
          retainedPrivateStagingFiles: staging.length, powerLossTest: false, crashReceiptClaimed: false }
      } finally { await child.kill(); children.delete(child) }
    })
  }

  await check('stale-capabilities-cannot-close-reused-real-kernel-handles', async () => {
    const f = makeCase('stale-handle')
    const child = start(f.rootPath, 'lifetime')
    try {
      const result = await finish(child)
      assert.equal(result.outcome.ok, true)
      assert.equal(result.outcome.realKernelHandleValueReused, true)
      assert.equal(result.outcome.sdkCurrentProcessSnapshot, true)
      assert.equal(result.outcome.sdkDllSha256, fileDigest(join(dirname(sdk), 'boundary-inheritance.dll')))
      assert.equal(result.outcome.staleCapabilityNativeCalls, 0)
      assert.equal(result.outcome.structuredCloneRejected, true)
      assert.equal(result.outcome.sha256, digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      return result.outcome
    } finally { await child.kill(); children.delete(child) }
  })

  await check('cloned-identity-cannot-cross-a-real-worker-capability-domain', async () => {
    const f = makeCase('worker-domain')
    const child = start(f.rootPath, 'capability-domain')
    try {
      const result = await finish(child)
      assert.equal(result.outcome.ok, true)
      assert.equal(result.outcome.realWorkerRealm, true)
      assert.equal(result.outcome.clonedIdentityRejected, true)
      assert.equal(result.outcome.sha256, digest(oldBytes))
      privateFileFacts(f.path, f.before.identity)
      return result.outcome
    } finally { await child.kill(); children.delete(child) }
  })

  await check('sdk-child-does-not-inherit-private-handles-with-positive-control', async () => {
    const f = makeCase('child-inheritance')
    const child = start(f.rootPath, 'inheritance')
    let settled = false
    try {
      const result = await finish(child)
      settled = true
      assert.equal(result.outcome.ok, true)
      assert.equal(result.outcome.actualCreateProcessInheritHandles, true)
      assert.equal(result.outcome.sdkCurrentProcessSnapshot, true)
      assert.equal(result.outcome.liveLeaseAndAllAncestorGuardsObserved, true)
      assert.equal(result.outcome.denied.matchingInheritedIdentities, 0)
      assert.equal(result.outcome.positive.matchingInheritedIdentities, 1)
      assert.equal(result.outcome.sha256, digest(oldBytes))
      assert.equal(result.outcome.sdkDllSha256, fileDigest(join(dirname(sdk), 'boundary-inheritance.dll')))
      assert.equal(result.outcome.sdkChildSha256, fileDigest(join(dirname(sdk), 'boundary-inheritance-child.exe')))
      privateFileFacts(f.path, f.before.identity)
      return result.outcome
    } finally {
      if (!settled) unsettledDescendant = true
      await child.kill(); children.delete(child)
    }
  })

  for (const scenario of ['live-worker-close', 'live-worker-terminate']) {
    await check(`native-capability-lifetime-${scenario}`, async () => {
      const f = makeCase(scenario)
      const child = start(f.rootPath, scenario)
      try {
        const result = await finish(child)
        assert.equal(result.outcome.ok, true)
        assert.equal(result.outcome.actualWorkerTerminated, scenario === 'live-worker-terminate')
        assert.equal(result.outcome.explicitCloseControl, scenario === 'live-worker-close')
        assert.equal(result.outcome.leaseIdentityPreserved, true)
        assert.equal(result.outcome.rootRelocatedAfterExit, true)
        assert.equal(result.outcome.sdkCurrentProcessSnapshot, true)
        assert.equal(result.outcome.sdkDllSha256, fileDigest(join(dirname(sdk), 'boundary-inheritance.dll')))
        assert.ok(Number.isSafeInteger(result.outcome.observedWorkerHandlesReleased) && result.outcome.observedWorkerHandlesReleased > 1)
        assert.equal(result.outcome.sha256, digest(oldBytes))
        privateFileFacts(f.path, f.before.identity)
        return result.outcome
      } finally { await child.kill(); children.delete(child) }
    })
  }

  report.results.push(
    { name: 'remaining-directory-query-and-cleanup-fault-boundaries', status: 'blocked', reason: 'Directory enumeration and cleanup-return native fault cases remain outside the current read/publication matrix' },
  )
} catch (error) {
  report.results.push({ name: 'prerequisites', status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message })
} finally {
  let unsettled = unsettledDescendant
  for (const child of children) {
    try { await child.kill() } catch (error) { report.results.push({ name: 'child-cleanup', status: 'failed', reason: error.message }) }
    if (!child.settled) unsettled = true
  }
  if (temporary && unsettled) {
    report.results.push({ name: 'fixture-cleanup', status: 'failed', reason: 'Recursive cleanup withheld while an owned child remains unsettled', retainedSyntheticRoot: temporary })
  } else if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { report.results.push({ name: 'fixture-cleanup', status: 'failed', reason: error.message }) }
  }
  report.summary = summary(report.results)
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ acceptance: report.acceptance, summary: report.summary, output }))
  process.exitCode = report.summary.failed ? 1 : report.summary.blocked ? 2 : 0
}
