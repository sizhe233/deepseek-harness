/** Transient same-process thread-token fixtures; all public calls remain synchronous while impersonating. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entry, rootPath, scenario] = process.argv.slice(2)
assert.equal(process.platform, 'win32', 'Token fixture requires native Windows')
assert.equal(process.arch, 'x64')
assert.ok(['same-user', 'anonymous', 'restricted'].includes(scenario))
const k = createRequire(entry)('koffi')
assert.equal(k.version, '3.1.1')
const originalLoad = k.load
const kernel = originalLoad('kernel32.dll')
const security = originalLoad('advapi32.dll')
const bind = (library, name, result, args) => library.func('__stdcall', name, result, args)
const currentProcess = bind(kernel, 'GetCurrentProcess', 'void *', [])
const currentThread = bind(kernel, 'GetCurrentThread', 'void *', [])
const lastError = bind(kernel, 'GetLastError', 'uint32', [])
const closeHandle = bind(kernel, 'CloseHandle', 'int', ['void *'])
const exitProcess = bind(kernel, 'ExitProcess', 'void', ['uint32'])
const openProcessToken = bind(security, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *'])
const openThreadToken = bind(security, 'OpenThreadToken', 'int', ['void *', 'uint32', 'int', 'void *'])
const duplicateToken = bind(security, 'DuplicateTokenEx', 'int', ['void *', 'uint32', 'void *', 'int', 'int', 'void *'])
const restrictedToken = bind(security, 'CreateRestrictedToken', 'int', ['void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *', 'uint32', 'void *', 'void *'])
const setThreadToken = bind(security, 'SetThreadToken', 'int', ['void *', 'void *'])
const anonymousToken = bind(security, 'ImpersonateAnonymousToken', 'int', ['void *'])
const revert = bind(security, 'RevertToSelf', 'int', [])
const tokenInformation = bind(security, 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *'])
const isRestricted = bind(security, 'IsTokenRestricted', 'int', ['void *'])
const allocations = []
const handles = new Set()
let directory
let impersonating = false
let guardedCalls = false
let filesystemOpensUnderImpersonation = 0
let result

class FixtureUnavailable extends Error {
  constructor(operation, win32Code) { super(`${operation} unavailable (Win32 ${win32Code})`); this.operation = operation; this.win32Code = win32Code }
}
function success(value, operation) {
  if (value) return
  const code = lastError()
  if ([5, 50, 120, 1314, 1346].includes(code)) throw new FixtureUnavailable(operation, code)
  throw new Error(`${operation} failed (Win32 ${code})`)
}
function memory(size) {
  const pointer = k.alloc('uint8', size)
  allocations.push(pointer)
  const bytes = Buffer.from(k.view(pointer, size)); bytes.fill(0)
  return { pointer, bytes }
}
function ownHandle(slot) {
  const handle = slot.bytes.readBigUInt64LE()
  assert.ok(handle !== 0n && handle !== 0xffffffffffffffffn)
  handles.add(handle)
  return handle
}
function closeOwned(handle) { assert.notEqual(closeHandle(handle), 0, 'Fixture CloseHandle failed'); handles.delete(handle) }
function userSid(handle) {
  const needed = memory(4)
  assert.equal(tokenInformation(handle, 1, null, 0, needed.pointer), 0)
  assert.equal(lastError(), 122)
  const length = needed.bytes.readUInt32LE()
  assert.ok(length >= 16 && length <= 65536)
  const output = memory(length)
  success(tokenInformation(handle, 1, output.pointer, length, needed.pointer), 'GetTokenInformation TokenUser')
  const offset = output.bytes.readBigUInt64LE() - k.address(output.pointer)
  assert.ok(offset >= 16n && offset + 8n <= BigInt(length))
  const begin = Number(offset)
  const count = output.bytes[begin + 1]
  assert.equal(output.bytes[begin], 1)
  assert.ok(count <= 15 && begin + 8 + count * 4 <= length)
  return output.bytes.subarray(begin, begin + 8 + count * 4).toString('hex')
}

k.load = (...arguments_) => {
  const library = originalLoad(...arguments_)
  return new Proxy(library, { get(target, property, receiver) {
    if (property !== 'func') return Reflect.get(target, property, receiver)
    return (...signature) => {
      const call = target.func(...signature)
      return (...args) => {
        if (guardedCalls && signature[1] === 'NtCreateFile') filesystemOpensUnderImpersonation++
        return call(...args)
      }
    }
  } })
}

try {
  const storage = await import(pathToFileURL(entry).href)
  assert.equal(storage.capabilities().available, true)
  directory = storage.openPrivateDirectory(rootPath, { create: false })
  const slot = memory(8)
  assert.equal(openThreadToken(currentThread(), 8, 1, slot.pointer), 0)
  assert.equal(lastError(), 1008, 'Fixture must begin without a thread token')
  success(openProcessToken(currentProcess(), scenario === 'anonymous' ? 8 : 0x0a, slot.pointer), 'OpenProcessToken query/duplicate')
  const processToken = ownHandle(slot)
  const ownerSid = userSid(processToken)
  assert.equal(isRestricted(processToken), 0, 'Fixture requires an ordinary process token')
  let subject = null
  let subjectSid = ownerSid
  if (scenario !== 'anonymous') {
    success(duplicateToken(processToken, 0x0e, null, 2, 2, slot.pointer), 'DuplicateTokenEx own impersonation token')
    subject = ownHandle(slot)
    if (scenario === 'restricted') {
      const sid = memory(12)
      Buffer.from('010100000000000507000000', 'hex').copy(sid.bytes)
      const group = memory(16)
      group.bytes.writeBigUInt64LE(k.address(sid.pointer), 0)
      success(restrictedToken(subject, 1, 0, null, 0, null, 1, group.pointer, slot.pointer), 'CreateRestrictedToken')
      subject = ownHandle(slot)
      assert.equal(isRestricted(subject), 1)
      assert.equal(userSid(subject), ownerSid)
    }
  } else subjectSid = '010100000000000507000000'
  const name = `token-${scenario}-must-not-publish.bin`
  assert.equal(existsSync(join(rootPath, name)), false)
  const observations = []
  let threadQueryError = 0
  try {
    if (scenario === 'anonymous') success(anonymousToken(currentThread()), 'ImpersonateAnonymousToken')
    else success(setThreadToken(null, subject), 'SetThreadToken own token')
    impersonating = true
    if (openThreadToken(currentThread(), 8, 1, slot.pointer)) {
      const observed = ownHandle(slot)
      assert.equal(userSid(observed), subjectSid)
      if (scenario === 'restricted') assert.equal(isRestricted(observed), 1)
      closeOwned(observed)
    } else {
      threadQueryError = lastError()
      assert.ok(scenario === 'anonymous' && threadQueryError === 1347, 'Installed token must be independently identifiable or documented anonymous')
    }
    guardedCalls = true
    for (const [operation, call] of [
      ['open', () => { const opened = storage.openPrivateDirectory(rootPath, { create: false }); opened.close() }],
      ['inspect', () => storage.inspectPrivate(directory, 'record.bin')],
      ['read', () => storage.readPrivateFile(directory, 'record.bin', 65536)],
      ['publish', () => storage.createPrivateFileExclusive(directory, name, Buffer.from('synthetic must be rejected'))],
    ]) {
      try { call(); observations.push({ operation, rejected: false }) }
      catch (error) { observations.push({ operation, rejected: true, name: error.name, code: error.code, win32Code: error.win32Code }) }
    }
  } finally {
    guardedCalls = false
    if (impersonating) {
      if (!revert()) { writeSync(2, 'RevertToSelf failed; terminating token fixture\n'); exitProcess(86) }
      impersonating = false
    }
  }
  assert.equal(openThreadToken(currentThread(), 8, 1, slot.pointer), 0)
  assert.equal(lastError(), 1008)
  assert.equal(filesystemOpensUnderImpersonation, 0, 'Token admission must reject before any filesystem open')
  for (const observed of observations) {
    assert.equal(observed.rejected, true)
    assert.equal(observed.name, 'PrivateStorageError')
    assert.ok(observed.code === 'unsupported' || (scenario === 'anonymous' && observed.code === 'native' && observed.win32Code === threadQueryError && threadQueryError === 1347))
  }
  assert.equal(existsSync(join(rootPath, name)), false)
  assert.equal(storage.inspectPrivate(directory, 'record.bin').ownerSid, ownerSid, 'Normal calls must work after reversion')
  result = { complete: true, scenario, ownerSid, subjectSid, sameUser: scenario !== 'anonymous', restricted: scenario === 'restricted',
    threadQueryError, threadRestored: true, privilegesEnabled: false, filesystemOpensUnderImpersonation, observations }
} catch (error) {
  result = { complete: false, status: error instanceof FixtureUnavailable ? 'blocked' : 'failed', operation: error.operation ?? 'token fixture', reason: error.message, win32Code: error.win32Code ?? null }
} finally {
  if (impersonating && !revert()) { writeSync(2, 'RevertToSelf failed during cleanup\n'); exitProcess(86) }
  try { directory?.close() } catch (error) { result = { complete: false, status: 'failed', reason: error.message } }
  for (const handle of handles) {
    if (!closeHandle(handle)) result = { complete: false, status: 'failed', reason: `Fixture CloseHandle failed (${lastError()})` }
  }
  for (const pointer of allocations.reverse()) k.free(pointer)
  k.load = originalLoad
}
writeSync(1, `${JSON.stringify(result)}\n`)
process.exitCode = result.complete ? 0 : result.status === 'blocked' ? 3 : 1
