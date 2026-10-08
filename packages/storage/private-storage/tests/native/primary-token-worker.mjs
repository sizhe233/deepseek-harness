/** Actual packed-owner admission under an observed process token, without thread impersonation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { ownerBinding } from './owner-observer.mjs'

const [entry, rootPath, output, mode] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
assert.ok(['ordinary', 'restricted'].includes(mode))
const require = createRequire(entry), k = require('koffi'), binding = ownerBinding(entry)
const kernel = k.load('kernel32.dll'), security = k.load('advapi32.dll')
const bind = (library, name, result, args) => library.func('__stdcall', name, result, args)
const currentProcess = bind(kernel, 'GetCurrentProcess', 'void *', [])
const currentThread = bind(kernel, 'GetCurrentThread', 'void *', [])
const lastError = bind(kernel, 'GetLastError', 'uint32', [])
const close = bind(kernel, 'CloseHandle', 'int', ['void *'])
const openProcess = bind(security, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *'])
const openThread = bind(security, 'OpenThreadToken', 'int', ['void *', 'uint32', 'int', 'void *'])
const information = bind(security, 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *'])
const isRestricted = bind(security, 'IsTokenRestricted', 'int', ['void *'])
const allocations = [], handles = []
const memory = size => {
  const pointer = k.alloc('uint8', size); allocations.push(pointer)
  const bytes = Buffer.from(k.view(pointer, size)); bytes.fill(0)
  return { pointer, bytes }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
let result, directory
try {
  const slot = memory(8), length = memory(4)
  assert.equal(openThread(currentThread(), 8, 1, slot.pointer), 0)
  const threadTokenError = lastError(); assert.equal(threadTokenError, 1008)
  assert.notEqual(openProcess(currentProcess(), 8, slot.pointer), 0)
  const token = slot.bytes.readBigUInt64LE(); handles.push(token)
  const restricted = isRestricted(token) !== 0; assert.equal(restricted, mode === 'restricted')
  const type = memory(4)
  assert.notEqual(information(token, 8, type.pointer, 4, length.pointer), 0)
  assert.equal(type.bytes.readUInt32LE(), 1)
  assert.equal(information(token, 1, null, 0, length.pointer), 0); assert.equal(lastError(), 122)
  const size = length.bytes.readUInt32LE(); assert.ok(size >= 16 && size <= 65536)
  const user = memory(size)
  assert.notEqual(information(token, 1, user.pointer, size, length.pointer), 0)
  const offset = user.bytes.readBigUInt64LE() - k.address(user.pointer)
  assert.ok(offset >= 16n && offset + 8n <= BigInt(size))
  const start = Number(offset), count = user.bytes[start + 1]
  assert.equal(user.bytes[start], 1); assert.ok(count <= 15 && start + 8 + count * 4 <= size)
  const userSid = user.bytes.subarray(start, start + 8 + count * 4).toString('hex')
  // An ordinary OS read in both children separates native admission refusal from an inaccessible fixture.
  const rawReadSha256 = digest(readFileSync(join(rootPath, 'record.bin')))
  const owner = require(binding.binary).createOwner()
  const storage = await import(pathToFileURL(entry).href)
  const observations = []
  for (const [operation, call] of [
    ['native-token-user', () => owner.tokenUser()],
    ['public-open', () => { directory = storage.openPrivateDirectory(rootPath, { create: false }) }],
  ]) {
    try { call(); observations.push({ operation, rejected: false }) }
    catch (error) { observations.push({ operation, rejected: true, code: error.code, reason: error.message }) }
  }
  for (const observation of observations) {
    assert.equal(observation.rejected, restricted)
    if (restricted) assert.equal(observation.code, 'unsupported')
  }
  const publicReadSha256 = directory ? digest(storage.readPrivateFile(directory, 'record.bin', 65536)) : null
  if (!restricted) assert.equal(publicReadSha256, rawReadSha256)
  result = { complete: true, pid: process.pid, mode, tokenType: 1, userSid, restricted,
    threadTokenAbsent: true, threadTokenError, rawReadSha256, publicReadSha256, observations,
    nativeBinarySha256: binding.sha256, entrySha256: digest(readFileSync(entry)) }
} catch (error) {
  result = { complete: false, pid: process.pid, mode, reason: error.message, code: error.code ?? null }
} finally {
  try { directory?.close() } catch (error) { result = { complete: false, reason: error.message } }
  for (const handle of handles) if (!close(handle)) result = { complete: false, reason: 'Primary token query handle close failed' }
  for (const pointer of allocations.reverse()) k.free(pointer)
}
writeFileSync(output, `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 })
process.exitCode = result.complete ? 0 : 1
