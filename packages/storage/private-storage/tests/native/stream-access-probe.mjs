/** Independent process probing only one controller-owned synthetic file while its owner is live or released. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from './boundary-support.mjs'
import { chunkBytes, installedBinding, sourceBinding } from './stream-support.mjs'

const [entry, rootPath, name, mode] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
assert.ok(['retained', 'released'].includes(mode))
assert.match(name, /^(?:source\.bin|result\.bin|\.dsh-private-[0-9a-f]{40})$/u)
const binding = installedBinding(entry), fixture = sourceBinding(), k = createRequire(entry)('koffi')
const kernel = k.load('kernel32.dll')
const open = kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'])
const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
const error = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
const read = kernel.func('__stdcall', 'ReadFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *'])
const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32'])
const owned = new Set(), closeFailures = []
const path = join(rootPath, name), moved = join(rootPath, 'probe-moved.bin')
const valid = handle => handle !== null && handle !== 0n && handle !== 0xffffffffffffffffn
function release(handle) {
  assert.equal(owned.delete(handle), true)
  const actualReturn = close(handle)
  if (!actualReturn) closeFailures.push({ actualReturn, win32Error: error() })
}
const result = { event: 'access-result', mode, ...binding, fixtureSourceSha256: fixture.sha256,
  completed: false, restore: null }
try {
  const deleted = open(path, 0x10000, 7, null, 3, 0x00200080, null)
  result.deleteOpen = { desiredAccess: 0x10000, shareAccess: 7, opened: valid(deleted),
    actualReturn: valid(deleted) ? 'valid-owned-handle' : 'invalid-handle', win32Error: valid(deleted) ? null : error() }
  if (valid(deleted)) { owned.add(deleted); release(deleted) }
  const renameResult = move(path, moved, 0)
  result.rename = { actualReturn: renameResult, win32Error: renameResult ? null : error() }
  if (renameResult) {
    const actualReturn = move(moved, path, 0)
    result.restore = { actualReturn, win32Error: actualReturn ? null : error() }
    assert.notEqual(actualReturn, 0, 'Successful probe rename must be restored')
  }
  const reader = open(path, 0x120081, 7, null, 3, 0x00200080, null)
  result.read = { opened: valid(reader), desiredAccess: 0x120081, shareAccess: 7, win32Error: valid(reader) ? null : error() }
  assert.equal(valid(reader), true)
  owned.add(reader)
  const bytes = Buffer.alloc(chunkBytes), count = Buffer.alloc(4), actualReturn = read(reader, bytes, bytes.length, count, null)
  Object.assign(result.read, { actualReturn, bytes: count.readUInt32LE(), sha256: digest(bytes.subarray(0, count.readUInt32LE())),
    win32Error: actualReturn ? null : error() })
  release(reader)
  result.completed = true
} catch (failure) { result.failure = { name: failure.name, message: failure.message } }
finally { for (const handle of [...owned]) release(handle) }
writeSync(1, `${JSON.stringify({ ...result, remainingHandles: owned.size, closeFailures })}\n`)
